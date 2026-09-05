import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { z } from "zod"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError } from "@/lib/logger"

const PinToggleSchema = z.object({ pinned: z.boolean() })

/**
 * Pin-Sync: Pin/Unpin ist Server-Zustand und reist
 * über den normalen Sync-Feed zu allen Geräten.
 *
 * - setzt/löscht `pinned_at` und bumpt `updated_at` (getChangesSince filtert
 *   auf updated_at — ohne Bump reist die Änderung nie).
 * - ändert `revision_id` NICHT: Pin ist Metadatum. Ein revision-Bump würde
 *   den nächsten Text-Edit eines Geräts, das noch die alte Revision hält,
 *   als Konflikt werten und Konfliktkopien fabrizieren (gleiche Präzedenz
 *   wie DELETE /api/media).
 * - idempotent: ist der gewünschte Zustand schon gesetzt, wird NICHTS
 *   geschrieben (kein leeres Feed-Event) und trotzdem 200 geantwortet —
 *   der Client darf Ops gefahrlos wiederholen (Push nach Netzabriss).
 * - Last-write-wins über die Server-Ankunftsreihenfolge: der jeweils
 *   letzte verarbeitete Pin/Unpin bestimmt pinned_at.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = PinToggleSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const { pinned } = parsed.data

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")

    // Zustandswechsel nur, wenn er real einer ist — die WHERE-Klausel macht
    // den Aufruf idempotent, ohne updated_at grundlos zu bumpen.
    const updated = pinned
      ? await db.query(
          `UPDATE entries SET pinned_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL AND pinned_at IS NULL`,
          [id]
        )
      : await db.query(
          `UPDATE entries SET pinned_at = NULL, updated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL AND pinned_at IS NOT NULL`,
          [id]
        )

    if ((updated.rowCount ?? 0) > 0) {
      return NextResponse.json({ ok: true })
    }

    // 0 Zeilen: entweder war der Zustand schon gesetzt (idempotenter
    // Wiederholungs-Push → 200) oder der Eintrag existiert nicht bzw. ist
    // tombstoned (→ 404, der Client verwirft den Op).
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM entries WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )
    if (rows.length === 0) {
      return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError("[PUT /api/entries/[id]/pin] Error:", error)
    return NextResponse.json({ error: "Pin konnte nicht gespeichert werden", code: "pin_update_failed" }, { status: 500 })
  }
}
