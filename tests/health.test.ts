/**
 * GET /api/health must return {status, sha}
 *
 * Two cases:
 * - GIT_SHA env var set   → sha field echoes the value
 * - GIT_SHA env var unset → sha field is "unknown"
 *
 * Synthetic data only — no DB, no credentials.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { GET } from "../src/app/api/health/route"

describe("GET /api/health", () => {
  const originalSha = process.env.GIT_SHA

  beforeEach(() => {
    delete process.env.GIT_SHA
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
})
