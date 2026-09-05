import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { logError } from "@/lib/logger"
import { safeMediaPath } from "@/lib/media-security"
import { deleteMediaFile } from "@/lib/media-cleanup"

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")

    const { rows } = await db.query(
      `SELECT file_path, thumbnail_path, preview_path FROM media WHERE id = $1`,
      [id]
    )

    if (rows.length === 0) {
      return NextResponse.json({ error: "Medium nicht gefunden", code: "media_not_found" }, { status: 404 })
    }

    const cwd = process.cwd()
    const paths = [rows[0].file_path, rows[0].thumbnail_path, rows[0].preview_path].filter(Boolean)

    // Guard: validate all paths BEFORE any DB mutation — throws on traversal
    for (const p of paths) {
      safeMediaPath(cwd, p)
    }

    // Media deletion must leave a sync signal. Bumping updated_at puts
    // the entry into getChangesSince, so other devices refresh their IDB copy
    // and their entry-media cache (stamped with updatedAt) misses instead of
    // rendering the deleted photo offline forever. revision_id stays untouched:
    // the entry CONTENT did not change, and a revision bump would fabricate
    // conflict copies on devices still holding the old revision.
    // Both writes share one transaction: previously a failed DELETE after the
    // bump synced a phantom "change" to every device.
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `UPDATE entries SET updated_at = NOW()
         WHERE id = (SELECT entry_id FROM media WHERE id = $1)`,
        [id]
      )
      const del = await client.query(`DELETE FROM media WHERE id = $1`, [id])
      if (del.rowCount === 0) {
        // Row raced away between the SELECT above and this transaction.
        await client.query("ROLLBACK").catch(() => {})
        return NextResponse.json({ error: "Medium nicht gefunden", code: "media_not_found" }, { status: 404 })
      }
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }

    // File cleanup after the commit, best-effort: the DB row is gone — a
    // file-system error must not produce a 500 (the client would retry against
    // a row that no longer exists and get a confusing 404).
    for (const p of paths) {
      try {
        await deleteMediaFile(cwd, p)
      } catch (err) {
        logError("[DELETE /api/media/[id]] file cleanup failed (row already deleted):", err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid media path") {
      logError("[DELETE /api/media/[id]] security: path traversal rejected", error)
      return NextResponse.json({ error: "Ungültiger Medienpfad", code: "invalid_media_path" }, { status: 400 })
    }
    logError("[DELETE /api/media/[id]] Error:", error)
    return NextResponse.json({ error: "Medium konnte nicht gelöscht werden", code: "media_delete_failed" }, { status: 500 })
  }
}
