import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { CreateJournalSchema } from "@/lib/schemas/journal.schema"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError, logWarn } from "@/lib/logger"

export async function POST(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = CreateJournalSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const { name, color } = parsed.data

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows: [j] } = await db.query(
      `INSERT INTO journals (name, color) VALUES ($1, $2) RETURNING id`,
      [name, color]
    )
    return NextResponse.json({ id: j.id, name, color, entryCount: 0 }, { status: 201 })
  } catch (error) {
    logError("[POST /api/journals] Error:", error)
    return NextResponse.json({ error: "Journal konnte nicht erstellt werden", code: "journal_create_failed" }, { status: 500 })
  }
}

export async function GET() {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  try {
    const { db } = await import("@/lib/db")
    const { rows } = await db.query(`
      SELECT
        j.id,
        j.name,
        j.color,
        COUNT(e.id)::int AS entry_count
      FROM journals j
      LEFT JOIN entries e ON e.journal_id = j.id AND e.deleted_at IS NULL
      GROUP BY j.id, j.name, j.color
      ORDER BY j.name
    `)

    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        entryCount: r.entry_count,
      }))
    )
  } catch (error) {
    logWarn("[GET /api/journals] DB error:", error)
    return dbUnavailableResponse()
  }
}
