import { NextRequest, NextResponse } from "next/server"
import { unlink, rmdir } from "fs/promises"
import { dirname } from "path"
import { logError, logWarn } from "@/lib/logger"
import { safeMediaPath } from "@/lib/media-security"
import { deleteOrphanTags, orphanTagIds } from "@/lib/db/tags"
import { UpdateJournalSchema } from "@/lib/schemas/journal.schema"
import { readJsonBody, validationError } from "@/lib/schemas"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = UpdateJournalSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const { name, color } = parsed.data

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Kein Datenbankzugang.", code: "no_db_access" }, { status: 503 })
  }

  try {
    const { db } = await import("@/lib/db")
    const sets: string[] = []
    const values: unknown[] = []
    if (name !== undefined) { values.push(name); sets.push(`name = $${values.length}`) }
    if (color !== undefined) { values.push(color); sets.push(`color = $${values.length}`) }
    values.push(id)
    const { rows } = await db.query(
      `UPDATE journals SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING id, name, color`,
      values
    )
    if (rows.length === 0) {
      return NextResponse.json({ error: "Journal nicht gefunden", code: "journal_not_found" }, { status: 404 })
    }
    return NextResponse.json(rows[0])
  } catch (error) {
    logError("[PATCH /api/journals/[id]] Error:", error)
    return NextResponse.json({ error: "Journal konnte nicht gespeichert werden", code: "journal_update_failed" }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Kein Datenbankzugang.", code: "no_db_access" }, { status: 503 })
  }

  try {
    const { db } = await import("@/lib/db")

    // ── Guard: validate all stored paths BEFORE any DB mutation ──────
    // (inkl. preview_path — Loop-Clips fehlten hier bisher und blieben beim
    // Journal-Löschen als Waisen auf der Platte.) Throws on traversal → 400.
    const cwd = process.cwd()
    const { rows: precheckRows } = await db.query(
      `SELECT m.file_path, m.thumbnail_path, m.preview_path
       FROM media m
       JOIN entries e ON e.id = m.entry_id
       WHERE e.journal_id = $1`,
      [id]
    )
    for (const row of precheckRows) {
      for (const relPath of [row.file_path, row.thumbnail_path, row.preview_path]) {
        if (relPath) safeMediaPath(cwd, relPath)
      }
    }

    // ── Delete in one transaction; media via RETURNING ───────────────
    // RETURNING liefert exakt die tatsächlich gelöschten Zeilen — ein zwischen
    // Snapshot und Cascade hochgeladenes Foto kann so nicht mehr als Datei-Waise
    // zurückbleiben (vorher: SELECT-dann-CASCADE mit Zeitfenster).
    const client = await db.connect()
    let mediaRows: { file_path: string; thumbnail_path: string | null; preview_path: string | null }[]
    try {
      await client.query("BEGIN")
      const delMedia = await client.query(
        `DELETE FROM media m USING entries e
         WHERE m.entry_id = e.id AND e.journal_id = $1
         RETURNING m.file_path, m.thumbnail_path, m.preview_path`,
        [id]
      )
      mediaRows = delMedia.rows
      const { rowCount } = await client.query(
        `DELETE FROM journals WHERE id = $1`,
        [id]
      )
      if (!rowCount || rowCount === 0) {
        await client.query("ROLLBACK").catch(() => {})
        return NextResponse.json({ error: "Journal nicht gefunden", code: "journal_not_found" }, { status: 404 })
      }
      await client.query("COMMIT")
      // Der Cascade hat entry_tags gelöscht — Kandidaten erst jetzt, im
      // frischen Snapshot, bestimmen (auch parallel verknüpfte Tags).
      await deleteOrphanTags(client, await orphanTagIds(client).catch((err) => {
        logWarn("[DELETE /api/journals/[id]] Waisen-Kandidaten nach COMMIT nicht lesbar (Sweep holt nach):", err)
        return []
      }))
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }

    // Resolve returned paths; defensiv — DB ist bereits committed, ein invalider
    // Pfad darf das Aufräumen der übrigen Dateien nicht mehr abbrechen.
    const resolvedFiles: string[] = []
    for (const row of mediaRows) {
      for (const relPath of [row.file_path, row.thumbnail_path, row.preview_path]) {
        if (!relPath) continue
        try {
          resolvedFiles.push(safeMediaPath(cwd, relPath))
        } catch {
          logError("[DELETE /api/journals/[id]] skipping invalid stored path after commit:", relPath)
        }
      }
    }

    // ── Clean up media files from disk ────────────────────────────────
    // Best-effort nach dem Commit: die DB-Zeilen sind weg — ein I/O-Fehler
    // hier darf keinen 500 mehr auslösen (Client hielte das Journal für
    // weiterhin existent). ENOENT ist ohnehin benign.
    const dirsToRemove = new Set<string>()
    for (const absPath of resolvedFiles) {
      try {
        await unlink(absPath)
        dirsToRemove.add(dirname(absPath))
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logError(`[DELETE /api/journals/[id]] file cleanup failed (rows already deleted): ${absPath}`, err)
        }
      }
    }

    // Remove now-empty directories
    for (const dir of dirsToRemove) {
      try {
        await rmdir(dir)
      } catch {
        // Directory not empty or already removed — ignore
      }
    }

    return NextResponse.json({ deleted: true })
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid media path") {
      logError("[DELETE /api/journals/[id]] security: path traversal rejected", error)
      return NextResponse.json({ error: "Ungültiger Medienpfad", code: "invalid_media_path" }, { status: 400 })
    }
    logError("[DELETE /api/journals/[id]] Error:", error)
    return NextResponse.json({ error: "Löschen fehlgeschlagen", code: "journal_delete_failed" }, { status: 500 })
  }
}
