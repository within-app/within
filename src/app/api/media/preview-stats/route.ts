import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { stat } from "fs/promises"
import { dbUnavailableResponse } from "@/lib/env"
import { safeMediaPath } from "@/lib/media-security"
import { logWarn } from "@/lib/logger"

/**
 * Speicherplatz-Info für den Offline-Medienspiegel:
 * Anzahl + Bytes der Server-Thumbnails (`*-thumb.webp`) aller Fotos, deren
 * Eintrag im Zeitraum liegt (`created_at >= since`; ohne since: alle). Das
 * ist der SOLL-Zustand der Zeitraum-Einstellung aus echten Server-Zahlen —
 * nicht der Cache-Ist auf dem Gerät.
 *
 * Die media-Tabelle hat keine Größen-Spalten (bestätigt auf dem Pi) — die Route
 * stat'et die thumbnail_path-Dateien. Query wählt NUR die kleine Pfad-Spalte
 * (Pi-OOM-Regel); fehlende Dateien werden übersprungen (die könnte
 * auch der Spiegel nicht laden — ehrliche Zahl statt Soll-Fiktion).
 */

const NO_STORE = "private, no-store"

const QuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
})

function withNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", NO_STORE)
  return res
}

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({
    since: req.nextUrl.searchParams.get("since") ?? undefined,
  })
  if (!parsed.success) {
    return withNoStore(
      NextResponse.json(
        { error: "since muss ein ISO-Zeitstempel sein", code: "invalid_since" },
        { status: 400 }
      )
    )
  }
  const since = parsed.data.since ?? null

  if (!process.env.DATABASE_URL) return withNoStore(dbUnavailableResponse())

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query<{ thumbnail_path: string }>(
      `SELECT m.thumbnail_path
       FROM media m
       JOIN entries e ON e.id = m.entry_id
       WHERE e.deleted_at IS NULL
         AND m.type = 'photo'
         AND m.thumbnail_path IS NOT NULL
         AND ($1::timestamptz IS NULL OR e.created_at >= $1::timestamptz)`,
      [since]
    )

    let count = 0
    let bytes = 0
    for (const row of rows) {
      try {
        const size = (await stat(safeMediaPath(process.cwd(), row.thumbnail_path))).size
        count++
        bytes += size
      } catch {
        // Datei fehlt oder Pfad unsauber — überspringen, nicht raten.
      }
    }

    return withNoStore(NextResponse.json({ count, bytes }))
  } catch (error) {
    logWarn("[GET /api/media/preview-stats] DB error:", error)
    return withNoStore(dbUnavailableResponse())
  }
}
