/**
 * GET /api/health must return {status, sha} and reflect the database.
 *
 * - GIT_SHA env var set   → sha field echoes the value
 * - GIT_SHA env var unset → sha field is "unknown"
 * - DB answers SELECT 1   → 200 {status: "ok"}
 * - DB unreachable        → 503 {status: "db_down"} (Docker healthcheck
 *                            wget exits non-zero → container "unhealthy")
 * - the probe uses its own short-lived Client with tight timeouts and ends
 *   it — never the pool, so a hanging Postgres cannot eat pool slots one
 *   probe at a time.
 *
 * Synthetic data only — no DB, no credentials.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

const { client, ClientCtor } = vi.hoisted(() => {
  const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => {}) }
  return { client, ClientCtor: vi.fn(function Client() { return client }) }
})
vi.mock("pg", () => ({ Client: ClientCtor }))

import { GET } from "../src/app/api/health/route"

describe("GET /api/health", () => {
  const originalSha = process.env.GIT_SHA

  beforeEach(() => {
    delete process.env.GIT_SHA
    ClientCtor.mockClear()
    client.connect.mockClear()
    client.end.mockClear()
  })

  afterEach(() => {
    if (originalSha === undefined) {
      delete process.env.GIT_SHA
    } else {
      process.env.GIT_SHA = originalSha
    }
    vi.unstubAllEnvs()
  })

  it("returns status:ok and the configured SHA when GIT_SHA is set", async () => {
    vi.stubEnv("GIT_SHA", "abc1234567890abcdef1234567890abcdef123456")
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; sha: string }
    expect(body.status).toBe("ok")
    expect(body.sha).toBe("abc1234567890abcdef1234567890abcdef123456")
  })

  it('returns sha:"unknown" when GIT_SHA is not set', async () => {
    // GIT_SHA deleted in beforeEach — process.env.GIT_SHA is undefined
    const res = await GET()
    const body = (await res.json()) as { status: string; sha: string }
    expect(body.status).toBe("ok")
    expect(body.sha).toBe("unknown")
  })

  it("returns 503 {status: db_down, sha} when the database is unreachable — and still ends the client", async () => {
    vi.stubEnv("GIT_SHA", "deadbeef")
    client.connect.mockRejectedValueOnce(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }))
    const res = await GET()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { status: string; sha: string }
    expect(body.status).toBe("db_down")
    expect(body.sha).toBe("deadbeef")
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it("probes with its own Client (tight timeouts) and ends it on success", async () => {
    await GET()
    expect(ClientCtor).toHaveBeenCalledTimes(1)
    const cfg = (ClientCtor.mock.calls[0] as unknown as [{ connectionTimeoutMillis: number; query_timeout: number }])[0]
    expect(cfg.connectionTimeoutMillis).toBeLessThanOrEqual(3000)
    expect(cfg.query_timeout).toBeLessThanOrEqual(3000)
    expect(client.end).toHaveBeenCalledTimes(1)
  })
})
