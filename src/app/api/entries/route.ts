import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { stripMarkdown, truncateText, extractTitle } from "@/lib/format"
import type { FullTimelineEntry, Media, MediaType, TimelineEntry, DateGroup, PaginatedTimeline } from "@/types/journal"
import { CreateEntrySchema, EntryQuerySchema } from "@/lib/schemas/entry.schema"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError, logWarn } from "@/lib/logger"
import { listEntries } from "@/lib/db/entries"
import { dateKey } from "@/lib/timezone"

export async function POST(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = CreateEntrySchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const body = parsed.data
  const { text, journalId, createdAt, starred, tags, photos } = body

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  const { db } = await import("@/lib/db")
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const { rows: [entry] } = await client.query(
      `INSERT INTO entries
         (journal_id, text, created_at, updated_at, starred,
          location_name, location_lat, location_lng,
          weather_description, weather_temp_celsius, weather_icon)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        journalId,
        text ?? "",
        createdAt ?? new Date().toISOString(),
        starred ?? false,
        body.locationName ?? null,
        body.locationLat ?? null,
        body.locationLng ?? null,
        body.weatherDescription ?? null,
        body.weatherTempCelsius ?? null,
        body.weatherIcon ?? null,
      ]
    )

    const entryId: string = entry.id

    // Batch-insert photos
    if (photos.length > 0) {
      await client.query(
        `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index)
         SELECT $1::uuid, 'photo', f, t, o
         FROM UNNEST($2::text[], $3::text[], $4::int[]) AS u(f, t, o)`,
        [
          entryId,
          photos.map(p => p.filePath),
          photos.map(p => p.thumbnailPath ?? null),
          photos.map((_, i) => i),
        ]
      )
    }

    // Batch-upsert tags then batch-link to entry
    const tagNames = tags.map(t => t.trim()).filter(Boolean)
    if (tagNames.length > 0) {
      const { rows: tagRows } = await client.query(
        `INSERT INTO tags (name) SELECT DISTINCT UNNEST($1::text[])
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tagNames]
      )
      await client.query(
        `INSERT INTO entry_tags (entry_id, tag_id)
         SELECT $1::uuid, UNNEST($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [entryId, tagRows.map((r: { id: string }) => r.id)]
      )
    }

    await client.query("COMMIT")
    return NextResponse.json({ id: entryId }, { status: 201 })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    logError("[POST /api/entries] Error:", error)
    return NextResponse.json({ error: "Eintrag konnte nicht erstellt werden", code: "entry_create_failed" }, { status: 500 })
  } finally {
    client.release()
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const queryParsed = EntryQuerySchema.safeParse(Object.fromEntries(searchParams))
  if (!queryParsed.success) return validationError(queryParsed)
  const q = queryParsed.data

  const journalId   = q.journalId ?? null
  const date        = q.date ?? null
  const onThisDay   = q.onThisDay ?? null
  const year        = q.year ?? null
  const before      = q.before ?? null
  const searchQuery = q.q ?? null
  const tags: string[] | null = q.tags ? q.tags.split(",").filter(Boolean) : null
  // Dreiwertig: das Schema erlaubt "true" UND "false" — starred=false muss
  // "nur nicht-favorisierte" filtern, nicht stillschweigend zum No-Filter werden.
  const starred: boolean | null = q.starred === "true" ? true : q.starred === "false" ? false : null
  const mediaType = q.mediaType ?? null
  const page      = q.page
  const perPage   = q.perPage
  const full      = q.full === "true"

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { rows, total: totalEntries } = await listEntries({
      journalId, date, onThisDay, year, before, searchQuery, tags, starred, mediaType, page, perPage,
      includeMedia: full,
    })

    // Group by day in the app zone (Zeitzone P2)
    const dateMap = new Map<string, TimelineEntry[]>()
    for (const row of rows) {
      const key = dateKey(new Date(row.created_at))
      if (!dateMap.has(key)) dateMap.set(key, [])
      const { title: entryTitle, body: entryBody } = extractTitle(row.text ?? "")
      const entry: TimelineEntry = {
        id: row.id,
        journalId: row.journal_id,
        journalColor: row.journal_color,
        createdAt: new Date(row.created_at).toISOString(),
        title: entryTitle,
        previewText: truncateText(stripMarkdown(entryBody || row.text)),
        thumbnail: row.thumbnail ?? undefined,
        photoCount: row.photo_count ?? 0,
        hasAudio: row.has_audio,
        hasVideo: row.has_video,
        starred: row.starred,
        location: row.location_name ?? undefined,
        weather: row.weather_icon
          ? {
              description: row.weather_description,
              temperatureCelsius: row.weather_temp_celsius,
              icon: row.weather_icon,
            }
          : undefined,
        tags: row.tags ?? [],
      }
      const media: Media[] = (row.media_json ?? []).map((m) => ({
        id: m.id,
        entryId: row.id,
        type: m.type as MediaType,
        filePath: m.file_path,
        thumbnailPath: m.thumbnail_path ?? undefined,
        order: m.order_index,
        durationSeconds: m.duration_seconds ?? undefined,
      }))
      const fullEntry: FullTimelineEntry = { ...entry, text: row.text ?? "", media }
      dateMap.get(key)!.push(full ? fullEntry : entry)
    }

    const dateGroups: DateGroup[] = Array.from(dateMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, entries]) => ({ date, formattedDate: date, entries }))

    const totalPages = Math.ceil(totalEntries / perPage)
    const result: PaginatedTimeline = {
      dateGroups,
      totalEntries,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    }

    return NextResponse.json(result)
  } catch (error) {
    logWarn("[GET /api/entries] DB error:", error)
    return dbUnavailableResponse()
  }
}
