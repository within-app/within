#!/usr/bin/env bash
# Restore-verification — restores the latest dump into a throwaway DB,
# counts entries and media, compares vs live DB, writes result into
# backup_runs, then drops the temp DB. Runs as part of the "backup" service's
# nightly chain, after backup-retention.sh (see loop.sh).
#
# Requires: pg_restore, psql, DATABASE_URL (set by the container's entrypoint
# from the compose secrets, or via an optional env file at $ENV_FILE).
# The DB user must have CREATEDB privilege (or be a superuser).
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/within/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# See backup-full.sh: a `docker compose exec backup` session doesn't inherit
# the DATABASE_URL docker-entrypoint.sh builds for the container's main
# process, so fall back to building it the same way here if still unset.
if [[ -z "${DATABASE_URL:-}" ]]; then
  secrets_dir="${WITHIN_SECRETS_DIR:-/run/within-secrets}"
  if [[ -r "$secrets_dir/db_password" ]]; then
    DATABASE_URL="postgresql://${WITHIN_DB_USER:-journal}:$(cat "$secrets_dir/db_password")@${WITHIN_DB_HOST:-db}:5432/${WITHIN_DB_NAME:-journal}"
  fi
fi

: "${BACKUP_DEST:=/backup}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# Every error path must write an error row — otherwise set -e aborts on a
# broken restore and /api/backup/status keeps showing a stale "ok" (a dead
# backup-full.sh could stay green indefinitely).
record_error() {
  local msg="$1"
  psql "${DATABASE_URL}" -c \
    "INSERT INTO backup_runs (status, error_msg) VALUES ('error', '${msg//\'/}')" \
    > /dev/null 2>&1 || true
}
trap 'record_error "backup-verify.sh failed at line ${LINENO}"' ERR

# Never verify against an unmounted target (see backup-full.sh).
if ! mountpoint -q "$BACKUP_DEST"; then
  echo "[$(date -u +%FT%TZ)] ERROR: ${BACKUP_DEST} is not mounted — check the backup service volume in docker-compose.yml" >&2
  record_error "backup folder is not mounted — check the backup service volume in docker-compose.yml"
  exit 1
fi

TEMP_DB="within_verify_$$"
LOG="${BACKUP_DEST}/logs/verify_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "${BACKUP_DEST}/logs"
exec >> "$LOG" 2>&1

echo "[$(date -u +%FT%TZ)] backup-verify.sh start (temp DB: ${TEMP_DB})"

# Clean up orphaned verify DBs from earlier runs — a SIGKILL/OOM doesn't run
# the EXIT trap below, so these would otherwise accumulate unnoticed.
for leftover in $(psql "${DATABASE_URL}" -At -c \
  "SELECT datname FROM pg_database WHERE datname LIKE 'within_verify_%'"); do
  if [[ "$leftover" =~ ^within_verify_[0-9]+$ ]]; then
    echo "[$(date -u +%FT%TZ)] dropping leftover verify DB: ${leftover}"
    psql "${DATABASE_URL}" -c "DROP DATABASE IF EXISTS ${leftover}" > /dev/null 2>&1 || true
  fi
done

# Find the most recent dump
latest_dump="$(find "${BACKUP_DEST}/db" -maxdepth 1 -name 'within_*.dump' | sort | tail -n1)"
if [[ -z "$latest_dump" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: no dump found in ${BACKUP_DEST}/db"
  psql "${DATABASE_URL}" -c \
    "INSERT INTO backup_runs (status, error_msg) VALUES ('error', 'no dump file found')" \
    > /dev/null
  exit 1
fi
echo "[$(date -u +%FT%TZ)] latest dump: ${latest_dump}"

# Age check — a week-old dump that restores cleanly is NOT a healthy backup.
# A dead backup-full.sh must show up here.
if [[ -z "$(find "$latest_dump" -mmin -1560 2>/dev/null)" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: latest dump is older than 26h — backup-full.sh not running?" >&2
  record_error "latest dump older than 26h: $(basename "$latest_dump")"
  exit 1
fi

BACKUP_FILE="$(basename "$latest_dump")"

# Guard: reject any filename that doesn't match the expected pattern to prevent
# SQL injection via a crafted dump filename interpolated into psql -c strings below.
if ! [[ "$BACKUP_FILE" =~ ^within_[0-9]{8}_[0-9]{6}\.dump$ ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: unexpected dump filename: ${BACKUP_FILE}" >&2
  psql "${DATABASE_URL}" -c \
    "INSERT INTO backup_runs (status, error_msg) VALUES ('error', 'unexpected dump filename format')" \
    > /dev/null
  exit 1
fi

# Helper: extract count from DB using DATABASE_URL
live_count() {
  psql "${DATABASE_URL}" -At -c "$1"
}

# Counts in live DB
live_entries="$(live_count "SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL")"
live_media="$(live_count "SELECT COUNT(*) FROM media")"
echo "[$(date -u +%FT%TZ)] live: entries=${live_entries}, media=${live_media}"

# Build a temp DATABASE_URL pointing to TEMP_DB (replace the dbname — the
# last path segment — keeping any query string, in pure bash: no python3
# needed just for a URL rewrite).
base_url="${DATABASE_URL%%\?*}"
query_string="${DATABASE_URL:${#base_url}}"
TEMP_DATABASE_URL="${base_url%/*}/${TEMP_DB}${query_string}"

cleanup() {
  echo "[$(date -u +%FT%TZ)] cleanup: dropping ${TEMP_DB}"
  psql "${DATABASE_URL}" -c "DROP DATABASE IF EXISTS ${TEMP_DB}" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Create temp DB and restore
psql "${DATABASE_URL}" -c "CREATE DATABASE ${TEMP_DB}" > /dev/null
echo "[$(date -u +%FT%TZ)] restoring dump into ${TEMP_DB}…"
nice -n 19 ionice -c 3 -n 7 \
  pg_restore --dbname="${TEMP_DATABASE_URL}" \
  --no-acl --no-owner \
  "${latest_dump}"
echo "[$(date -u +%FT%TZ)] restore complete"

# Counts in restored DB
verify_count() {
  psql "${TEMP_DATABASE_URL}" -At -c "$1"
}
verify_entries="$(verify_count "SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL")"
verify_media="$(verify_count "SELECT COUNT(*) FROM media")"
echo "[$(date -u +%FT%TZ)] verify: entries=${verify_entries}, media=${verify_media}"

# Determine status
if [[ "${verify_entries}" -ge "${live_entries}" ]] && \
   [[ "${verify_media}"   -ge "${live_media}"   ]]; then
  STATUS="ok"
  ERROR_MSG="NULL"
else
  STATUS="error"
  ERROR_MSG="'count mismatch: live entries=${live_entries} verify=${verify_entries}; live media=${live_media} verify=${verify_media}'"
fi

# Write result into backup_runs
psql "${DATABASE_URL}" -c \
  "INSERT INTO backup_runs
     (status, backup_file, live_entry_count, verify_entry_count, live_media_count, verify_media_count, error_msg)
   VALUES
     ('${STATUS}', '${BACKUP_FILE}', ${live_entries}, ${verify_entries}, ${live_media}, ${verify_media}, ${ERROR_MSG})" \
  > /dev/null

echo "[$(date -u +%FT%TZ)] backup-verify.sh done — status=${STATUS}"

if [[ "$STATUS" != "ok" ]]; then
  exit 1
fi
