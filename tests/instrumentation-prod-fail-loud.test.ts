/**
 * instrumentation.ts must fail loud in production on migration failure.
 *
 * The mock-data fallback is a data-hygiene violation in
 * production. On DB failure in production the startup must
 * throw so Docker/orchestrator healthcheck triggers a restart; never silently
 * continue (data routes answer 503 until the DB is reachable).
 *
 * Synthetic data only — no real DB connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

// Must be hoisted — controls what `register()` gets when it does
// `await import("./lib/db/migrate")` at runtime.
vi.mock("@/lib/db/migrate", () => ({
  runMigrations: vi.fn(),
}))
vi.mock("@/lib/journals/default-journal", () => ({ ensureDefaultJournal: vi.fn(async () => false) }))
vi.mock("@/lib/password", () => ({
  syncPasswordFromEnv: vi.fn(async () => "unset"),
  getPasswordHash: vi.fn(async () => "$2b$12$test-hash"),
}))

// Suppress console noise during tests
vi.spyOn(console, "error").mockImplementation(() => {})
vi.spyOn(console, "warn").mockImplementation(() => {})

import { register } from "../src/instrumentation"
import * as migrateModule from "@/lib/db/migrate"

describe("instrumentation — production fail-loud gate", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(migrateModule.runMigrations as Mock).mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("rethrows migration error in production — no silent mock-data fallback", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(migrateModule.runMigrations as Mock).mockRejectedValueOnce(
      Object.assign(new Error("invalid index definition"), { code: "42P17" })
    )
    await expect(register()).rejects.toThrow()
  })

  it("swallows migration error in development — mock-data fallback is allowed", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.mocked(migrateModule.runMigrations as Mock).mockRejectedValueOnce(
      new Error("Connection refused")
    )
    await expect(register()).resolves.toBeUndefined()
  })

  it("succeeds normally when migrations pass in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(migrateModule.runMigrations as Mock).mockResolvedValueOnce(undefined)
    await expect(register()).resolves.toBeUndefined()
  })
})
