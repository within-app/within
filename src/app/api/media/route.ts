import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import type { MediaItem, PaginatedMedia } from "@/types/journal"
import { logWarn } from "@/lib/logger"

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const journalId = searchParams.get("journalId") || null
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get("perPage") ?? "48", 10)))

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const offset = (page - 1) * perPage

    const countResult = await db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM media m
       JOIN entries e ON e.id = m.entry_id
       WHERE e.deleted_at IS NULL
         AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)`,
      [journalId]
    )
    const totalCount = countResult.rows[0].total

    const { rows } = await db.query(
      `SELECT m.id, m.entry_id, m.type, m.file_path,
              m.thumbnail_path, m.preview_path, m.duration_seconds,
              m.client_media_id,
              e.created_at, j.color AS journal_color
       FROM media m
       JOIN entries e ON e.id = m.entry_id
       JOIN journals j ON j.id = e.journal_id
       WHERE e.deleted_at IS NULL
         AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
       ORDER BY e.created_at DESC, m.order_index ASC
       LIMIT $2 OFFSET $3`,
      [journalId, perPage, offset]
    )

    const photos: MediaItem[] = rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      type: r.type,
      filePath: r.file_path,
      thumbnailPath: r.thumbnail_path ?? undefined,
      previewPath: r.preview_path ?? undefined,
      durationSeconds: r.duration_seconds ?? undefined,
      // Lets the overview drop a waiting tile whose upload landed
      // while its outbox record still exists. Bounded small column.
      clientMediaId: r.client_media_id ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      journalColor: r.journal_color,
    }))

    const totalPages = Math.max(1, Math.ceil(totalCount / perPage))
    const result: PaginatedMedia = { photos, totalCount, page, totalPages }
    return NextResponse.json(result)
  } catch (error) {
    logWarn("[GET /api/media] DB error:", error)
    return dbUnavailableResponse()
  }
}
