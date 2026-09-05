import { NextRequest, NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { ChangesQuerySchema } from "@/lib/schemas/sync.schema"
import { validationError } from "@/lib/schemas"
import { logError } from "@/lib/logger"

export async function GET(req: NextRequest) {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()

  const { searchParams } = req.nextUrl
  const parsed = ChangesQuerySchema.safeParse(Object.fromEntries(searchParams))
  if (!parsed.success) return validationError(parsed)
  const { since, journalId, cursor, limit } = parsed.data

  try {
    const { getChangesSince } = await import("@/lib/db/sync")
    const page = await getChangesSince(
      since,
      journalId ?? null,
      cursor ?? null,
      limit
    )
    return NextResponse.json(page)
  } catch (error) {
    logError("[GET /api/sync/changes] Error:", error)
    return NextResponse.json({ error: "Sync-Daten konnten nicht geladen werden", code: "sync_changes_failed" }, { status: 503 })
  }
}
