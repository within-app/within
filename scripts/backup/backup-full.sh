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
#   - Optional marker file (BACKUP_REQUIRE_MARKER=true) and a space guard
#     before the dump: see the two blocks below.
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

# Inside a container a bind mount is always a mountpoint — also when the host
# folder is just an empty directory because the USB stick did not come back
# after a reboot. Opt-in (BACKUP_REQUIRE_MARKER=true): the drive proves itself
# with a marker file, see docs/backup-restore.md.
if [[ "${BACKUP_REQUIRE_MARKER:-false}" == "true" && ! -f "${BACKUP_DEST}/.within-backup-stick" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: Backup-Ziel nicht bereit: Marker-Datei ${BACKUP_DEST}/.within-backup-stick fehlt — steckt der USB-Stick?" >&2
  record_error "Backup-Ziel nicht bereit: Marker-Datei fehlt — steckt der USB-Stick?"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="${BACKUP_DEST}/db/within_${TIMESTAMP}.dump"
LOG="${BACKUP_DEST}/logs/backup_${TIMESTAMP}.log"

mkdir -p "${BACKUP_DEST}/db" "${BACKUP_DEST}/media" "${BACKUP_DEST}/media-deleted" "${BACKUP_DEST}/logs"
# Dump files below contain plaintext journal entries — lock the folder down.
# 711, not 700: the app container (non-root) mounts this folder read-only
# and must be able to reach db/ to list the dumps for the restore picker
# (Settings → Backup); the dump files themselves stay 600 root. Harmless
# no-op on filesystems without unix permission bits.
chmod 711 "${BACKUP_DEST}" 2>/dev/null || true

exec >> "$LOG" 2>&1
echo "[$(date -u +%FT%TZ)] backup-full.sh start"

# --- Space guard ---
# Estimate: 2 × last dump + what the media rsync would transfer + 100 MB
# reserve. Not enough: drop the oldest dumps (with their sidecar) down to a
# floor of 3 generations, then give up with a failed row rather than fill
# the drive. BACKUP_FREE_BYTES_OVERRIDE replaces df in the tests only.
last_dump="$(find "${BACKUP_DEST}/db" -maxdepth 1 -name 'within_*.dump' | sort | tail -n1)"
last_dump_bytes=0
[[ -n "$last_dump" ]] && last_dump_bytes=$(( $(wc -c < "$last_dump") ))
# A failing dry run (missing/unreadable media folder) degrades the estimate
# to 0 — it must not abort the DB dump under pipefail; the real rsync below
# reports the media problem itself.
media_bytes="$( { rsync -a --delete --dry-run --stats "${BACKUP_MEDIA_SRC}/" "${BACKUP_DEST}/media/" 2>&1 || true; } \
  | sed -n 's/^Total transferred file size: *\([0-9,]*\).*/\1/p' | tr -d ,)"
need_bytes=$(( 2 * last_dump_bytes + ${media_bytes:-0} + 100 * 1024 * 1024 ))
if [[ -n "${BACKUP_FREE_BYTES_OVERRIDE:-}" ]]; then
  free_bytes="$BACKUP_FREE_BYTES_OVERRIDE"
else
  # -P -k: one line per filesystem in 1K blocks — same on busybox and macOS.
  free_bytes=$(( $(df -Pk "$BACKUP_DEST" | awk 'NR == 2 { print $4 }') * 1024 ))
fi
echo "[$(date -u +%FT%TZ)] space: free=$(( free_bytes / 1048576 )) MB, need=$(( need_bytes / 1048576 )) MB"
if (( free_bytes < need_bytes )); then
  # while-read, not mapfile: the tests run this under macOS' bash 3.2.
  remaining="$(find "${BACKUP_DEST}/db" -maxdepth 1 -name 'within_*.dump' | wc -l)"
  while IFS= read -r dump; do
    (( free_bytes >= need_bytes || remaining <= 3 )) && break
    dump_bytes=$(( $(wc -c < "$dump") ))
    rm -f "$dump" "${dump}.meta.json"
    free_bytes=$(( free_bytes + dump_bytes ))
    remaining=$(( remaining - 1 ))
    echo "[$(date -u +%FT%TZ)] freed $(( dump_bytes / 1048576 )) MB: deleted ${dump}"
  done < <(find "${BACKUP_DEST}/db" -maxdepth 1 -name 'within_*.dump' | sort)
fi
if (( free_bytes < need_bytes )); then
  space_msg="Backup-Ziel voll: $(( free_bytes / 1048576 )) MB frei, $(( need_bytes / 1048576 )) MB nötig"
  echo "[$(date -u +%FT%TZ)] ERROR: ${space_msg}" >&2
  record_error "$space_msg"
  exit 1
fi

# Client major version must be >= server major, or pg_dump refuses outright
# ("server version mismatch, ...").
server_major="$(psql "${DATABASE_URL}" -At -c "SHOW server_version_num" | cut -c1-2)"
# One process instead of grep | head: under pipefail, head closing the pipe
# early sends busybox grep a SIGPIPE (exit 141) now and then — a flaky ERR
# trap right at the start of every nightly run.
client_major="$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
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
