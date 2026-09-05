/**
 * Pre-auth body limit on login endpoint
 *
 * Verifies that POST /api/auth/login rejects oversized bodies with 413 *before*
 * parsing the body — preventing RAM exhaustion on the Pi 4 from the global 105 MB
 * proxyClientMaxBodySize. Covers both Content-Length header guard and the
 * chunked-encoding bypass: without Content-Length the old guard defaulted
 * to 0 and let req.json() buffer up to 105 MB unchecked.
 *
 * Synthetic data only — no real credentials.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Stub out iron-session so route import doesn't require real session config
vi.mock("@/lib/password", () => ({
  getPasswordHash: async () => process.env.APP_PASSWORD_HASH || null,
}))
vi.mock("iron-session", () => ({
  getIronSession: vi.fn(),
}))
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({}),
}))
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn() },
}))

import { POST } from "../src/app/api/auth/login/route"

function makeRequest(contentLength: number, body?: string): NextRequest {
  const url = "http://localhost/api/auth/login"
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(contentLength) },
    body: body ?? JSON.stringify({ password: "test" }),
  }
  return new NextRequest(url, init)
}

// No Content-Length header — simulates Transfer-Encoding: chunked
function makeChunkedRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

describe("POST /api/auth/login — body-size limit", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns 413 when content-length exceeds 10 000 bytes", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    const req = makeRequest(10_001)
    const res = await POST(req)

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })

  it("returns 413 at exactly 10 001 bytes", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    const req = makeRequest(10_001)
    const res = await POST(req)
    expect(res.status).toBe(413)
  })

  it("does NOT reject content-length of exactly 10 000", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    // At the limit, should fall through (will fail bcrypt, but not 413)
    const req = makeRequest(10_000, JSON.stringify({ password: "x".repeat(9_950) }))
    const res = await POST(req)
    expect(res.status).not.toBe(413)
  })

  it("does NOT reject a normal login payload (small content-length)", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    const req = makeRequest(30, JSON.stringify({ password: "secret" }))
    const res = await POST(req)
    // Should reach bcrypt (will fail — wrong hash) returning 401, not 413
    expect(res.status).not.toBe(413)
  })
})

// Content-Length header absent (Transfer-Encoding: chunked)
describe("POST /api/auth/login — chunked-encoding body-size limit", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns 413 when body exceeds 10 000 bytes with no Content-Length header", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    // 10 001 bytes of actual body, no Content-Length header
    const largeBody = JSON.stringify({ password: "x".repeat(10_001) })
    const req = makeChunkedRequest(largeBody)

    // Old guard would skip because content-length defaults to 0; new stream guard must catch it
    expect(req.headers.get("content-length")).toBeNull()

    const res = await POST(req)
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })

  it("does NOT reject a small chunked body", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2b$10$fakehashfortesting00000000000000000000000000000000000")
    vi.stubEnv("SESSION_SECRET", "test-secret-32-bytes-long-enough!")

    const req = makeChunkedRequest(JSON.stringify({ password: "hello" }))
    expect(req.headers.get("content-length")).toBeNull()

    const res = await POST(req)
    // Should reach bcrypt (will fail — wrong hash) returning 401, not 413
    expect(res.status).not.toBe(413)
  })
})
