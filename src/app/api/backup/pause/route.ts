import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { dbUnavailableResponse } from "@/lib/env"
import { readJsonBody, validationError } from "@/lib/schemas"
import { logError } from "@/lib/logger"
import { setPaused } from "@/lib/db/backup-restore"

export const dynamic = "force-dynamic"

const PauseSchema = z.object({ paused: z.boolean() })

/**
 * Switches the nightly backup off ({ paused: true }) or on. Off = loop.sh
 * skips the chain and records a 'skipped' row; restores keep working.
 */
export async function PUT(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = PauseSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()
  try {
    const { db } = await import("@/lib/db")
    return NextResponse.json({ pausedAt: await setPaused(db, parsed.data.paused) })
  } catch (error) {
    logError("[PUT /api/backup/pause] Error:", error)
    return dbUnavailableResponse()
  }
}
