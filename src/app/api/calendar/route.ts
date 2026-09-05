import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import type { CalendarData } from "@/types/journal"
import { logWarn } from "@/lib/logger"
import { getAppTimeZone } from "@/lib/timezone"

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  // Support both single-month (?month=YYYY-MM) and range (?from=YYYY-MM&to=YYYY-MM)
  const month = searchParams.get("month")
  const from = searchParams.get("from") ?? month
  const to = searchParams.get("to") ?? month
  const journalId = searchParams.get("journalId") || null

  const monthPattern = /^\d{4}-\d{2}$/
  if (!from || !to || !monthPattern.test(from) || !monthPattern.test(to)) {
    return NextResponse.json(
      { error: "from + to parameters required (YYYY-MM)" },
      { status: 400 }
    )
  }

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")

    // For each entry in the range, get day + count + first photo thumbnail
    const { rows } = await db.query(
      `SELECT
         day,
         COUNT(*)::int AS count,
         MAX(thumbnail) AS thumbnail
       FROM (
         SELECT
           DATE(e.created_at AT TIME ZONE $4)::text AS day,
           (SELECT m.thumbnail_path FROM media m
            WHERE m.entry_id = e.id AND m.type = 'photo'
            ORDER BY m.order_index LIMIT 1) AS thumbnail
         FROM entries e
         WHERE e.deleted_at IS NULL
           AND e.created_at >= (to_date($1, 'YYYY-MM') AT TIME ZONE $4)
           AND e.created_at < ((to_date($2, 'YYYY-MM') + INTERVAL '1 month') AT TIME ZONE $4)
           AND ($3::uuid IS NULL OR e.journal_id = $3::uuid)
       ) sub
       GROUP BY day
       ORDER BY day`,
      [from, to, journalId, getAppTimeZone()]
    )

    const result: CalendarData = {}
    for (const row of rows) {
      result[row.day] = {
        count: row.count,
        thumbnail: row.thumbnail ?? undefined,
      }
    }
    return NextResponse.json(result)
  } catch (error) {
    logWarn("[GET /api/calendar] DB error:", error)
    return dbUnavailableResponse()
  }
}
