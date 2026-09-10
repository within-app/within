import type { Pool } from "pg"
import { BACKUP_PAUSED_KEY, RESTORE_REQUEST_KEY, type RestoreRunRow } from "@/lib/backup-restore"

/** What a restore would overwrite: live entries (without tombstones) and media rows. */
export async function liveCounts(db: Pool): Promise<{ entries: number; media: number }> {
  const { rows } = await db.query<{ entries: number; media: number }>(
    `SELECT (SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL)::int AS entries,
            (SELECT COUNT(*) FROM media)::int AS media`
  )
  return rows[0]
}

/** Writes the request the backup service polls for; returns the database's timestamp. */
export async function writeRestoreRequest(db: Pool, file: string): Promise<Date> {
  const { rows } = await db.query<{ updated_at: Date }>(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING updated_at`,
    [RESTORE_REQUEST_KEY, file]
  )
  return rows[0].updated_at
}

export async function readRestoreRequest(db: Pool): Promise<{ value: string; updated_at: Date } | null> {
  const { rows } = await db.query<{ value: string; updated_at: Date }>(
    `SELECT value, updated_at FROM app_settings WHERE key = $1`,
    [RESTORE_REQUEST_KEY]
  )
  return rows[0] ?? null
}

export async function latestRestoreRun(db: Pool): Promise<RestoreRunRow | null> {
  const { rows } = await db.query<RestoreRunRow>(
    `SELECT status, backup_file, run_at, error_msg,
            live_entry_count, live_media_count, verify_entry_count, verify_media_count
     FROM backup_runs
     WHERE kind = 'restore'
     ORDER BY run_at DESC
     LIMIT 1`
  )
  return rows[0] ?? null
}

/** ISO time the nightly backup was paused (Settings → Backup switch), or null = on. */
export async function readPausedAt(db: Pool): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [BACKUP_PAUSED_KEY]
  )
  return rows[0]?.value ?? null
}

/** Sets or clears the pause key loop.sh reads before the nightly chain; returns the new pausedAt. */
export async function setPaused(db: Pool, paused: boolean): Promise<string | null> {
  if (!paused) {
    await db.query(`DELETE FROM app_settings WHERE key = $1`, [BACKUP_PAUSED_KEY])
    return null
  }
  const { rows } = await db.query<{ updated_at: Date }>(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING updated_at`,
    [BACKUP_PAUSED_KEY]
  )
  return new Date(rows[0].updated_at).toISOString()
}
