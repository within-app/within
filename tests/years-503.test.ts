/**
 * GET /api/entries/years must return honest 503 on DB failure
 *
 * Verifies:
 * - In production with a throwing DB: response is 503 + {error: ...}
 * - NOT the old false-200 with empty array []
 *
 * Synthetic data only — no real credentials or DB connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Intercepts every `import("@/lib/db")` so the DB always throws,
// simulating a connection failure without needing a real Postgres instance.
vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn().mockRejectedValue(new Error("Connection refused (test stub)")),
  },
}))

import { GET } from "../src/app/api/entries/years/route"

describe("GET /api/entries/years — honest 503 on DB failure", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("returns 503 with error body in production when DB throws", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const req = new NextRequest("http://localhost/api/entries/years")
    const res = await GET(req)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })

  it("does NOT return empty array (false 200) in production on DB failure", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const req = new NextRequest("http://localhost/api/entries/years")
    const res = await GET(req)
    // Old broken behaviour was: status 200, body []
    expect(res.status).not.toBe(200)
  })
})
