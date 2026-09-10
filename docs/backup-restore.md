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
or `error` (with the reason). The card also shows how full the backup drive
is ("77 MB of 7.3 GB used (1 %)") — yellow from 80 %, red from 95 %.

### Switching the nightly backup off and on

The **Nightly backup** switch on that card pauses the schedule: while it is
off, the `backup` service keeps running (so "on" takes effect immediately) but
skips the 02:00 chain and records one `skipped` row per night; the card turns
yellow with "Backup paused since …" and keeps showing the last real run.
Restoring stays possible. Behind the switch is one key,
`app_settings.backup_paused_at` (`PUT /api/backup/pause` with
`{ "paused": true | false }`), which `scripts/backup/loop.sh` reads right
before the chain.

### Space guard

Before every dump, `backup-full.sh` estimates what the night needs
(2 × the size of the last dump + the media the rsync would transfer +
100 MB reserve) and compares it with the free space on the backup drive.
If that is short, it deletes the oldest dumps (with their `.meta.json`
sidecar) one by one — but always keeps at least 3 — and, if it is still
short, stops with `error` and the message "Backup-Ziel voll: X MB frei,
Y MB nötig" so the card turns red instead of the drive filling up.

## Where backups go

By default, backups are written to `./backups` next to `docker-compose.yml`
— see `x-backup-dir` at the top of that file. That folder lives on the same
disk as everything else: it protects you from mistakes (an entry deleted by
accident) but not from that disk failing.

**For real disaster protection, point the backup folder at a different
physical drive** — edit the `source` line of `x-backup-dir` (one place; the
`backup` service writes there and the `app` service reads the list of
backups there for the restore picker), e.g.:

```yaml
x-backup-dir: &backup_dir
  type: bind
  source: /mnt/external-drive/within-backups
  target: /backup
```

Any locally mounted external USB drive, second internal disk, or NAS share
(mounted on the host beforehand) works.

**Removable drive? Add the marker file.** Inside the container the backup
folder is always a mount — also when the host folder is just an empty
directory because the USB stick did not come back after a reboot, in which
case the backup would silently land on the system disk. Let the drive prove
itself: create the marker once on the mounted drive

```bash
touch /mnt/external-drive/within-backups/.within-backup-stick
```

and set `BACKUP_REQUIRE_MARKER: "true"` in the `environment:` of the
`backup` service (commented template in `docker-compose.yml`). From then on
`backup-full.sh`, `backup-verify.sh` and `restore.sh` refuse to run without
the file — `error` on the card with "Backup-Ziel nicht bereit: Marker-Datei
fehlt — steckt der USB-Stick?". Off by default, so a plain folder setup is
not affected. Change the folder only there: the
app's restore picker reads whatever is mounted at `/backup`, so a different
`BACKUP_DEST` set via an env file inside the backup container would make the
picker and the restore look at two different folders. The backup folder is set to
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

## Restore from the app (Settings → Backup → Restore)

This is the disaster path: the machine or its disk died, you set Within up
again from scratch (same `docker-compose.yml`, same backup drive plugged in),
and now want your entries back. Log in to the fresh installation, open
**Settings → Backup**, pick a backup and click **Restore backup**.

What happens:

1. The app lists the dumps in the backup folder (newest first, with the
   entry/media counts the nightly check recorded next to each dump — older
   dumps show "count unknown"). It reads the folder read-only and never
   restores anything itself.
2. On confirm the app writes a request into the database
   (`app_settings.restore_request`). The `backup` service polls for it every
   few seconds (`scripts/backup/loop.sh`) and runs `scripts/backup/restore.sh`:
   drop the database (`WITH (FORCE)` ends the app's connections), create it
   empty, `pg_restore` the dump, `rsync` the media mirror back over the media
   folder, write one `backup_runs` row with `kind = 'restore'`. That row (or
   a timeout after 10 minutes) ends the "Restoring…" dialog in the app.
3. The app then re-applies the schema (an older dump may predate this
   version), re-syncs the login password from `APP_PASSWORD`, and on
   **Reload app** the device drops its local offline copy and pulls
   everything again.

Two confirmation levels: on an **empty installation** one click is enough —
there is nothing to lose. If the database **already contains entries or
media**, the app asks for your password and for the word `RESTORE` typed
out, and shows how many entries/media will be overwritten. The level is
decided on the server from the live counts, not by the button.

Things to know:

- **Media are always restored to the state of the last backup**, whichever
  dump you pick — the media folder is mirrored as a whole, not per dump. If
  you need media files that were deleted later, see `media-deleted/`.
- **Other devices** that used Within before the crash keep their own offline
  copy and sync cursor. After a restore, log in there once more and reset
  the local data ("Forgot PIN" on the lock screen wipes only the local copy;
  the server keeps the source of truth) so the device pulls the restored
  state completely.
- Only successful nightly runs produce dumps, so anything in the list is
  restorable; a dump that fails `pg_restore --list` is refused before
  anything is dropped.
- "The backup service did not pick the request up" means the `backup`
  container is not running (or has no `DATABASE_URL`) — `docker compose ps`,
  `docker compose logs backup`.
- The restore log is written to `logs/restore_<timestamp>.log` in the backup
  folder. The `backup_runs` table keeps one row per restore (`kind =
  'restore'`), visible in the app below the picker.
- After a restore the **Backup** status card shows the nightly runs that
  were recorded *inside the dump* — a dump never contains its own run (the
  row is written after the dump). On a first-ever backup that means "no
  backup has run yet" until the next night. Likewise, the log line under the
  picker shows the latest restore; earlier restore rows survive only if a
  nightly backup ran in between (each restore replaces the database).
- Not covered: a crash in the middle of a restore. If that happens, the
  manual path below is the fallback.

## Restore by hand

The manual path — the same steps the app automates. The database keeps
running throughout — only the app needs to stop.

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
# The backup service mounts both the backup folder and the media folder:
docker compose exec backup rsync -a --delete --chown=nextjs:nodejs /backup/media/ /app/public/media/
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
