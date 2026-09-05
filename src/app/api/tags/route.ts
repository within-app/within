import { NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { logWarn } from "@/lib/logger"

export async function GET() {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    // Waisen löscht der Schreibpfad nach jedem COMMIT bzw. der tägliche Sweep
    // (src/lib/db/tags.ts) — beides best effort. Der EXISTS-Filter ist das Netz
    // für das Fenster dazwischen: ein Index-Probe pro Tag, nie ein toter Name
    // in der Combobox.
    const { rows } = await db.query(
      `SELECT t.id, t.name FROM tags t
       WHERE EXISTS (SELECT 1 FROM entry_tags et WHERE et.tag_id = t.id)
       ORDER BY t.name ASC`
    )
    return NextResponse.json(rows)
  } catch (error) {
    logWarn("[GET /api/tags] DB error:", error)
    return dbUnavailableResponse()
  }
}
