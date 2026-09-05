/**
 * entries — DB query layer for journal entries.
 *
 * Keeps route handlers thin; all SQL lives here so it can be tested
 * without spinning up an HTTP server.
 */

import { db } from "@/lib/db"
import { getAppTimeZone } from "@/lib/timezone"

export interface ListEntriesParams {
  journalId: string | null
  date: string | null
  onThisDay: string | null
  year: number | null
  before: string | null
  searchQuery: string | null
  tags: string[] | null
  starred: boolean | null
  /** "photo" | "audio" | "video" | "any" (Anlage beliebigen Typs) | null (aus). */
  mediaType: string | null
  page: number
  perPage: number
  /** Liefert zusätzlich media_json pro Eintrag (komplette Medienliste) —
   *  nur für full=true gesetzt, damit normale Timeline-Requests die
   *  Aggregation nicht bezahlen. */
  includeMedia?: boolean
}

interface MediaJsonRow {
  id: string
  type: string
  file_path: string
  thumbnail_path: string | null
  order_index: number
  duration_seconds: number | null
}

interface EntryRow {
  id: string
  journal_id: string
  journal_color: string
  created_at: Date
  text: string
  starred: boolean
  location_name: string | null
  weather_description: string | null
  weather_temp_celsius: number | null
  weather_icon: string | null
  thumbnail: string | null
  photo_count: number
  has_audio: boolean
  has_video: boolean
  tags: string[]
  /** Nur vorhanden, wenn includeMedia gesetzt war. */
  media_json?: MediaJsonRow[]
}

export interface ListEntriesResult {
  rows: EntryRow[]
  total: number
}

/**
 * Returns a paginated, filtered list of entries.
 *
 * ORDER BY is e.created_at DESC, e.id DESC — the id DESC tiebreaker
 * guarantees stable ordering when multiple entries share the same timestamp.
 */
export async function listEntries(
  params: ListEntriesParams
): Promise<ListEntriesResult> {
  const {
    journalId, date, onThisDay, year, before,
    searchQuery, tags, starred, mediaType,
    page, perPage, includeMedia,
  } = params
  const offset = (page - 1) * perPage
  // Explizit statt Session-Setting (Zeitzone P2) — an beide Queries als
  // zusätzlicher, letzter Parameter angehängt.
  const tz = getAppTimeZone()

  // Statisches SQL-Fragment (keine Nutzereingabe) — json_agg nur bezahlen,
  // wenn die Medienliste wirklich gebraucht wird (full=true).
  const mediaJsonColumn = includeMedia
    ? `,
       COALESCE((SELECT json_agg(json_build_object(
                   'id', m.id,
                   'type', m.type,
                   'file_path', m.file_path,
                   'thumbnail_path', m.thumbnail_path,
                   'order_index', m.order_index,
                   'duration_seconds', m.duration_seconds
                 ) ORDER BY m.order_index)
                 FROM media m WHERE m.entry_id = e.id), '[]'::json) AS media_json`
    : ""

  const countResult = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM entries e
     WHERE e.deleted_at IS NULL
       AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
       AND ($2::date IS NULL OR DATE(e.created_at AT TIME ZONE $10) = $2::date)
       AND ($3::text IS NULL OR month_day_in(e.created_at, $10) = $3::text)
       AND ($4::int  IS NULL OR EXTRACT(YEAR FROM e.created_at AT TIME ZONE $10)::int = $4::int)
       AND ($5::text IS NULL OR to_tsvector('german', e.text) @@ websearch_to_tsquery('german', $5::text))
       AND ($6::text[] IS NULL OR EXISTS (
             SELECT 1 FROM entry_tags et2 JOIN tags t2 ON t2.id = et2.tag_id
             WHERE et2.entry_id = e.id AND t2.name = ANY($6::text[])
           ))
       AND ($7::boolean IS NULL OR e.starred = $7::boolean)
       AND ($8::text IS NULL OR EXISTS (
             SELECT 1 FROM media m2
             WHERE m2.entry_id = e.id AND ($8::text = 'any' OR m2.type = $8::text)
           ))
       AND ($9::text IS NULL OR e.created_at < ((($9::text || '-01')::date + INTERVAL '1 month') AT TIME ZONE $10))`,
    [journalId, date, onThisDay, year, searchQuery, tags, starred, mediaType, before, tz]
  )

  const { rows } = await db.query<EntryRow>(
    `SELECT
       e.id,
       e.journal_id,
       j.color         AS journal_color,
       e.created_at,
       e.text,
       e.starred,
       e.location_name,
       e.weather_description,
       e.weather_temp_celsius,
       e.weather_icon,
       (SELECT thumbnail_path FROM media
        WHERE entry_id = e.id AND type = 'photo'
        ORDER BY order_index LIMIT 1)                    AS thumbnail,
       (SELECT COUNT(*)::int FROM media
        WHERE entry_id = e.id AND type = 'photo')         AS photo_count,
       EXISTS(SELECT 1 FROM media WHERE entry_id = e.id AND type = 'audio') AS has_audio,
       EXISTS(SELECT 1 FROM media WHERE entry_id = e.id AND type = 'video') AS has_video,
       COALESCE((SELECT array_agg(t.name ORDER BY t.name)
                 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                 WHERE et.entry_id = e.id), '{}')         AS tags${mediaJsonColumn}
     FROM entries e
     JOIN journals j ON j.id = e.journal_id
     WHERE e.deleted_at IS NULL
       AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
       AND ($4::date IS NULL OR DATE(e.created_at AT TIME ZONE $12) = $4::date)
       AND ($5::text IS NULL OR month_day_in(e.created_at, $12) = $5::text)
       AND ($6::int  IS NULL OR EXTRACT(YEAR FROM e.created_at AT TIME ZONE $12)::int = $6::int)
       AND ($7::text IS NULL OR to_tsvector('german', e.text) @@ websearch_to_tsquery('german', $7::text))
       AND ($8::text[] IS NULL OR EXISTS (
             SELECT 1 FROM entry_tags et2 JOIN tags t2 ON t2.id = et2.tag_id
             WHERE et2.entry_id = e.id AND t2.name = ANY($8::text[])
           ))
       AND ($9::boolean IS NULL OR e.starred = $9::boolean)
       AND ($10::text IS NULL OR EXISTS (
             SELECT 1 FROM media m2
             WHERE m2.entry_id = e.id AND ($10::text = 'any' OR m2.type = $10::text)
           ))
       AND ($11::text IS NULL OR e.created_at < ((($11::text || '-01')::date + INTERVAL '1 month') AT TIME ZONE $12))
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $2 OFFSET $3`,
    [journalId, perPage, offset, date, onThisDay, year, searchQuery, tags, starred, mediaType, before, tz]
  )

  return { rows, total: countResult.rows[0].total }
}
