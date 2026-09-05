# Backup & Restore

## What gets backed up, and when

The `backup` service in `docker-compose.yml` runs every night at 02:00 in your
`APP_TIMEZONE` (see `scripts/backup/loop.sh`):

| Step                  | What it does                                                |
|------------------------|-------------------------------------------------------------|
| `backup-full.sh`      | `pg_dump` of the database + an `rsync` copy of your media   |
| `backup-retention.sh` | Prunes old dumps: keeps 7 daily + 4 weekly generations      |
| `backup-verify.sh`    | Restores the latest dump into a throwaway database, compares row counts against the live database, records the result |

The chain stops at the first failure. Deleted or overwritten media files are
not simply dropped — they move into a dated `media-deleted/` generation for
35 days, so an accidental delete is still recoverable for a while.

Every result is written to the `backup_runs` table and shown in the app under
**Settings → Backup**: `ok`, `stale` (no successful run in the last 26 hours),
or `error` (with the reason).

## Where backups go

By default, backups are written to `./backups` next to `docker-compose.yml`
— see the `backup` service's comment and its `volumes:` entry. That folder
lives on the same disk as everything else: it protects you from mistakes (an
entry deleted by accident) but not from that disk failing.

**For real disaster protection, point `./backups` at a different physical
drive** — edit the `backup` service's volume line, e.g.:

```yaml
volumes:
  - /mnt/external-drive/within-backups:/backup
```

Any locally mounted external USB drive, second internal disk, or NAS share
(mounted on the host beforehand) works. The backup folder is set to
permissions `700` (and each dump file to `600`) since dumps contain your
journal entries in plain text.

## Checking backup status

Open the app and go to **Settings → Backup**. For scripting, query
`GET /api/backup/status` with an authenticated session cookie.

## Running a backup manually

```bash
docker compose exec backup bash scripts/backup/backup-full.sh
docker compose exec backup bash scripts/backup/backup-retention.sh
docker compose exec backup bash scripts/backup/backup-verify.sh
```

## Restore

The database keeps running throughout — only the app needs to stop.

### 1. Stop the app

```bash
docker compose stop app
```

### 2. Pick the dump to restore

```bash
ls -lh ./backups/db/
# within_YYYYMMDD_HHMMSS.dump, newest last
DUMP=./backups/db/within_20260901_020000.dump
```

### 3. Drop and recreate the database

`journal` is both the database and its owning role (see `POSTGRES_USER` /
`POSTGRES_DB` in `docker-compose.yml`). Connect via the maintenance database
`template1` — you can't drop the database you're connected to:

```bash
docker compose exec db psql -U journal -d template1 \
  -c "DROP DATABASE journal;" \
  -c "CREATE DATABASE journal OWNER journal;"
```

### 4. Restore the dump

```bash
docker compose exec -T db pg_restore -U journal --dbname=journal \
  --no-acl --no-owner < "$DUMP"
```

### 5. Restore media

```bash
# The backup service only has read access to the media folder, so restore
# through a one-off app container that mounts your backup folder read-only:
docker compose run --rm -v ./backups/media:/restore:ro app rsync -a /restore/ /app/public/media/
```

If you need files from before a later deletion, check the dated generations
under `./backups/media-deleted/` instead of `./backups/media/`.

### 6. Restart the app

```bash
docker compose start app
```

The boot migration re-applies the schema idempotently.

### 7. Verify

Open the app and check that entries and media load correctly, then record a
fresh baseline:

```bash
docker compose exec backup bash scripts/backup/backup-verify.sh
```

The restore is complete once `GET /api/backup/status` (or Settings → Backup)
shows `ok`.

## The limits of this setup

A copy on the same machine protects against mistakes, not against hardware
failure — if that disk dies, the backup dies with it. Point `./backups` at a
separate physical drive, ideally one that isn't permanently plugged into the
same machine, to actually survive a disk or device failure. Offsite/cloud
backup is not built in; if you need it, sync `./backups` to your own cloud
storage on top of this.
