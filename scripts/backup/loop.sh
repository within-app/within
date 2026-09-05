#!/usr/bin/env bash
# Nightly backup scheduler for the "backup" service in docker-compose.yml.
# Waits until the next 02:00 in APP_TIMEZONE, then runs backup-full.sh ->
# backup-retention.sh -> backup-verify.sh (stopping at the first failure —
# each step already writes an error row to backup_runs), and waits for the
# next night. Runs forever; all output goes to stdout, so
# `docker compose logs backup` shows it. Set BACKUP_RUN_NOW=1 to also run the
# chain once immediately at startup (used for testing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TZ_NAME="${APP_TIMEZONE:-UTC}"

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

run_backup_chain() {
  log "running backup chain"
  if "$SCRIPT_DIR/backup-full.sh" && "$SCRIPT_DIR/backup-retention.sh" && "$SCRIPT_DIR/backup-verify.sh"; then
    log "backup chain done"
  else
    log "backup chain failed — see backup_runs / logs/ for detail, will retry at the next scheduled run"
  fi
}

if [[ "${BACKUP_RUN_NOW:-0}" == "1" ]]; then
  run_backup_chain
fi

while true; do
  wait_seconds="$(seconds_until_next_run)"
  log "next backup run in $(( wait_seconds / 60 )) min (02:00 ${TZ_NAME})"
  sleep "$wait_seconds"
  run_backup_chain
done
