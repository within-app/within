import { NextResponse } from "next/server"
import { db } from "@/lib/db"

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
       ORDER BY run_at DESC
       LIMIT 1`
    )

    if (rows.length === 0) {
      return NextResponse.json({ status: "no_runs_yet" })
    }

    return NextResponse.json(rows[0])
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 })
  }
}
