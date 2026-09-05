# Local Dev Docker Guide

Run the full Within stack on your own machine — builds from source, seeds itself with synthetic data, no real journal content involved.

## Quick start

```bash
# One-time setup
cp .env.localdev.example .env.localdev

# Start (builds from source, seeds synthetic data)
docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build
```

Open **http://localhost:4000** and log in with password **`localtest`**.

Chrome treats `http://localhost` as a secure context, so the service worker registers and the app is installable even without HTTPS.

## Seed data

Synthetic journals and entries are loaded once, when the database container is created for the first time (a Postgres init script), and are not re-inserted on later restarts:

| Item | Detail |
|------|--------|
| Journals | Dev Journal, Test Journal |
| Entries | 5 synthetic entries across both journals |
| IDs | Fixed UUIDs — tests can reference them directly |

No real journal content is included. See [`scripts/seed-dev.sql`](../scripts/seed-dev.sql) for the exact data.

## Resetting the database

```bash
docker compose -f docker-compose.dev.yml --env-file .env.localdev down -v   # deletes volumes, including the seed data
docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build
```

## Optional: LAN HTTPS (for installing the PWA on a phone)

The default HTTP setup above is fine for a desktop browser, but installing the PWA on a phone over your LAN needs HTTPS. An optional Caddy profile provides it, the same way the production compose file does — it issues its own certificate for a LAN address you give it:

```bash
WITHIN_DEV_HOST_IP=192.168.1.42 docker compose -f docker-compose.dev.yml --env-file .env.localdev --profile https up --build
```

(use your machine's actual LAN IP). Open `https://192.168.1.42` on your phone; install the root certificate first, the same way as in production — see the phone setup steps in `README.md` — using this dev server's address instead.

## Switching the login password

Edit `.env.localdev` and set:

```bash
APP_PASSWORD=your-new-password
```

then restart the app container:

```bash
docker compose -f docker-compose.dev.yml --env-file .env.localdev restart app
```

The app hashes the plain-text password on startup and stores the hash; `APP_PASSWORD` doesn't need to stay in the file afterwards. If you'd rather not put a plain-text password in the file at all, set a pre-computed bcrypt hash as `APP_PASSWORD_HASH` instead — see the comment above the default value in `.env.localdev.example` for the one-line command that generates one.

## Build notes

- The image is built from source using the repo `Dockerfile`.
- Volumes are prefixed `dev_*` so this stack never collides with a production deployment's volumes on the same machine.
- Default ports (`4000` for the app, `5432` for Postgres) can be overridden with `WITHIN_DEV_PORT` / `WITHIN_DEV_DB_PORT` if something else on your machine is already using them.
