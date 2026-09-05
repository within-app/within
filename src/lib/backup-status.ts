/**
 * Klassifikation des Backup-Status für die Settings-Karte. Reine Funktion —
 * die UI und der Route Handler bleiben dünn (Architekturregel: Logik in
 * testbaren lib-Modulen).
 */

/**
 * Gleiche Schwelle wie backup-verify.sh: der nächtliche Lauf ist auf
 * 02:00 verkettet — ist der letzte ok-Lauf älter als 26 h, läuft backup-full
 * nicht mehr. Ein alter, restorebarer Dump ist KEIN gesundes Backup.
 */
export const BACKUP_STALE_HOURS = 26

export type BackupStatusLevel = "ok" | "stale" | "error" | "none" | "unavailable"

/** Shape der /api/backup/status-Antwort (jüngste backup_runs-Row). */
export interface BackupStatusRow {
  status?: string
  run_at?: string
  backup_file?: string | null
  error_msg?: string | null
  live_entry_count?: number | null
  verify_entry_count?: number | null
  live_media_count?: number | null
  verify_media_count?: number | null
}

export function classifyBackupStatus(
  row: BackupStatusRow | null,
  httpStatus: number,
  now: Date
): BackupStatusLevel {
  if (httpStatus !== 200 || !row) return "unavailable"
  if (row.status === "no_runs_yet") return "none"
  if (row.status !== "ok") return "error"
  if (!row.run_at) return "error" // kaputte Row nie als ok verkaufen
  const ageMs = now.getTime() - new Date(row.run_at).getTime()
  if (Number.isNaN(ageMs) || ageMs > BACKUP_STALE_HOURS * 3600_000) return "stale"
  return "ok"
}
