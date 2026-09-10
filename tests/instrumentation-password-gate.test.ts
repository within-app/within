/**
 * Startup-Gate: nach der Migration muss ein Login-Passwort-Hash existieren
 * (aus APP_PASSWORD abgeleitet oder APP_PASSWORD_HASH). Fehlt beides, stoppt
 * der Start in Produktion laut — sonst liefe ein Container, in dem sich
 * niemand anmelden kann. Synthetisch, keine DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db/migrate", () => ({ runMigrations: vi.fn(async () => {}) }))
vi.mock("@/lib/journals/default-journal", () => ({ ensureDefaultJournal: vi.fn(async () => false) }))
vi.mock("@/lib/password", () => ({
  syncPasswordFromEnv: vi.fn(async () => "unset"),
  getPasswordHash: vi.fn(async () => null),
}))
vi.mock("@/lib/media-sweep", () => ({ sweepMediaOrphans: vi.fn(async () => {}) }))
vi.mock("@/lib/db/tags", () => ({ sweepOrphanTags: vi.fn(async () => {}) }))
vi.spyOn(console, "error").mockImplementation(() => {})
vi.spyOn(console, "warn").mockImplementation(() => {})
vi.spyOn(console, "log").mockImplementation(() => {})

import { register } from "../src/instrumentation"
import * as password from "@/lib/password"
import { sweepMediaOrphans } from "@/lib/media-sweep"
import { sweepOrphanTags } from "@/lib/db/tags"

describe("instrumentation — Passwort-Gate", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("Produktion ohne Hash: Start wirft mit Hinweis auf APP_PASSWORD", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(register()).rejects.toThrow(/APP_PASSWORD/)
  })

  it("Produktion mit abgelegtem Hash: Start läuft durch und hat den Klartext synchronisiert", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(password.syncPasswordFromEnv).mockResolvedValueOnce("stored")
    vi.mocked(password.getPasswordHash).mockResolvedValueOnce("$2b$12$hash")
    await expect(register()).resolves.toBeUndefined()
    expect(password.syncPasswordFromEnv).toHaveBeenCalled()
  })

  it("Entwicklung ohne Hash: nur Warnung, Start läuft weiter", async () => {
    vi.stubEnv("NODE_ENV", "development")
    await expect(register()).resolves.toBeUndefined()
  })

  it("Sweeps: nicht bei t=0, sondern 60 s nach dem Start als Kette Medien → Tags, nie awaited", async () => {
    vi.useFakeTimers()
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(password.getPasswordHash).mockResolvedValueOnce("$2b$12$hash")
    vi.mocked(sweepMediaOrphans).mockClear()
    vi.mocked(sweepOrphanTags).mockClear()
    // Media sweep takes 10 s: tags must wait for it (chain, not fan-out).
    vi.mocked(sweepMediaOrphans).mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r({ removedTmp: 0, removedOrphans: 0 }), 10_000))
    )
    await expect(register()).resolves.toBeUndefined()
    expect(sweepMediaOrphans).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sweepMediaOrphans).toHaveBeenCalledTimes(1)
    expect(sweepOrphanTags).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sweepOrphanTags).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
