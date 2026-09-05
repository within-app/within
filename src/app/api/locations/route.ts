import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { extractTitle } from "@/lib/format"
import type { MapMarker } from "@/types/journal"
import { logWarn } from "@/lib/logger"

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const journalId = searchParams.get("journalId") || null

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(
      `SELECT
         e.id,
         e.location_lat  AS lat,
         e.location_lng  AS lng,
         e.text,
         e.created_at,
         j.color         AS journal_color
       FROM entries e
       JOIN journals j ON j.id = e.journal_id
       WHERE e.deleted_at IS NULL
         AND e.location_lat IS NOT NULL
         AND e.location_lng IS NOT NULL
         AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
       ORDER BY e.created_at DESC`,
      [journalId]
    )

    const markers: MapMarker[] = rows.map((r) => {
      const { title } = extractTitle(r.text ?? "")
      return {
        id: r.id,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
        journalColor: r.journal_color,
        title: title || "Ohne Titel",
        createdAt: new Date(r.created_at).toISOString(),
      }
    })

    return NextResponse.json({ markers })
  } catch (error) {
    logWarn("[GET /api/locations] DB error:", error)
    return dbUnavailableResponse()
  }
}
