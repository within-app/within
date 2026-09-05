// Next.js server startup hook — runs once when the server initializes
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  // Only run on Node.js runtime (not Edge), and only when DB is configured
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DATABASE_URL) {
    try {
      const { runMigrations } = await import("./lib/db/migrate")
      await runMigrations()
      // Login-Passwort: Klartext aus APP_PASSWORD hashen und ablegen, danach
      // muss irgendein Hash existieren (Datenbank oder APP_PASSWORD_HASH) —
      // sonst kann sich niemand anmelden, und das soll den Start stoppen.
      const { syncPasswordFromEnv, getPasswordHash } = await import("./lib/password")
      const synced = await syncPasswordFromEnv()
      if (synced === "stored") console.log("[auth] Passwort-Hash aus APP_PASSWORD abgelegt")
      if (!(await getPasswordHash())) {
        throw new Error(
          "Kein Login-Passwort konfiguriert: APP_PASSWORD (Klartext, docker-compose.yml) oder APP_PASSWORD_HASH setzen."
        )
      }
      // First start: an empty installation gets one journal, so the first
      // entry can be written right away (entries always belong to a journal).
      const { ensureDefaultJournal } = await import("./lib/journals/default-journal")
      if (await ensureDefaultJournal()) console.log("[journals] Standard-Journal angelegt")
    } catch (err) {
      if (process.env.NODE_ENV === "production") {
        // Fail loudly: rethrow so Next.js startup crashes and the Docker
        // healthcheck triggers a restart (never serve anything but an
        // honest 503 without the database).
        console.error("[db] Fatal: migration failed in production — aborting startup.", err)
        throw err
      }
      // Dev/test only — startup continues; data routes answer 503 until the DB is reachable.
      console.warn("[db] Could not connect to database. Data routes answer 503 until it is reachable.", err)
    }

    // Medien-Waisen + Import-Temp-Leichen aufräumen — beim Start und
    // danach täglich. Best effort, blockiert den Start nicht (kein await auf
    // den Intervall-Lauf; sweepMediaOrphans fängt intern alles).
    try {
      const { sweepMediaOrphans } = await import("./lib/media-sweep")
      await sweepMediaOrphans()
      setInterval(() => {
        void sweepMediaOrphans()
      }, 24 * 60 * 60 * 1000).unref?.()
    } catch (err) {
      console.warn("[within/media-sweep] setup failed:", err)
    }

    // Waisen-Tags: der Schreibpfad räumt nach jedem COMMIT best
    // effort; dieser Sweep holt nach — beim Start und täglich, nie blockierend
    // (sweepOrphanTags fängt intern alles).
    try {
      const { sweepOrphanTags } = await import("./lib/db/tags")
      await sweepOrphanTags()
      setInterval(() => {
        void sweepOrphanTags()
      }, 24 * 60 * 60 * 1000).unref?.()
    } catch (err) {
      console.warn("[within/tag-sweep] setup failed:", err)
    }
  }

  // Security check: warn when SECURE_COOKIES is not enabled in production.
  // If the app is reachable over a VPN or tunnel (i.e. outside the LAN),
  // session cookies can be replayed after sniffing unless the Secure flag is set.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    // session.ts setzt das Secure-Flag bei SECURE_COOKIES=true ODER
    // TRUSTED_PROXY_COUNT>0. Die Warnung muss dieselbe Bedingung prüfen —
    // sonst meldet sie „ohne Secure-Flag", während das Flag längst gesetzt ist
    // (nachdem der Pi auf TRUSTED_PROXY_COUNT=1 ging). Eine
    // falsche Sicherheitswarnung kostet Aufmerksamkeit und verdeckt echte.
    const secureCookies =
      process.env.SECURE_COOKIES === "true" ||
      parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10) > 0
    if (!secureCookies) {
      console.warn(
        "\n⚠️  [security] SECURE_COOKIES is not set to true.\n" +
          "   Session cookies are sent without the Secure flag.\n" +
          "   This is safe for LAN-only HTTP access, but UNSAFE if the app is\n" +
          "   reachable over a VPN, tunnel, or any external HTTPS proxy.\n" +
          "   → Set SECURE_COOKIES=true in your environment when using a tunnel.\n"
      )
    }

    // Warn when TRUSTED_PROXY_COUNT is unset/0 in production: getClientIp then
    // returns "unknown" for every client, so ALL login attempts share one
    // rate-limit bucket — a single misbehaving LAN client can lock out the real
    // user (self-DoS, fail-closed trade-off).
    const trustedProxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10)
    if (!(trustedProxyCount > 0)) {
      console.warn(
        "\n⚠️  [security] TRUSTED_PROXY_COUNT is not set (or 0).\n" +
          "   Per-IP rate limiting is disabled: all clients share one bucket,\n" +
          "   so 5 failed logins from ANY device block login for everyone.\n" +
          "   → Behind Caddy/Nginx set TRUSTED_PROXY_COUNT=1 in the environment.\n"
      )
    }
  }
}
