/**
 * Database query layer for offline sync.
 */

import { readFile } from "fs/promises"
import { db } from "@/lib/db"
import type { PoolClient } from "pg"
import { deleteOrphanTags, replaceEntryTags } from "@/lib/db/tags"
import type { SyncEntry } from "@/lib/sync/types"
import { safeMediaPath } from "@/lib/media-security"

export interface ChangesPage {
  entries: SyncEntry[]
  nextCursor: string | null
  serverTime: string
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`).toString("base64url")
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8")
  const pipe = raw.lastIndexOf("|")
  return { updatedAt: raw.slice(0, pipe), id: raw.slice(pipe + 1) }
}

export async function getChangesSince(
  since: string,
  journalId: string | null,
  cursor: string | null,
  limit: number
): Promise<ChangesPage> {
  let updatedAtCursor = since
  let idCursor = "00000000-0000-0000-0000-000000000000"

  if (cursor) {
    const decoded = decodeCursor(cursor)
    updatedAtCursor = decoded.updatedAt
    idCursor = decoded.id
  }

  const { rows } = await db.query<{
    id: string
    journal_id: string
    text: string
    created_at: Date
    updated_at: Date
    revision_id: string
    starred: boolean
    location_name: string | null
    location_lat: number | null
    location_lng: number | null
    weather_description: string | null
    weather_temp_celsius: number | null
    weather_icon: string | null
    tags: string[]
    deleted_at: Date | null
    pinned_at: Date | null
    thumbnail_path: string | null
    updated_at_raw: string
  }>(
    `SELECT
       e.id,
       e.journal_id,
       e.text,
       e.created_at,
       e.updated_at,
       e.updated_at::text AS updated_at_raw,
       e.revision_id,
       e.starred,
       e.location_name,
       e.location_lat,
       e.location_lng,
       e.weather_description,
       e.weather_temp_celsius,
       e.weather_icon,
       e.deleted_at,
       e.pinned_at,
       COALESCE((
         SELECT array_agg(t.name ORDER BY t.name)
         FROM entry_tags et JOIN tags t ON t.id = et.tag_id
         WHERE et.entry_id = e.id
       ), '{}') AS tags,
       (SELECT thumbnail_path
        FROM media
        WHERE entry_id = e.id AND type = 'photo'
        ORDER BY order_index LIMIT 1) AS thumbnail_path
     FROM entries e
     WHERE e.updated_at > $1::timestamptz
       AND ($4::uuid IS NULL OR e.journal_id = $4::uuid)
       AND (e.updated_at, e.id) > ($2::timestamptz, $3::uuid)
     ORDER BY e.updated_at ASC, e.id ASC
     LIMIT $5`,
    [since, updatedAtCursor, idCursor, journalId, limit + 1]
  )

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  const cwd = process.cwd()
  const entries: SyncEntry[] = await Promise.all(page.map(async (r) => {
    let thumbnailDataUrl: string | null = null
    if (r.thumbnail_path) {
      try {
        const absPath = safeMediaPath(cwd, r.thumbnail_path)
        const ext = r.thumbnail_path.split(".").pop()?.toLowerCase() ?? "webp"
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "png" ? "image/png"
          : "image/webp"
        const data = await readFile(absPath)
        thumbnailDataUrl = `data:${mime};base64,${data.toString("base64")}`
      } catch {
        // Missing file is non-fatal; client gets null and falls back to no thumbnail
      }
    }
    return {
      id: r.id,
      journalId: r.journal_id,
      text: r.text,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      revisionId: r.revision_id,
      starred: r.starred,
      tags: r.tags ?? [],
      locationName: r.location_name,
      locationLat: r.location_lat,
      locationLng: r.location_lng,
      weatherDescription: r.weather_description,
      weatherTempCelsius: r.weather_temp_celsius,
      weatherIcon: r.weather_icon,
      deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
      // Pin-Sync: reist über den updated_at-Bump des Pin-Endpoints.
      pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
      thumbnailDataUrl,
    }
  }))

  // Der Cursor trägt updated_at als Postgres-Text mit voller µs-Präzision.
  // new Date(...).toISOString() kappt auf Millisekunden — bei einem Batch-Upsert
  // teilen sich bis zu 50 Zeilen exakt denselben µs-Timestamp (ein SELECT NOW()
  // pro Transaktion), der ms-gekappte Cursor fiel dann HINTER die letzte
  // gelieferte Zeile zurück und die nächste Seite war identisch mit der
  // vorherigen: Endlosschleife im Pull (engine.ts dreht while(true)).
  const lastRow = page[page.length - 1]
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor(lastRow.updated_at_raw, lastRow.id)
      : null

  // Watermark = now minus a safety margin: a concurrent upsert stamps
  // updated_at with its transaction-start NOW() and may commit AFTER this pull
  // answered — with a plain wall-clock watermark that row would fall
  // permanently into the gap (never delivered). Re-delivering a few seconds of
  // already-seen entries is idempotent on the client and cheap.
  const WATERMARK_MARGIN_MS = 10_000
  return { entries, nextCursor, serverTime: new Date(Date.now() - WATERMARK_MARGIN_MS).toISOString() }
}

export interface UpsertResult {
  accepted: string[]
  conflicts: {
    entryId: string
    serverVersion: SyncEntry
  }[]
}

// Max clock skew tolerated for LWW comparison.
// Client timestamps further than this into the future are clamped to serverNow + MAX_CLOCK_SKEW_MS
// so a fast-running device clock cannot silently win LWW battles it should lose.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export async function upsertEntries(entries: SyncEntry[]): Promise<UpsertResult> {
  const accepted: string[] = []
  const conflicts: { entryId: string; serverVersion: SyncEntry }[] = []
  // Tags, die Einträge in diesem Batch verloren haben — nach dem COMMIT einmal
  // auf Waisen geprüft (lib/db/tags.ts), nicht pro Eintrag in der Transaktion.
  const removedTagIds: string[] = []

  const client = await db.connect()
  try {
    await client.query("BEGIN")

    // Fetch server time once per transaction — used as the authoritative updated_at for accepted
    // entries (aligning the offline sync path with the online PUT path that also uses NOW()) and
    // as the ceiling for LWW skew clamping.
    const { rows: nowRows } = await client.query<{ server_now: Date }>(`SELECT NOW() AS server_now`)
    const serverNow = nowRows[0].server_now

    // FOR UPDATE: lock the row for the LWW compare-and-write. Without it two
    // concurrent upsert transactions (two devices syncing at once) both read
    // the same old state under READ COMMITTED, both "win" against it, and the
    // later commit silently overwrites the earlier one — a lost update that
    // never surfaces as a conflict.
    const selectEntrySql = `SELECT
           e.updated_at,
           e.revision_id,
           e.text,
           e.created_at,
           e.starred,
           e.journal_id,
           e.location_name,
           e.location_lat,
           e.location_lng,
           e.weather_description,
           e.weather_temp_celsius,
           e.weather_icon,
           e.deleted_at,
           COALESCE((
             SELECT array_agg(t.name ORDER BY t.name)
             FROM entry_tags et JOIN tags t ON t.id = et.tag_id
             WHERE et.entry_id = e.id
           ), '{}') AS tags
         FROM entries e WHERE e.id = $1
         FOR UPDATE OF e`

    for (const entry of entries) {
      let existing = (await client.query<ExistingEntryRow>(selectEntrySql, [entry.id])).rows

      if (existing.length === 0) {
        const inserted = await client.query(
          `INSERT INTO entries
             (id, journal_id, text, created_at, updated_at, revision_id, starred,
              location_name, location_lat, location_lng,
              weather_description, weather_temp_celsius, weather_icon)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO NOTHING`,
          [
            entry.id, entry.journalId, entry.text ?? "",
            entry.createdAt, serverNow, entry.revisionId,
            entry.starred ?? false,
            entry.locationName ?? null, entry.locationLat ?? null, entry.locationLng ?? null,
            entry.weatherDescription ?? null, entry.weatherTempCelsius ?? null, entry.weatherIcon ?? null,
          ]
        )
        // ?? 1: echtes pg setzt rowCount immer; nur ein explizites 0 ist der Race-Fall.
        if ((inserted.rowCount ?? 1) > 0) {
          removedTagIds.push(...(await replaceEntryTags(client, entry.id, entry.tags)))
          accepted.push(entry.id)
          continue
        }
        // Insert race: a concurrent transaction created the row between our
        // SELECT and INSERT (DO NOTHING was a no-op). Previously this path
        // still wrote the tags and reported "accepted" although the payload
        // was never stored. Re-read (now locked) and decide via normal LWW.
        existing = (await client.query<ExistingEntryRow>(selectEntrySql, [entry.id])).rows
        if (existing.length === 0) {
          // Row vanished again (deleted in between) — treat like the tombstone
          // case: report accepted so the client dequeues; the pull delivers reality.
          accepted.push(entry.id)
          continue
        }
      }

      // Tombstone wins — a soft-deleted entry must not be resurrected by an
      // offline edit that arrived after the deletion. Report it as accepted:
      // the client must dequeue the edit (it would otherwise retry forever,
      // since it lands neither in accepted nor in conflicts), and the pull
      // that follows delivers the tombstone and removes the local entry.
      if (existing[0].deleted_at != null) {
        accepted.push(entry.id)
        continue
      }

      const server = existing[0]
      const serverUpdatedAt = new Date(server.updated_at)
      // Clamp client-supplied timestamp to serverNow + MAX_CLOCK_SKEW_MS so a device with a
      // fast-running clock cannot win LWW battles it should lose.
      const rawClientUpdatedAt = new Date(entry.updatedAt)
      const skewCeiling = new Date(serverNow.getTime() + MAX_CLOCK_SKEW_MS)
      const effectiveClientUpdatedAt = rawClientUpdatedAt <= skewCeiling ? rawClientUpdatedAt : skewCeiling

      if (effectiveClientUpdatedAt >= serverUpdatedAt) {
        // On an exact tie: the client's timestamp matches the server's, which happens
        // when a response is lost and the client retries with the same updatedAt. Saving a conflict
        // copy would pollute sync_conflict_copies with a spurious row. Only save on strict win.
        if (effectiveClientUpdatedAt > serverUpdatedAt) {
          await _saveConflictCopy(client, entry.id, server)
        }

        const newRevisionId = crypto.randomUUID()
        await client.query(
          `UPDATE entries SET
             journal_id = $2, text = $3, created_at = $4, updated_at = $5,
             revision_id = $6, starred = $7,
             location_name = $8, location_lat = $9, location_lng = $10,
             weather_description = $11, weather_temp_celsius = $12, weather_icon = $13
           WHERE id = $1`,
          [
            entry.id, entry.journalId, entry.text ?? "",
            entry.createdAt, serverNow, newRevisionId,
            entry.starred ?? false,
            entry.locationName ?? null, entry.locationLat ?? null, entry.locationLng ?? null,
            entry.weatherDescription ?? null, entry.weatherTempCelsius ?? null, entry.weatherIcon ?? null,
          ]
        )
        removedTagIds.push(...(await replaceEntryTags(client, entry.id, entry.tags)))
        accepted.push(entry.id)
      } else {
        await _saveConflictCopy(client, entry.id, {
          updated_at: new Date(entry.updatedAt),
          revision_id: entry.revisionId,
          text: entry.text,
          created_at: new Date(entry.createdAt),
          starred: entry.starred,
          journal_id: entry.journalId,
          location_name: entry.locationName ?? null,
          location_lat: entry.locationLat ?? null,
          location_lng: entry.locationLng ?? null,
          weather_description: entry.weatherDescription ?? null,
          weather_temp_celsius: entry.weatherTempCelsius ?? null,
          weather_icon: entry.weatherIcon ?? null,
          tags: entry.tags,
        })

        conflicts.push({
          entryId: entry.id,
          serverVersion: {
            id: entry.id,
            journalId: server.journal_id,
            text: server.text,
            createdAt: new Date(server.created_at).toISOString(),
            updatedAt: new Date(server.updated_at).toISOString(),
            revisionId: server.revision_id,
            starred: server.starred,
            tags: server.tags ?? [],
            locationName: server.location_name,
            locationLat: server.location_lat,
            locationLng: server.location_lng,
            weatherDescription: server.weather_description,
            weatherTempCelsius: server.weather_temp_celsius,
            weatherIcon: server.weather_icon,
            deletedAt: server.deleted_at ? new Date(server.deleted_at).toISOString() : null,
            thumbnailDataUrl: null,
          },
        })
      }
    }

    await client.query("COMMIT")
    await deleteOrphanTags(client, removedTagIds)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }

  return { accepted, conflicts }
}

interface ExistingEntryRow {
  updated_at: Date
  revision_id: string
  text: string
  created_at: Date
  starred: boolean
  journal_id: string
  location_name: string | null
  location_lat: number | null
  location_lng: number | null
  weather_description: string | null
  weather_temp_celsius: number | null
  weather_icon: string | null
  tags: string[]
  deleted_at: Date | null
}

/** The locked row without its tombstone column — what a conflict copy snapshots. */
type ServerSnapshot = Omit<ExistingEntryRow, "deleted_at">

/** Retention pro Eintrag — der Strict-Win-Pfad feuert bei JEDEM
 *  gepushten Offline-Edit und schrieb den Volltext unbegrenzt oft weg; der
 *  einzige Leser (conflicts-Route) zeigt ohnehin nur die jüngsten 20. */
const CONFLICT_COPIES_CAP_PER_ENTRY = 20

export async function pruneConflictCopies(
  client: Pick<PoolClient, "query">,
  entryId: string
): Promise<void> {
  await client.query(
    `DELETE FROM sync_conflict_copies
     WHERE entry_id = $1
       AND id NOT IN (
         SELECT id FROM sync_conflict_copies
         WHERE entry_id = $1
         ORDER BY saved_at DESC, id DESC
         LIMIT $2
       )`,
    [entryId, CONFLICT_COPIES_CAP_PER_ENTRY]
  )
}

async function _saveConflictCopy(
  client: PoolClient,
  entryId: string,
  snap: ServerSnapshot
): Promise<void> {
  await client.query(
    `INSERT INTO sync_conflict_copies
       (entry_id, revision_id, text, created_at, updated_at, starred,
        location_name, location_lat, location_lng, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entryId, snap.revision_id, snap.text, snap.created_at, snap.updated_at, snap.starred,
      snap.location_name ?? null, snap.location_lat ?? null, snap.location_lng ?? null,
      snap.tags ?? [],
    ]
  )
  await pruneConflictCopies(client, entryId)
}
