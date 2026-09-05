/**
 * runMigrations must fail fast on non-transient DB errors.
 *
 * Permanent DDL errors (42P17, etc.) must abort on the first attempt rather
 * than burning the full 30×2s retry budget. Transient connection errors
 * (ECONNREFUSED, 57P03) must still be retried as before.
 *
 * Synthetic data only — no real DB connections.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import type { Mock } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}))

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return { ...actual, readFileSync: vi.fn().mockReturnValue("-- stub schema") }
})

import { runMigrations } from "../src/lib/db/migrate"
import { db } from "@/lib/db"

describe("runMigrations — fail-fast on permanent DB errors", () => {
  afterEach(() => {
    vi.mocked(db.query as Mock).mockReset()
    vi.unstubAllEnvs()
  })

  it("aborts immediately on 42P17 (permanent DDL error) — does NOT retry", async () => {
    vi.stubEnv("NODE_ENV", "test")
    let callCount = 0
    vi.mocked(db.query as Mock).mockImplementation(() => {
      callCount++
      return Promise.reject(Object.assign(new Error("invalid index definition"), { code: "42P17" }))
    })
    await expect(runMigrations()).rejects.toThrow()
    expect(callCount).toBe(1)
  })

  it("aborts immediately on 42601 (syntax error in SQL) — does NOT retry", async () => {
    vi.stubEnv("NODE_ENV", "test")
    let callCount = 0
    vi.mocked(db.query as Mock).mockImplementation(() => {
      callCount++
      return Promise.reject(Object.assign(new Error("syntax error"), { code: "42601" }))
    })
    await expect(runMigrations()).rejects.toThrow()
    expect(callCount).toBe(1)
  })

  it("retries on ECONNREFUSED (transient) and succeeds after initial failures", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.useFakeTimers()
    let callCount = 0
    vi.mocked(db.query as Mock).mockImplementation(() => {
      callCount++
      if (callCount < 3) {
        return Promise.reject(
          Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })
        )
      }
      return Promise.resolve({ rows: [] })
    })
    const migratePromise = runMigrations()
    await vi.runAllTimersAsync()
    await migratePromise
    expect(callCount).toBe(3)
    vi.useRealTimers()
  })

  it("retries on 57P03 (cannot_connect_now — transient)", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.useFakeTimers()
    let callCount = 0
    vi.mocked(db.query as Mock).mockImplementation(() => {
      callCount++
      if (callCount < 2) {
        return Promise.reject(
          Object.assign(new Error("cannot connect now"), { code: "57P03" })
        )
      }
      return Promise.resolve({ rows: [] })
    })
    const migratePromise = runMigrations()
    await vi.runAllTimersAsync()
    await migratePromise
    expect(callCount).toBe(2)
    vi.useRealTimers()
  })
})
