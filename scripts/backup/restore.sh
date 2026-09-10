#!/usr/bin/env bash
# Restore one dump from BACKUP_DEST into the live database, plus the media
# mirror into the media folder. Runs inside the "backup" service: loop.sh
# starts it when the app has written a restore request into app_settings
# (Settings → Backup → Restore in the app). Usage: restore.sh <dump filename>
#
# Same steps as the manual runbook in docs/backup-restore.md, automated:
#   1. validate the dump (name pattern + pg_restore --list)
#   2. drop the live database — WITH (FORCE) ends the app's connections —
#      and create it empty again; the maintenance connection goes to the
#      "postgres" database, because a database cannot drop itself
#   3. pg_restore the dump
#   4. rsync the media mirror over the media folder (full replace)
#   5. write one restore row into backup_runs (kind = 'restore'); the app
#      polls for that row to leave its "restoring…" state
#
# Every error path tries to write an error row, so the app can show
# "failed" instead of waiting for its timeout. A failure after step 2 leaves
# an empty or partial database: the manual runbook is the fallback.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/within/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# See backup-full.sh: build DATABASE_URL from the secrets volume when a
# `docker compose exec backup` session did not inherit it.
if [[ -z "${DATABASE_URL:-}" ]]; then
  secrets_dir="${WITHIN_SECRETS_DIR:-/run/within-secrets}"
  if [[ -r "$secrets_dir/db_password" ]]; then
    DATABASE_URL="postgresql://${WITHIN_DB_USER:-journal}:$(cat "$secrets_dir/db_password")@${WITHIN_DB_HOST:-db}:5432/${WITHIN_DB_NAME:-journal}"
  fi
fi

: "${BACKUP_DEST:=/backup}"
: "${DATABASE_URL:?DATABASE_URL must be set}"
# The media folder — the restore target here (same variable as backup-full.sh).
: "${BACKUP_MEDIA_SRC:=/app/public/media}"

DUMP_NAME="${1:-}"
# Set only after the filename passed the pattern check below — it is the only
# user-controlled value that ends up inside a psql -c string.
SAFE_NAME=""

# Error row for the app. backup_runs may be missing right after the database
# was re-created, so create it the way schema.sql does (a no-op otherwise).
record_error() {
  local msg="$1"
  local file_sql="NULL"
  [[ -n "$SAFE_NAME" ]] && file_sql="'${SAFE_NAME}'"
  psql "${DATABASE_URL}" -c "
    CREATE TABLE IF NOT EXISTS backup_runs (
      id SERIAL PRIMARY KEY, run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')), backup_file TEXT,
      live_entry_count INTEGER, verify_entry_count INTEGER,
      live_media_count INTEGER, verify_media_count INTEGER, error_msg TEXT);
    ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'backup';
    INSERT INTO backup_runs (kind, status, backup_file, error_msg)
      VALUES ('restore', 'error', ${file_sql}, '${msg//\'/}')" > /dev/null 2>&1 || true
}
trap 'record_error "restore.sh failed at line ${LINENO}"' ERR

log() { echo "[$(date -u +%FT%TZ)] $*"; }

if ! mountpoint -q "$BACKUP_DEST"; then
  log "ERROR: ${BACKUP_DEST} is not mounted — check the backup service volume in docker-compose.yml" >&2
  record_error "backup folder is not mounted — check the backup service volume in docker-compose.yml"
  exit 1
fi

# Marker file guard, see backup-full.sh.
if [[ "${BACKUP_REQUIRE_MARKER:-false}" == "true" && ! -f "${BACKUP_DEST}/.within-backup-stick" ]]; then
  log "ERROR: Backup-Ziel nicht bereit: Marker-Datei ${BACKUP_DEST}/.within-backup-stick fehlt — steckt der USB-Stick?" >&2
  record_error "Backup-Ziel nicht bereit: Marker-Datei fehlt — steckt der USB-Stick?"
  exit 1
fi

if ! [[ "$DUMP_NAME" =~ ^within_[0-9]{8}_[0-9]{6}\.dump$ ]]; then
  log "ERROR: unexpected dump filename format" >&2
  record_error "unexpected dump filename format"
  exit 1
fi
SAFE_NAME="$DUMP_NAME"
DUMP_FILE="${BACKUP_DEST}/db/${DUMP_NAME}"

mkdir -p "${BACKUP_DEST}/logs"
LOG="${BACKUP_DEST}/logs/restore_$(date +%Y%m%d_%H%M%S).log"
exec >> "$LOG" 2>&1
log "restore.sh start — dump: ${DUMP_NAME}"

if [[ ! -f "$DUMP_FILE" ]]; then
  log "ERROR: dump file not found: ${DUMP_FILE}"
  record_error "dump file not found: ${SAFE_NAME}"
  exit 1
fi

# Table of contents must be readable before anything is dropped.
pg_restore --list "$DUMP_FILE" > /dev/null
log "dump readable"

# Database name, user and a maintenance URL from DATABASE_URL — pure bash,
# same approach as backup-verify.sh.
base_url="${DATABASE_URL%%\?*}"
query_string="${DATABASE_URL:${#base_url}}"
DB_NAME="${base_url##*/}"
DB_USER="${base_url#*://}"
DB_USER="${DB_USER%%[:@]*}"
ADMIN_URL="${base_url%/*}/postgres${query_string}"
if ! [[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ && "$DB_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  log "ERROR: unexpected database name or user in DATABASE_URL"
  record_error "unexpected database name or user in DATABASE_URL"
  exit 1
fi

# What is about to be overwritten — kept in the restore row for the record.
live_entries="$(psql "${DATABASE_URL}" -At -c "SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL" 2>/dev/null || echo 0)"
live_media="$(psql "${DATABASE_URL}" -At -c "SELECT COUNT(*) FROM media" 2>/dev/null || echo 0)"
[[ "$live_entries" =~ ^[0-9]+$ ]] || live_entries=0
[[ "$live_media" =~ ^[0-9]+$ ]] || live_media=0
log "live before restore: entries=${live_entries}, media=${live_media}"

# The switch under Settings → Backup lives in app_settings, which the dump
# replaces: carry the current value across the restore (written back below).
paused_at="$(psql "${DATABASE_URL}" -At -c "SELECT value FROM app_settings WHERE key = 'backup_paused_at'" 2>/dev/null || true)"
[[ "$paused_at" =~ ^[0-9TZ:.-]*$ ]] || paused_at=""

log "dropping and re-creating database ${DB_NAME}"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)" \
  -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\"" > /dev/null

log "restoring ${DUMP_FILE} into ${DB_NAME}…"
nice -n 19 ionice -c 3 -n 7 \
  pg_restore --dbname="${DATABASE_URL}" --no-acl --no-owner "${DUMP_FILE}"
log "database restored"

# Media: the mirror replaces the media folder completely (no merge). The
# mirror always holds the state of the LAST backup, whichever dump was chosen.
# --chown: files written by root or copied from a drive without unix
# ownership (exFAT/NTFS) must belong to the app user afterwards.
if [[ -d "${BACKUP_DEST}/media" ]]; then
  nice -n 19 ionice -c 3 -n 7 \
    rsync -a --delete --chown=nextjs:nodejs "${BACKUP_DEST}/media/" "${BACKUP_MEDIA_SRC}/"
  log "media restored"
else
  log "no media mirror at ${BACKUP_DEST}/media — media folder left untouched"
fi

# An older dump may predate the kind column; a stale request row inside the
# dump must not trigger a second restore.
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'backup'" > /dev/null
psql "${DATABASE_URL}" -c "DELETE FROM app_settings WHERE key = 'restore_request'" > /dev/null 2>&1 || true
# Pause state from before the restore wins over whatever the dump carried
# (table as in schema.sql, in case the dump predates it).
psql "${DATABASE_URL}" -c "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())" > /dev/null 2>&1 || true
psql "${DATABASE_URL}" -c "DELETE FROM app_settings WHERE key = 'backup_paused_at'" > /dev/null 2>&1 || true
if [[ -n "$paused_at" ]]; then
  psql "${DATABASE_URL}" -c "INSERT INTO app_settings (key, value) VALUES ('backup_paused_at', '${paused_at}')" > /dev/null 2>&1 || true
fi

entries="$(psql "${DATABASE_URL}" -At -c "SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL")"
media="$(psql "${DATABASE_URL}" -At -c "SELECT COUNT(*) FROM media")"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO backup_runs
     (kind, status, backup_file, live_entry_count, verify_entry_count, live_media_count, verify_media_count)
   VALUES
     ('restore', 'ok', '${SAFE_NAME}', ${live_entries}, ${entries}, ${live_media}, ${media})" > /dev/null

log "restore.sh done — entries=${entries}, media=${media}"
