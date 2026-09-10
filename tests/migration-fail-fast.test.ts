/**
 * runMigrations must fail fast on non-transient DB errors.
 *
 * Permanent DDL errors (42P17, etc. — a DatabaseError with a SQLSTATE the
 * server answered with) must abort on the first attempt rather than burning
 * the full 30×2s retry budget. Everything that is NOT a server answer is
 * transient and retried: the pg-pool connect timeout (a plain Error without
 * a code, node_modules/pg-pool/index.js: 'timeout exceeded when trying to
 * connect'), DNS not ready (ENOTFOUND / EAI_AGAIN for host "db"),
 * ECONNREFUSED — plus the SQLSTATEs Postgres sends while starting or full.
 * Treating those as permanent = process exit + restart loop.
 *
 * The migration runs on its own client with statement_timeout = 0 (the
 * pool's 120 s must not hit GIN-index builds on a big journal) and destroys
 * that client afterwards so the setting never returns to the pool.
 *
 * Synthetic data only — no real DB connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DatabaseError } from "pg"

const client = { query: vi.fn(), release: vi.fn() }
vi.mock("@/lib/db", () => ({
  db: { connect: vi.fn(async () => client) },
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

const pgError = (code: string, message: string) =>
  Object.assign(new DatabaseError(message, 0, "error"), { code })

/** Rejects the schema query `failures` times, then succeeds. Returns the attempt counter. */
function failSchemaTimes(failures: number, error: Error) {
  const counter = { schemaCalls: 0 }
  client.query.mockImplementation(async (sql: string) => {
    if (sql !== "-- stub schema") return { rows: [] }
    counter.schemaCalls++
    if (counter.schemaCalls <= failures) throw error
    return { rows: [] }
  })
  return counter
}

describe("runMigrations — fail-fast on permanent DB errors", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test")
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    client.query.mockReset()
    client.release.mockReset()
    vi.mocked(db.connect).mockReset().mockImplementation(async () => client as never)
  })

  it.each([
    ["42P17 (permanent DDL error)", pgError("42P17", "invalid index definition")],
    ["42601 (syntax error in SQL)", pgError("42601", "syntax error")],
  ])("aborts immediately on %s — does NOT retry", async (_name, error) => {
    const counter = failSchemaTimes(99, error)
    await expect(runMigrations()).rejects.toBe(error)
    expect(counter.schemaCalls).toBe(1)
  })

  it.each([
    ["ECONNREFUSED (no server answer)", Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })],
    ["pg-pool connect timeout (plain Error, no code)", new Error("timeout exceeded when trying to connect")],
    ["ENOTFOUND (DNS for host db not ready)", Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" })],
    ["EAI_AGAIN (DNS temporarily unavailable)", Object.assign(new Error("getaddrinfo EAI_AGAIN db"), { code: "EAI_AGAIN" })],
    ["57P03 (cannot_connect_now — Postgres starting)", pgError("57P03", "the database system is starting up")],
    ["53300 (too_many_connections)", pgError("53300", "too many connections")],
  ])("retries on %s and succeeds after the DB comes up", async (_name, error) => {
    const counter = failSchemaTimes(2, error)
    const migratePromise = runMigrations()
    await vi.runAllTimersAsync()
    await migratePromise
    expect(counter.schemaCalls).toBe(3)
  })

  it("retries when db.connect itself rejects (pool connect timeout)", async () => {
    vi.mocked(db.connect)
      .mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"))
      .mockImplementation(async () => client as never)
    const counter = failSchemaTimes(0, new Error("unused"))
    const migratePromise = runMigrations()
    await vi.runAllTimersAsync()
    await migratePromise
    expect(counter.schemaCalls).toBe(1)
  })

  it("logs the real error message on every retry — the cause is visible on attempt 1", async () => {
    failSchemaTimes(1, new Error("client password must be a (non-empty) string"))
    const migratePromise = runMigrations()
    await vi.runAllTimersAsync()
    await migratePromise
    const retryLine = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).find((l) => l.includes("not ready yet"))
    expect(retryLine).toContain("attempt 1/30")
    expect(retryLine).toContain("client password must be a (non-empty) string")
  })

  it("applies the schema on its own client with statement_timeout = 0 and destroys that client afterwards", async () => {
    failSchemaTimes(0, new Error("unused"))
    await runMigrations()
    const sqls = client.query.mock.calls.map((c) => c[0] as string)
    expect(sqls).toEqual(["SET statement_timeout = 0", "-- stub schema"])
    expect(client.release).toHaveBeenCalledWith(true)
  })
})
