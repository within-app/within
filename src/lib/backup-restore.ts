/**
 * Restore from a backup (Settings → Backup → Restore) — pure part, safe to
 * import from client components. File access lives in backup-restore-files.ts.
 *
 * The app only *asks* for a restore: POST /api/backup/restore writes the dump
 * name into app_settings (key restore_request). The backup service
 * (scripts/backup/loop.sh) polls that key, consumes it, drops and re-creates
 * the database, restores the dump and the media mirror and writes one
 * backup_runs row with kind = 'restore'. GET /api/backup/restore turns
 * "request written / that row seen / nothing yet" into the state below.
 */

export const RESTORE_REQUEST_KEY = "restore_request"
/** app_settings key holding the ISO time the nightly backup was switched off; absent = on. */
export const BACKUP_PAUSED_KEY = "backup_paused_at"
/** Typed by the user when the live database is not empty. */
export const RESTORE_CONFIRM_WORD = "RESTORE"
/** No restore row after this long → the backup service did not pick the request up. */
export const RESTORE_TIMEOUT_MS = 10 * 60_000
export const DUMP_NAME_RE = /^within_\d{8}_\d{6}\.dump$/

export interface DumpInfo {
  file: string
  /** File mtime — the moment the dump was written. */
  takenAt: string
  sizeBytes: number
  /** From the counts sidecar backup-verify.sh writes; null for older dumps. */
  entries: number | null
  media: number | null
}

export interface RestoreRunRow {
  status: string
  backup_file: string | null
  run_at: string | Date
  error_msg: string | null
  live_entry_count?: number | null
  live_media_count?: number | null
  verify_entry_count: number | null
  verify_media_count: number | null
}

export interface RestoreFlight {
  file: string
  /** updated_at of the request row — database clock, comparable to run_at. */
  requestedAt: Date
}

export type RestoreState =
  | { state: "idle" }
  | { state: "running"; file: string; requestedAt: string }
  | { state: "done"; file: string; entries: number | null; media: number | null; finishedAt: string }
  | { state: "failed"; file: string; error: string; timedOut: boolean }

// intentionally minimal: one restore at a time in a single-user product —
// module state is the lock. Lost on restart; GET re-arms it from the request row.
let inFlight: RestoreFlight | null = null
export function getInFlight(): RestoreFlight | null { return inFlight }
export function setInFlight(flight: RestoreFlight | null): void { inFlight = flight }

/** Parses the counts sidecar; anything unexpected → unknown counts. */
export function parseDumpMeta(raw: string): { entries: number | null; media: number | null } {
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown; media?: unknown }
    const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null)
    return { entries: num(parsed.entries), media: num(parsed.media) }
  } catch {
    return { entries: null, media: null }
  }
}

/**
 * The restore state for a request in flight. `restoreRow` is the newest
 * kind = 'restore' row, or "unavailable" while the database is being
 * rebuilt (a query failed) — that is expected mid-restore, not an error.
 */
export function resolveRestoreState(
  flight: RestoreFlight | null,
  restoreRow: RestoreRunRow | null | "unavailable",
  now: Date
): RestoreState {
  if (!flight) return { state: "idle" }
  const running: RestoreState = {
    state: "running", file: flight.file, requestedAt: flight.requestedAt.toISOString(),
  }
  if (restoreRow !== "unavailable" && restoreRow) {
    const runAt = new Date(restoreRow.run_at)
    if (runAt.getTime() >= flight.requestedAt.getTime()) {
      if (restoreRow.status === "ok") {
        return {
          state: "done", file: flight.file,
          entries: restoreRow.verify_entry_count, media: restoreRow.verify_media_count,
          finishedAt: runAt.toISOString(),
        }
      }
      return { state: "failed", file: flight.file, error: restoreRow.error_msg ?? "unknown error", timedOut: false }
    }
  }
  if (now.getTime() - flight.requestedAt.getTime() > RESTORE_TIMEOUT_MS) {
    return { state: "failed", file: flight.file, error: "timeout", timedOut: true }
  }
  return running
}
