import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import type { JournalStats } from "@/types/journal"
import { logWarn } from "@/lib/logger"
import { dateKey, getAppTimeZone, monthDay, shiftDateKey } from "@/lib/timezone"

type StatsRow = {
  total_entries: number
  total_days: number
  on_this_day: number
  total_media: number
  total_countries: number
  streak_days: string[]
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const journalId = searchParams.get("journalId") || null

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")

    const now = new Date()
    const tz = getAppTimeZone()
    const todayMonthDay = monthDay(now, tz)

    // Single query with CTEs — uses one pool connection instead of six.
    const { rows } = await db.query<StatsRow>(
      `WITH
        counts AS (
          SELECT
            COUNT(*)::int                                                    AS total_entries,
            COUNT(DISTINCT DATE(created_at AT TIME ZONE $3))::int            AS total_days,
            COUNT(*) FILTER (WHERE month_day_in(created_at, $3) = $2)::int   AS on_this_day
          FROM entries
          WHERE deleted_at IS NULL
            AND ($1::uuid IS NULL OR journal_id = $1::uuid)
        ),
        media_count AS (
          SELECT COUNT(*)::int AS total_media
          FROM media m
          JOIN entries e ON e.id = m.entry_id
          WHERE e.deleted_at IS NULL
            AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
        ),
        country_count AS (
          SELECT COUNT(DISTINCT TRIM(REGEXP_REPLACE(location_name, '^.*,\\s*', '')))::int AS total_countries
          FROM entries
          WHERE deleted_at IS NULL
            AND location_name LIKE '%,%'
            AND ($1::uuid IS NULL OR journal_id = $1::uuid)
        ),
        streak_days AS (
          SELECT COALESCE(array_agg(day ORDER BY day DESC), ARRAY[]::text[]) AS days
          FROM (
            SELECT DISTINCT DATE(created_at AT TIME ZONE $3)::text AS day
            FROM entries
            WHERE deleted_at IS NULL
              AND ($1::uuid IS NULL OR journal_id = $1::uuid)
              AND created_at >= NOW() - INTERVAL '3650 days'
          ) sub
        )
      SELECT c.*, m.total_media, co.total_countries, s.days AS streak_days
      FROM counts c, media_count m, country_count co, streak_days s`,
      [journalId, todayMonthDay, tz]
    )

    const row = rows[0]

    // Calculate streak from the pre-aggregated day set.
    const daySet = new Set(row.streak_days)
    let streak = 0
    const todayKey = dateKey(now, tz)
    for (let i = 0; i < 3650; i++) {
      if (daySet.has(shiftDateKey(todayKey, -i))) {
        streak++
      } else {
        break
      }
    }

    const result: JournalStats = {
      streak,
      totalEntries: row.total_entries,
      totalMedia: row.total_media,
      totalDays: row.total_days,
      totalCountries: row.total_countries,
      onThisDayCount: row.on_this_day,
    }
    return NextResponse.json(result)
  } catch (error) {
    logWarn("[GET /api/stats] DB error:", error)
    return dbUnavailableResponse()
  }
}
