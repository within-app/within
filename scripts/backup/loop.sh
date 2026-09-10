#!/usr/bin/env bash
# Nightly backup scheduler for the "backup" service in docker-compose.yml.
# Waits until the next 02:00 in APP_TIMEZONE, then runs backup-full.sh ->
# backup-retention.sh -> backup-verify.sh (stopping at the first failure —
# each step already writes an error row to backup_runs), and waits for the
# next night. While waiting it polls app_settings every few seconds for a
# restore request written by the app (Settings → Backup → Restore) and runs
# restore.sh for it. While app_settings.backup_paused_at is set (the switch
# under Settings → Backup), the nightly chain is skipped and recorded as
# 'skipped'; restores still work. Runs forever; all output goes to stdout, so
# `docker compose logs backup` shows it. Set BACKUP_RUN_NOW=1 to also run the
# chain once immediately at startup (used for testing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TZ_NAME="${APP_TIMEZONE:-UTC}"
RESTORE_POLL_SECONDS="${RESTORE_POLL_SECONDS:-5}"
RESTORE_REQUEST_KEY="restore_request"
PAUSED_KEY="backup_paused_at"

# See backup-full.sh: build DATABASE_URL from the secrets volume when it was
# not handed in explicitly (the polling below needs it).
if [[ -z "${DATABASE_URL:-}" ]]; then
  secrets_dir="${WITHIN_SECRETS_DIR:-/run/within-secrets}"
  if [[ -r "$secrets_dir/db_password" ]]; then
    DATABASE_URL="postgresql://${WITHIN_DB_USER:-journal}:$(cat "$secrets_dir/db_password")@${WITHIN_DB_HOST:-db}:5432/${WITHIN_DB_NAME:-journal}"
    export DATABASE_URL
  fi
fi

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# Seconds from now until the next 02:00 local wall-clock time in TZ_NAME.
# Uses node's Intl.DateTimeFormat (already in this image) so no tzdata
# package is needed; falls back to UTC for an unrecognized zone name.
seconds_until_next_run() {
  node -e '
    let tz = process.argv[1] || "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date()).filter((p) => p.type !== "literal").map((p) => [p.type, +p.value])
    );
    const nowOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
    const target = 2 * 3600; // 02:00
    let delta = target - nowOfDay;
    if (delta <= 0) delta += 24 * 3600;
    console.log(delta);
  ' "$TZ_NAME"
}

# ISO timestamp the app stored when the switch under Settings → Backup was
# set to "off"; empty = on (or database unreachable — then the chain runs and
# reports its own error).
paused_since() {
  psql "${DATABASE_URL:-}" -At -c \
    "SELECT value FROM app_settings WHERE key = '${PAUSED_KEY}'" 2>/dev/null || true
}

run_backup_chain() {
  local paused
  paused="$(paused_since)"
  if [[ -n "$paused" ]]; then
    log "backup paused since ${paused} — skipping nightly run"
    # One 'skipped' row so the run log shows the gap; the status card keeps
    # the last real run visible (it filters skipped rows out).
    psql "${DATABASE_URL:-}" -c \
      "INSERT INTO backup_runs (status, error_msg) VALUES ('skipped', 'backup paused since ${paused//\'/}')" > /dev/null 2>&1 || true
    return 0
  fi
  log "running backup chain"
  if "$SCRIPT_DIR/backup-full.sh" && "$SCRIPT_DIR/backup-retention.sh" && "$SCRIPT_DIR/backup-verify.sh"; then
    log "backup chain done"
  else
    log "backup chain failed — see backup_runs / logs/ for detail, will retry at the next scheduled run"
  fi
}

# Dump name the app asked to restore; empty when there is no request or the
# database is unreachable.
pending_restore_request() {
  psql "${DATABASE_URL:-}" -At -c \
    "SELECT value FROM app_settings WHERE key = '${RESTORE_REQUEST_KEY}'" 2>/dev/null || true
}

run_restore() {
  local dump="$1"
  # Consume the request first: a failing restore writes an error row to
  # backup_runs and must not be retried every few seconds.
  psql "${DATABASE_URL:-}" -c \
    "DELETE FROM app_settings WHERE key = '${RESTORE_REQUEST_KEY}'" > /dev/null 2>&1 || true
  log "restore requested: ${dump}"
  if "$SCRIPT_DIR/restore.sh" "$dump"; then
    log "restore done"
  else
    log "restore failed — see backup_runs / logs/ for detail"
  fi
}

# Sleeps until the next scheduled run, checking for restore requests on the
# way. A request during the nightly chain waits until the chain is through —
# the loop is single-threaded, so backup and restore never overlap.
wait_until_next_run() {
  local deadline=$(( $(date +%s) + $1 ))
  local req
  while (( $(date +%s) < deadline )); do
    sleep "$RESTORE_POLL_SECONDS"
    req="$(pending_restore_request)"
    if [[ -n "$req" ]]; then
      run_restore "$req"
    fi
  done
}

if [[ "${BACKUP_RUN_NOW:-0}" == "1" ]]; then
  run_backup_chain
fi

while true; do
  wait_seconds="$(seconds_until_next_run)"
  log "next backup run in $(( wait_seconds / 60 )) min (02:00 ${TZ_NAME})"
  wait_until_next_run "$wait_seconds"
  run_backup_chain
done
