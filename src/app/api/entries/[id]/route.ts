import { NextRequest, NextResponse } from "next/server"
import { deleteOrphanTags, replaceEntryTags } from "@/lib/db/tags"
import { UpdateEntrySchema } from "@/lib/schemas/entry.schema"
import { readJsonBody, validationError } from "@/lib/schemas"
import { dbUnavailableResponse } from "@/lib/env"
import type { JournalEntryDetail } from "@/types/journal"
import { logError, logWarn } from "@/lib/logger"
import { pruneConflictCopies } from "@/lib/db/sync"
import { safeMediaPath } from "@/lib/media-security"
import { deleteMediaFile } from "@/lib/media-cleanup"


export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(
      `SELECT
         e.id,
         e.journal_id,
         j.name          AS journal_name,
         j.color         AS journal_color,
         e.text,
         e.created_at,
         e.updated_at,
         e.revision_id,
         e.starred,
         e.location_name,
         e.location_lat,
         e.location_lng,
         e.weather_description,
         e.weather_temp_celsius,
         e.weather_icon,
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'id',              m.id,
               'entryId',         m.entry_id,
               'type',            m.type,
               'filePath',        m.file_path,
               'thumbnailPath',   m.thumbnail_path,
               'order',           m.order_index,
               'durationSeconds', m.duration_seconds,
               'clientMediaId',   m.client_media_id
             ) ORDER BY m.order_index
           )
           FROM media m WHERE m.entry_id = e.id
         ), '[]'::json) AS media,
         COALESCE((
           SELECT json_agg(json_build_object('id', t.id, 'name', t.name))
           FROM tags t
           JOIN entry_tags et ON et.tag_id = t.id
           WHERE et.entry_id = e.id
         ), '[]'::json) AS tags
       FROM entries e
       JOIN journals j ON j.id = e.journal_id
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [id]
    )

    if (rows.length === 0) {
      return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
    }

    const row = rows[0]
    const detail: JournalEntryDetail = {
      id: row.id,
      journalId: row.journal_id,
      journalName: row.journal_name,
      journalColor: row.journal_color,
      text: row.text,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      revisionId: row.revision_id,
      starred: row.starred,
      // A location exists when it has a name OR coordinates — the GPS picker
      // stores coordinates without a name (no reverse geocoding by design).
      // Gating on the name alone hid those coordinates from every client, and
      // round-tripping the gated payload (edit, favourite toggle) then nulled
      // them in the DB.
      location:
        row.location_name || (row.location_lat != null && row.location_lng != null)
          ? {
              name: row.location_name || null,
              latitude: row.location_lat ?? undefined,
              longitude: row.location_lng ?? undefined,
            }
          : undefined,
      weather: row.weather_icon
        ? {
            description: row.weather_description,
            temperatureCelsius: row.weather_temp_celsius,
            icon: row.weather_icon,
          }
        : undefined,
      media: row.media ?? [],
      tags: row.tags ?? [],
    }

    return NextResponse.json(detail)
  } catch (error) {
    logWarn("[GET /api/entries/[id]] DB error:", error)
    return dbUnavailableResponse()
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = UpdateEntrySchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const body = parsed.data

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  const { db } = await import("@/lib/db")
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // When the client supplies its loaded revision, compare against the server to detect
    // concurrent sync writes.  On mismatch, save the server's current version as a conflict
    // copy before overwriting — mirrors the LWW conflict path in lib/db/sync.ts.
    if (body.clientRevisionId) {
      const { rows: existing } = await client.query<{
        revision_id: string
        updated_at: Date
        text: string
        created_at: Date
        starred: boolean
        location_name: string | null
        location_lat: number | null
        location_lng: number | null
        tags: string[]
      }>(
        `SELECT
           e.revision_id,
           e.updated_at,
           e.text,
           e.created_at,
           e.starred,
           e.location_name,
           e.location_lat,
           e.location_lng,
           COALESCE((
             SELECT array_agg(t.name ORDER BY t.name)
             FROM entry_tags et JOIN tags t ON t.id = et.tag_id
             WHERE et.entry_id = e.id
           ), '{}') AS tags
         FROM entries e WHERE e.id = $1
         FOR UPDATE OF e`,
        [id]
      )

      if (existing.length === 0) {
        await client.query("ROLLBACK").catch(() => {})
        return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
      }

      const current = existing[0]
      if (current.revision_id !== body.clientRevisionId) {
        // Server has a newer version than what the client loaded — save it before overwriting.
        await client.query(
          `INSERT INTO sync_conflict_copies
             (entry_id, revision_id, text, created_at, updated_at, starred,
              location_name, location_lat, location_lng, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            current.revision_id,
            current.text,
            current.created_at,
            current.updated_at,
            current.starred,
            current.location_name,
            current.location_lat,
            current.location_lng,
            current.tags,
          ]
        )
        // Retention — gleiche Kappung wie im Sync-Upsert-Pfad.
        await pruneConflictCopies(client, id)
      }
    }

    const updated = await client.query(
      `UPDATE entries SET
         journal_id = $2,
         text = $3,
         created_at = $4,
         updated_at = NOW(), revision_id = gen_random_uuid(),
         starred = $5,
         location_name = $6,
         location_lat = $7,
         location_lng = $8,
         weather_description = $9,
         weather_temp_celsius = $10,
         weather_icon = $11
       WHERE id = $1 AND deleted_at IS NULL`,
      [
        id,
        body.journalId,
        body.text ?? "",
        body.createdAt,
        body.starred ?? false,
        body.locationName ?? null,
        body.locationLat ?? null,
        body.locationLng ?? null,
        body.weatherDescription ?? null,
        body.weatherTempCelsius ?? null,
        body.weatherIcon ?? null,
      ]
    )

    // Zero rows = the id does not exist (or is tombstoned). Without this check
    // the handler answered 200 for a no-op UPDATE — a client PUTting an
    // offline-created UUID that was never pushed believed its save had
    // succeeded while nothing was written.
    if (updated.rowCount === 0) {
      await client.query("ROLLBACK").catch(() => {})
      return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
    }

    // Replace all tags atomically; was der Eintrag dabei verliert, wird nach
    // dem COMMIT auf Waisen geprüft (lib/db/tags.ts).
    const tagNames = (body.tags ?? []).map((t: string) => t.trim()).filter(Boolean)
    const removedTagIds = await replaceEntryTags(client, id, tagNames)

    // Persist photo order and link any photos uploaded before the entry was created.
    // Both linked (p.id present) and unlinked photos are ordered by their position in the
    // payload — this is the only place the client's drag-reorder intent is written to the DB.
    const photos = body.photos ?? []
    if (photos.length > 0) {
      const { rows: existingMedia } = await client.query(
        `SELECT file_path FROM media WHERE entry_id = $1`,
        [id]
      )
      const linkedPaths = new Set(existingMedia.map((r: { file_path: string }) => r.file_path))
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i]
        if (p.id) {
          // Update order_index for already-linked photos (fixes reorder not persisting)
          await client.query(
            `UPDATE media SET order_index = $1 WHERE id = $2 AND entry_id = $3`,
            [i, p.id, id]
          )
        } else if (!linkedPaths.has(p.filePath)) {
          // Insert photos uploaded before the entry existed (autosave race)
          await client.query(
            `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, p.type ?? "photo", p.filePath, p.thumbnailPath ?? null, i]
          )
          linkedPaths.add(p.filePath)
        }
      }
    }

    await client.query("COMMIT")
    await deleteOrphanTags(client, removedTagIds)
    return NextResponse.json({ ok: true })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    logError("[PUT /api/entries/[id]] Error:", error)
    return NextResponse.json({ error: "Eintrag konnte nicht aktualisiert werden", code: "entry_update_failed" }, { status: 500 })
  } finally {
    client.release()
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")

    // Collect media paths before deleting
    const { rows: mediaPaths } = await db.query(
      `SELECT file_path, thumbnail_path, preview_path FROM media WHERE entry_id = $1`,
      [id]
    )

    // Guard: validate all paths BEFORE any DB mutation — throws on traversal
    const cwd = process.cwd()
    for (const m of mediaPaths) {
      for (const p of [m.file_path, m.thumbnail_path, m.preview_path].filter(Boolean)) {
        safeMediaPath(cwd, p)
      }
    }

    // Soft-delete: stamp deleted_at as tombstone so the sync feed can signal
    // clients to remove the entry. Bump updated_at + revision_id so the
    // tombstone appears in getChangesSince for any client that last synced
    // before this deletion. All three writes share one transaction — a crash
    // between them previously left an invisible entry with orphaned
    // entry_tags/media rows (and files that would never be cleaned up).
    const client = await db.connect()
    try {
      await client.query("BEGIN")

      // AND deleted_at IS NULL: a repeated DELETE on an already-tombstoned
      // entry must not bump updated_at/revision_id again (spurious tombstone
      // events in every client's sync feed).
      // Der Tombstone braucht nur id/updated_at/deleted_at — Text, Ort
      // und Wetter werden geleert, sonst liegt gelöschter Journalinhalt für
      // immer in DB, FTS-Index, jedem pg_dump und jedem Sync-Backfill.
      const updated = await client.query(
        `UPDATE entries
           SET deleted_at = NOW(), updated_at = NOW(), revision_id = gen_random_uuid(),
               text = '', location_name = NULL, location_lat = NULL, location_lng = NULL,
               weather_description = NULL, weather_temp_celsius = NULL, weather_icon = NULL
         WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      )
      if (updated.rowCount === 0) {
        await client.query("ROLLBACK").catch(() => {})
        return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
      }

      // Remove associated rows — media CASCADE no longer fires since the entry
      // row is kept as a tombstone. Verlorene Tags werden nach dem COMMIT
      // auf Waisen geprüft (lib/db/tags.ts).
      const tombstoneTagIds = await replaceEntryTags(client, id, [])
      await client.query(`DELETE FROM media WHERE entry_id = $1`, [id])
      // Konfliktkopien halten den Volltext des gelöschten Eintrags —
      // der ON DELETE CASCADE feuert bei Soft-Deletes nie.
      await client.query(`DELETE FROM sync_conflict_copies WHERE entry_id = $1`, [id])

      await client.query("COMMIT")
      await deleteOrphanTags(client, tombstoneTagIds)
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }

    // Delete files after the commit, best-effort — the DB state is final at
    // this point, so a file-system error must not turn the response into a 500
    // (the client would believe the entry still exists).
    for (const m of mediaPaths) {
      for (const p of [m.file_path, m.thumbnail_path, m.preview_path].filter(Boolean)) {
        try {
          await deleteMediaFile(cwd, p)
        } catch (err) {
          logError("[DELETE /api/entries/[id]] media file cleanup failed (row already deleted):", err)
        }
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid media path") {
      logError("[DELETE /api/entries/[id]] security: path traversal rejected", error)
      return NextResponse.json({ error: "Ungültiger Medienpfad", code: "invalid_media_path" }, { status: 400 })
    }
    logError("[DELETE /api/entries/[id]] Error:", error)
    return NextResponse.json({ error: "Eintrag konnte nicht gelöscht werden", code: "entry_delete_failed" }, { status: 500 })
  }
}
