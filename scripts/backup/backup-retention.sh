#!/usr/bin/env bash
# Retention policy — keep 7 daily + 4 weekly dumps, delete the rest.
# Runs as part of the "backup" service's nightly chain, after backup-full.sh
# (see loop.sh).
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/within/backup.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

: "${BACKUP_DEST:=/backup}"

DB_DIR="${BACKUP_DEST}/db"
LOG="${BACKUP_DEST}/logs/retention_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "${BACKUP_DEST}/logs"
exec >> "$LOG" 2>&1

echo "[$(date -u +%FT%TZ)] backup-retention.sh start"

# Collect all dump files sorted oldest-first
mapfile -t all_dumps < <(find "${DB_DIR}" -maxdepth 1 -name 'within_*.dump' | sort)

total="${#all_dumps[@]}"
echo "[$(date -u +%FT%TZ)] found ${total} dump(s)"

if [[ ${total} -le 0 ]]; then
  echo "[$(date -u +%FT%TZ)] nothing to prune"
  exit 0
fi

# Identify which files to keep:
#   - Latest 7 (daily window)
#   - One per calendar week for the 4 most recent weeks beyond those 7

declare -A keep_set

# Newest 7 are always kept
keep_count=7
start_idx=$(( total - keep_count ))
[[ ${start_idx} -lt 0 ]] && start_idx=0

for (( i = start_idx; i < total; i++ )); do
  keep_set["${all_dumps[$i]}"]=1
done

# Weekly keepers: pick the newest dump in each of the 4 calendar weeks
# prior to the daily window.
declare -A seen_weeks
weekly_kept=0

for (( i = total - keep_count - 1; i >= 0 && weekly_kept < 4; i-- )); do
  dump="${all_dumps[$i]}"
  # Extract date from filename: within_YYYYMMDD_HHMMSS.dump
  fname="$(basename "$dump")"
  date_part="${fname#within_}"
  date_part="${date_part%%_*}"
  # -D "%Y%m%d": busybox date (this image's date) needs an explicit input
  # format for -d, unlike GNU date's free-form parser.
  week_label="$(date -D "%Y%m%d" -d "${date_part}" +%G-W%V 2>/dev/null || true)"
  if [[ -n "$week_label" ]] && [[ -z "${seen_weeks[$week_label]:-}" ]]; then
    seen_weeks["$week_label"]=1
    keep_set["$dump"]=1
    (( weekly_kept++ )) || true
  fi
done

# Delete anything not in keep_set
deleted=0
for dump in "${all_dumps[@]}"; do
  if [[ -z "${keep_set[$dump]:-}" ]]; then
    echo "[$(date -u +%FT%TZ)] deleting ${dump}"
    rm -f "$dump"
    (( deleted++ )) || true
  fi
done

echo "[$(date -u +%FT%TZ)] pruned ${deleted} dump(s); kept $(( total - deleted ))"

# media-deleted/-generations (rsync --backup-dir from backup-full.sh) are
# pruned after 35 days — otherwise this trash grows without bound.
if [[ -d "${BACKUP_DEST}/media-deleted" ]]; then
  find "${BACKUP_DEST}/media-deleted" -mindepth 1 -maxdepth 1 -type d -mtime +35 \
    -exec rm -rf {} + 2>/dev/null || true
  echo "[$(date -u +%FT%TZ)] media-deleted generations older than 35d pruned"
fi

# logs/ would otherwise grow without bound (3 files per night, forever).
find "${BACKUP_DEST}/logs" -maxdepth 1 -type f -name '*.log' -mtime +90 -delete 2>/dev/null || true
echo "[$(date -u +%FT%TZ)] logs older than 90d pruned"

echo "[$(date -u +%FT%TZ)] backup-retention.sh done"
