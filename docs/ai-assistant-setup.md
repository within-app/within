# Setting up Within with an AI assistant

This file is written for an AI coding assistant (Claude Code, Codex, Cursor, …) that has shell access to the machine Within should run on. If you are a person: hand this file to your assistant and say **"install Within"**. Everything below is also what a human would do; see README.md for the illustrated version.

## What Within is

A self-hosted, single-user private journal (Next.js + PostgreSQL) for a home network. It runs from **one** `docker-compose.yml`, is reached over HTTPS with a certificate authority it creates itself, and is deliberately not reachable from the internet.

## Goal

At the end, the user can open `https://<server address>` from a computer in the home network, log in, and has clear instructions for the phone. Do not stop halfway: a half-installed Within is a certificate warning and a locked screen.

## Steps for the assistant

1. **Check prerequisites.** `docker --version` and `docker compose version` (Compose ≥ 2.23). 64-bit OS (`uname -m` → `x86_64` or `aarch64`). At least 4 GB RAM (`free -h` on Linux). If Docker is missing on Linux: `curl -fsSL https://get.docker.com | sh` and add the user to the `docker` group. Report what is missing instead of guessing.
2. **Find the server's address in the home network.** Linux: `hostname -I | awk '{print $1}'`; macOS: `ipconfig getifaddr en0`. Tell the user this address and that it must be **fixed in the router** (DHCP reservation) — you cannot do that step for them; explain where it is on a FRITZ!Box (*Home Network → Network → Network Connections → pencil icon → "Always assign the same IPv4 address"*).
3. **Ask for two things** (do not invent them): the login password they want, and their time zone as an IANA name (e.g. `Europe/Berlin`, `America/New_York`). If the system time zone is set (`timedatectl` / `cat /etc/timezone`), propose it.
4. **Create the folder and fetch the compose file** — inside the user's home directory (Docker Desktop on Mac/Windows can only mount folders there):
   ```bash
   mkdir -p ~/within && cd ~/within
   curl -fsSLO https://raw.githubusercontent.com/within-app/within/main/docker-compose.yml
   ```
5. **Fill in the three settings** at the top of the file (`x-settings`): `APP_PASSWORD`, `APP_TIMEZONE`, `APP_HOST_IP`. A `$` inside the password must be written as `$$`. Change nothing else unless port 443 or 80 is taken (`ss -ltn | grep -E ':443|:80'`); then change the `caddy` ports to `"8443:443"` / `"8080:80"` and use that port in every address you give the user.
6. **Start:** `docker compose up -d`. Wait until `docker compose ps` shows `db` and `app` *healthy* (first start pulls ~1 GB). Verify:
   ```bash
   ls -l certificate/within-root-ca.crt                      # exported root certificate
   curl -s --cacert certificate/within-root-ca.crt https://<address>/api/health   # → {"status":"ok",...}
   ```
   If the app restarts in a loop, read `docker compose logs app`; the messages name the setting that is wrong.
7. **Install the certificate on this computer if it is one of the user's devices** (macOS: copy to `/tmp`, then `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/within-root-ca.crt`; Debian/Ubuntu: copy to `/usr/local/share/ca-certificates/` and `sudo update-ca-certificates`). On a headless server skip this and tell the user to do it on their laptop (README, step 4).
8. **Hand over.** Tell the user, in plain words: the address to open (`https://<address>`), that the browser must be **restarted** after installing the certificate, the password they chose, and the phone steps: open `http://<address>/within-root-ca.crt` on the phone, install it as a CA certificate, open `https://<address>`, then *Add to Home screen*. Point them to README.md → "If something does not work".
9. **Backups** run by themselves every night into `./backups`. Recommend replacing that line with a folder on an external drive and show the exact line to change (README → Backups).

## Rules for contributors (if you are editing the code rather than installing)

- Tests first: `npm test` (unit), `npx tsc --noEmit`, `npm run lint` must stay green; end-to-end tests run against the dev stack (`docker-compose.dev.yml`, see CONTRIBUTING.md).
- Keep the posture: parameterised SQL only, streaming for media and exports (never buffer whole files — this runs on small boards), content-checked uploads, Markdown rendering without raw HTML.
- All calendar-day logic goes through `src/lib/timezone.ts` (`dateKey`, `monthDay`, `timeHHmm`, …) — never `toISOString().slice(0, 10)` or `getUTC*` on stored timestamps.
- Never commit real journal content, `.env` files, or certificates. Test data is synthetic.
- One concern per pull request; open an issue first for anything larger than a small fix. The first pull request needs the sentence from CLA.md ("I have read the CLA and I agree to it.") as a comment.
