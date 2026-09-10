import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { dbUnavailableResponse } from "@/lib/env"
import { readJsonBody, validationError } from "@/lib/schemas"
import { getPasswordHash } from "@/lib/password"
import { logError } from "@/lib/logger"
import {
  DUMP_NAME_RE,
  RESTORE_CONFIRM_WORD,
  getInFlight,
  resolveRestoreState,
  setInFlight,
  type RestoreRunRow,
} from "@/lib/backup-restore"
import { dumpExists } from "@/lib/backup-restore-files"
import {
  latestRestoreRun,
  liveCounts,
  readRestoreRequest,
  writeRestoreRequest,
} from "@/lib/db/backup-restore"

export const dynamic = "force-dynamic"

const StartRestoreSchema = z.object({
  file: z.string().regex(DUMP_NAME_RE, "file muss ein within_YYYYMMDD_HHMMSS.dump-Name sein"),
  password: z.string().max(1000).optional(),
  confirm: z.string().max(100).optional(),
})

/**
 * The restored database is a different database: the schema may be older
 * than this image, the login hash inside it may differ from APP_PASSWORD, and
 * a dump from before the first journal has none. Same steps as the start
 * (src/instrumentation.ts), without a restart.
 */
async function afterRestore(): Promise<void> {
  const { runMigrations } = await import("@/lib/db/migrate")
  await runMigrations()
  const { syncPasswordFromEnv } = await import("@/lib/password")
  await syncPasswordFromEnv()
  const { ensureDefaultJournal } = await import("@/lib/journals/default-journal")
  await ensureDefaultJournal()
}

/** State of the restore in flight (or idle) plus the newest restore row for the log line. */
export async function GET() {
  if (!process.env.DATABASE_URL) return dbUnavailableResponse()
  const { db } = await import("@/lib/db")
  let flight = getInFlight()
  let restoreRow: RestoreRunRow | null | "unavailable"
  try {
    if (!flight) {
      // App restarted mid-restore, or another tab started it: the request row is the truth.
      const request = await readRestoreRequest(db)
      if (request) {
        flight = { file: request.value, requestedAt: new Date(request.updated_at) }
        setInFlight(flight)
      }
    }
    restoreRow = await latestRestoreRun(db)
  } catch (error) {
    // Mid-restore the database is dropped and rebuilt — that is the running state.
    if (!flight) return dbUnavailableResponse()
    void error
    restoreRow = "unavailable"
  }

  let state = resolveRestoreState(flight, restoreRow, new Date())
  if (state.state === "done" || state.state === "failed") {
    setInFlight(null)
    if (state.state === "done") {
      try {
        await afterRestore()
      } catch (error) {
        // The data is restored, but the schema or login may be off — never
        // send the user back into the app on a silent "done".
        logError("[GET /api/backup/restore] post-restore steps failed:", error)
        state = {
          state: "failed", file: state.file, timedOut: false,
          error: `post-restore steps failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return NextResponse.json({
    ...state,
    lastRestore: restoreRow === "unavailable" ? null : restoreRow,
  })
}

/** Asks the backup service to restore one dump. */
export async function POST(req: NextRequest) {
  const rawBody = await readJsonBody(req)
  if (rawBody instanceof NextResponse) return rawBody
  const parsed = StartRestoreSchema.safeParse(rawBody)
  if (!parsed.success) return validationError(parsed)
  const { file, password, confirm } = parsed.data

  if (!process.env.DATABASE_URL) return dbUnavailableResponse()
  if (getInFlight()) {
    return NextResponse.json(
      { error: "Eine Wiederherstellung läuft bereits", code: "restore_in_progress" },
      { status: 409 }
    )
  }
  if (!(await dumpExists(file))) {
    return NextResponse.json(
      { error: "Diese Sicherung gibt es nicht (mehr)", code: "restore_dump_not_found" },
      { status: 404 }
    )
  }

  try {
    const { db } = await import("@/lib/db")
    const live = await liveCounts(db)
    // Not the fresh-install case: the live data would be overwritten. The
    // confirmation level is decided here, never from what the client claims.
    if (live.entries > 0 || live.media > 0) {
      if (confirm !== RESTORE_CONFIRM_WORD) {
        return NextResponse.json(
          { error: "Bestätigung fehlt", code: "restore_confirm_required", live },
          { status: 400 }
        )
      }
      const hash = await getPasswordHash()
      if (!hash || !password || !(await bcrypt.compare(password, hash))) {
        return NextResponse.json({ error: "Falsches Passwort", code: "wrong_password" }, { status: 401 })
      }
    }
    const requestedAt = await writeRestoreRequest(db, file)
    setInFlight({ file, requestedAt: new Date(requestedAt) })
    return NextResponse.json(
      { state: "running", file, requestedAt: new Date(requestedAt).toISOString() },
      { status: 202 }
    )
  } catch (error) {
    logError("[POST /api/backup/restore] Error:", error)
    return dbUnavailableResponse()
  }
}
