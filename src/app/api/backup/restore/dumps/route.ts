import { NextResponse } from "next/server"
import { dbUnavailableResponse } from "@/lib/env"
import { logWarn } from "@/lib/logger"
import { listDumps } from "@/lib/backup-restore-files"
import { liveCounts } from "@/lib/db/backup-restore"

export const dynamic = "force-dynamic"

/** Backups to pick from, plus what a restore would overwrite. */
export async function GET() {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()
  try {
    const { db } = await import("@/lib/db")
    const live = await liveCounts(db)
    const dumps = await listDumps()
    return NextResponse.json({ mounted: dumps !== null, dumps: dumps ?? [], live })
  } catch (error) {
    logWarn("[GET /api/backup/restore/dumps] DB error:", error)
    return dbUnavailableResponse()
  }
}
