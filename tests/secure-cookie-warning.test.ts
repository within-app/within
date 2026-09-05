/**
 * Startlog-Warnung zu SECURE_COOKIES darf nicht lügen (Befund 04.09.2026).
 *
 * `session.ts` koppelt die beiden Schalter seit B35: das Secure-Flag sitzt auf
 * dem Cookie, wenn `SECURE_COOKIES=true` ODER `TRUSTED_PROXY_COUNT > 0`. Die
 * Warnung prüfte aber nur den ersten Schalter — nachdem der Pi am 04.09. auf
 * `TRUSTED_PROXY_COUNT=1` gestellt wurde, meldete das Startlog weiterhin
 * „Session cookies are sent without the Secure flag", obwohl sie es tun.
 *
 * Eine falsche Sicherheitswarnung ist schlimmer als keine: sie kostet
 * Aufmerksamkeit und verdeckt echte Warnungen daneben.
 *
 * Synthetische Umgebung, kein Netz, keine DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db/migrate", () => ({ runMigrations: vi.fn() }))
vi.mock("@/lib/journals/default-journal", () => ({ ensureDefaultJournal: vi.fn(async () => false) }))
vi.mock("@/lib/password", () => ({
  syncPasswordFromEnv: vi.fn(async () => "unset"),
  getPasswordHash: vi.fn(async () => "$2b$12$test-hash"),
}))

import { register } from "../src/instrumentation"

function warningsFrom(warn: { mock: { calls: unknown[][] } }): string {
  return warn.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("Startlog-Sicherheitswarnungen", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("schweigt zu SECURE_COOKIES, wenn TRUSTED_PROXY_COUNT das Flag bereits setzt", async () => {
    // Genau der Stand des Pi seit 04.09.: Proxy-Count 1, SECURE_COOKIES ungesetzt.
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1")
    vi.stubEnv("SECURE_COOKIES", "")
    await register()
    expect(warningsFrom(warn)).not.toContain("SECURE_COOKIES is not set to true")
  })

  it("warnt weiter, wenn beide Schalter aus sind", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0")
    vi.stubEnv("SECURE_COOKIES", "")
    await register()
    const text = warningsFrom(warn)
    expect(text).toContain("SECURE_COOKIES is not set to true")
    expect(text).toContain("TRUSTED_PROXY_COUNT is not set (or 0)")
  })

  it("schweigt zu SECURE_COOKIES, wenn es ausdrücklich gesetzt ist", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0")
    vi.stubEnv("SECURE_COOKIES", "true")
    await register()
    expect(warningsFrom(warn)).not.toContain("SECURE_COOKIES is not set to true")
  })
})
