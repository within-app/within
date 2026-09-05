import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { getAppTimeZone } from "@/lib/timezone"

export async function GET(req: NextRequest) {
  const journalId = req.nextUrl.searchParams.get("journalId") || null

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(
      `SELECT EXTRACT(YEAR FROM created_at AT TIME ZONE $2)::int AS year,
              COUNT(*)::int AS count
       FROM entries
       WHERE deleted_at IS NULL
         AND ($1::uuid IS NULL OR journal_id = $1::uuid)
       GROUP BY year
       ORDER BY year DESC`,
      [journalId, getAppTimeZone()]
    )
    return NextResponse.json(rows.map((r: { year: number; count: number }) => ({ year: r.year, count: r.count })))
  } catch {
    return dbUnavailableResponse()
  }
}
