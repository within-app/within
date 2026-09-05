#!/usr/bin/env bash
# Full backup: pg_dump + media rsync onto BACKUP_DEST.
#
# Runs as the "backup" service in docker-compose.yml (see loop.sh for the
# nightly schedule). Defaults match that service's mounts — override via
# environment, or an optional env file at $ENV_FILE, for other setups.
#
# Notes on the hardening below:
#   - Mountpoint guard: never write into the container's own writable layer
#     if the backup volume isn't actually mounted.
#   - The dump is written atomically (.part + mv) and checked with
#     pg_restore --list as a quick integrity check.
#   - Media deletions move into dated media-deleted/ generations instead of
#     a plain --delete, which would propagate a mistake into the only media
#     backup on the very next run.
#   - pg_dump's client major version is checked against the server, in case
#     these scripts ever run against a different pg_dump than the one
#     bundled in this image.
#   - Every error path writes an error row to backup_runs, so the status
#     endpoint never gets stuck showing a stale "ok".
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/within/backup.env}"

# Optional env file for setups that don't just rely on the container's own
# environment (secrets stay off the command line either way).
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# docker-entrypoint.sh builds DATABASE_URL from the secrets volume for the
# container's main process (loop.sh) — but a `docker compose exec backup`
# session (manual runs, tests) doesn't inherit that, so fall back to building
# it the same way here if it's still unset.
if [[ -z "${DATABASE_URL:-}" ]]; then
  secrets_dir="${WITHIN_SECRETS_DIR:-/run/within-secrets}"
  if [[ -r "$secrets_dir/db_password" ]]; then
    DATABASE_URL="postgresql://${WITHIN_DB_USER:-journal}:$(cat "$secrets_dir/db_password")@${WITHIN_DB_HOST:-db}:5432/${WITHIN_DB_NAME:-journal}"
  fi
fi

: "${BACKUP_DEST:=/backup}"
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${BACKUP_MEDIA_SRC:=/app/public/media}"

# Error row into backup_runs, so /api/backup/status stays honest.
# Best effort — if the database itself is down, at least the log survives.
record_error() {
  local msg="$1"
  psql "${DATABASE_URL}" -c \
    "INSERT INTO backup_runs (status, error_msg) VALUES ('error', '${msg//\'/}')" \
    > /dev/null 2>&1 || true
}
trap 'record_error "backup-full.sh failed at line ${LINENO}"' ERR

# BACKUP_DEST must be a real mountpoint — otherwise mkdir -p would silently
# create the path inside the container's own filesystem, and a full media
# copy would fill it up (a "backup" that dies with the same disk it was
# meant to protect).
if ! mountpoint -q "$BACKUP_DEST"; then
  echo "[$(date -u +%FT%TZ)] ERROR: ${BACKUP_DEST} is not mounted — check the backup service volume in docker-compose.yml" >&2
  record_error "backup folder is not mounted — check the backup service volume in docker-compose.yml"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="${BACKUP_DEST}/db/within_${TIMESTAMP}.dump"
LOG="${BACKUP_DEST}/logs/backup_${TIMESTAMP}.log"

mkdir -p "${BACKUP_DEST}/db" "${BACKUP_DEST}/media" "${BACKUP_DEST}/media-deleted" "${BACKUP_DEST}/logs"
# Dump files below contain plaintext journal entries — lock the whole folder
# down. Harmless no-op on filesystems without unix permission bits.
chmod 700 "${BACKUP_DEST}" 2>/dev/null || true

exec >> "$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] backup-full.sh start"

# Client major version must be >= server major, or pg_dump refuses outright
# ("server version mismatch, ...").
server_major="$(psql "${DATABASE_URL}" -At -c "SHOW server_version_num" | cut -c1-2)"
client_major="$(pg_dump --version | grep -oE '[0-9]+' | head -n1)"
if [[ -n "$server_major" && -n "$client_major" && "$client_major" -lt "$server_major" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: pg_dump ${client_major} < server ${server_major} — client and server are out of sync" >&2
  record_error "pg_dump client ${client_major} older than server ${server_major}"
  exit 1
fi

# --- DB dump (nice + ionice to avoid saturating small hosts) ---
# .part then atomic mv — an aborted run must never be picked up by
# verify/restore or occupy a retention slot. pg_restore --list validates the
# dump's table of contents.
nice -n 19 ionice -c 3 -n 7 \
  pg_dump --format=custom --no-acl --no-owner \
  --dbname="${DATABASE_URL}" \
  --file="${DUMP_FILE}.part"

pg_restore --list "${DUMP_FILE}.part" > /dev/null
mv "${DUMP_FILE}.part" "${DUMP_FILE}"
chmod 600 "${DUMP_FILE}" 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] db dump → ${DUMP_FILE}"

# --- Media snapshot (rsync, incremental) ---
# No plain --delete into the only media backup: deleted/overwritten files
# move into a dated generation under media-deleted/, pruned after 35 days by
# backup-retention.sh — media has no other trash stage, unlike DB dumps
# (7 daily + 4 weekly generations).
nice -n 19 ionice -c 3 -n 7 \
  rsync -a --delete \
  --backup --backup-dir="${BACKUP_DEST}/media-deleted/${TIMESTAMP}" \
  "${BACKUP_MEDIA_SRC}/" "${BACKUP_DEST}/media/"

echo "[$(date -u +%FT%TZ)] media rsync complete"
echo "[$(date -u +%FT%TZ)] backup-full.sh done"
