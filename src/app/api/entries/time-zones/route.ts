import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { readJsonBody, validationError } from "@/lib/schemas"
import { TimeZoneBackfillSchema } from "@/lib/schemas/entry.schema"
import { acceptedTimeZone } from "@/lib/db/time-zone"
import { rotateDatasetId } from "@/lib/db/dataset-id"
import { logError } from "@/lib/logger"

/**
 * Trägt die Zeitzone bestehender Einträge nach, z. B. aus einem Day-One-Export.
 * Füllt nur leere Zonen und legt nie Einträge an. updated_at bleibt: Ein neuer
 * Wert ließe ältere wartende Offline-Bearbeitungen in Konflikte laufen. Geräte
 * holen die Zone stattdessen über die neue Datenbestand-Kennung vollständig neu.
 * Beides in einer Transaktion: Scheitert nur die Kennung, träfe eine Wiederholung
 * keine leere Zone mehr und die Geräte bekämen die Zonen nie.
 */
export async function POST(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = TimeZoneBackfillSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const ids: string[] = []
    const zones: string[] = []
    let rejected = 0
    for (const item of parsed.data.items) {
      const zone = await acceptedTimeZone(db, item.timeZone)
      if (zone) {
        ids.push(item.id)
        zones.push(zone)
      } else {
        rejected++
      }
    }
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE entries e SET time_zone = u.tz
         FROM UNNEST($1::uuid[], $2::text[]) AS u(id, tz)
         WHERE e.id = u.id AND e.time_zone IS NULL`,
        [ids, zones]
      )
      const updated = result.rowCount ?? 0
      if (updated > 0) await rotateDatasetId(client)
      await client.query("COMMIT")
      return NextResponse.json({ updated, rejected })
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    logError("[POST /api/entries/time-zones] Error:", error)
    return dbUnavailableResponse()
  }
}
