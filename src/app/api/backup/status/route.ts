import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { readPausedAt } from "@/lib/db/backup-restore"
import { destUsage } from "@/lib/backup-restore-files"

export const dynamic = "force-dynamic"

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "No DATABASE_URL configured" }, { status: 503 })
  }

  try {
    const { rows } = await db.query(
      `SELECT id, run_at, status, backup_file,
              live_entry_count, verify_entry_count,
              live_media_count, verify_media_count,
              error_msg
       FROM backup_runs
       WHERE kind = 'backup' AND status <> 'skipped'
       ORDER BY run_at DESC
       LIMIT 1`
    )
    // Paused nights are 'skipped' rows: the card shows the last real run plus
    // the pause state — never a skipped row as "the last backup".
    const pausedAt = await readPausedAt(db)
    const dest = await destUsage()

    return NextResponse.json({ ...(rows[0] ?? { status: "no_runs_yet" }), pausedAt, dest })
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 })
  }
}
