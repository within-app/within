/**
 * XFF-Hardening Tests
 *
 * Verifies that:
 * - A spoofed/rotated x-forwarded-for header cannot bypass the login rate limit.
 * - Legitimate clients behind a real reverse proxy (TRUSTED_PROXY_COUNT=1) are
 *   identified by their true client IP, not a spoofed value.
 * - The global login backstop blocks even perfectly-rotated XFF after N attempts.
 *
 * Synthetic data only — no real credentials or journal content.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { getClientIp } from "../src/lib/get-client-ip"
import { checkRateLimit, resetStore } from "../src/lib/rate-limiter"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(xff?: string, xri?: string): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      const n = name.toLowerCase()
      if (n === "x-forwarded-for") return xff ?? null
      if (n === "x-real-ip") return xri ?? null
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// getClientIp — trusted-hop extraction
// ---------------------------------------------------------------------------

describe("getClientIp — TRUSTED_PROXY_COUNT=0 (default, no proxy trust)", () => {
  it("returns 'unknown' even when x-real-ip is present — x-real-ip is client-settable", () => {
    // An attacker can set X-Real-IP to any value; when TRUSTED_PROXY_COUNT=0
    // we must NOT use it — fail-closed means all traffic shares the "unknown" bucket.
    const headers = makeHeaders("1.2.3.4", "5.6.7.8")
    expect(getClientIp(headers, 0)).toBe("unknown")
  })

  it("returns 'unknown' when neither header is present", () => {
    const headers = makeHeaders()
    expect(getClientIp(headers, 0)).toBe("unknown")
  })

  it("ignores spoofed XFF and x-real-ip — all untrusted traffic shares one bucket", () => {
    // Rotating X-Real-IP must not bypass the per-IP rate limit
    const headers = makeHeaders("spoofed-ip", "rotated-real-ip")
    expect(getClientIp(headers, 0)).toBe("unknown")
  })
})

describe("getClientIp — TRUSTED_PROXY_COUNT=1 (single reverse proxy)", () => {
  it("extracts the real client IP from a single-entry XFF added by the proxy", () => {
    // Reverse proxy appended real client IP; no spoofing
    const headers = makeHeaders("203.0.113.1")
    expect(getClientIp(headers, 1)).toBe("203.0.113.1")
  })

  it("extracts the real client IP despite a spoofed prefix in XFF", () => {
    // Attacker prepends a fake IP; proxy appended real client IP at the right
    const headers = makeHeaders("spoofed-ip, 203.0.113.1")
    expect(getClientIp(headers, 1)).toBe("203.0.113.1")
  })

  it("handles multiple spoofed entries — still takes the proxy-appended rightmost", () => {
    const headers = makeHeaders("spoof1, spoof2, spoof3, 203.0.113.42")
    expect(getClientIp(headers, 1)).toBe("203.0.113.42")
  })

  it("fails closed (returns shared key) when XFF has fewer entries than TRUSTED_PROXY_COUNT", () => {
    // 0 XFF entries but proxy count=1 — something is wrong, fail closed
    const headers = makeHeaders("")
    const ip = getClientIp(headers, 1)
    // Must NOT return a spoofable value; returns the shared-fallback constant
    expect(ip).toBe("untrusted")
  })

  it("fails closed when XFF header is absent entirely", () => {
    const headers = makeHeaders(undefined, undefined)
    expect(getClientIp(headers, 1)).toBe("untrusted")
  })
})

// ---------------------------------------------------------------------------
// Rate limiter — global login backstop
// ---------------------------------------------------------------------------

describe("Rate limiter — global login backstop", () => {
  const originalEnv = process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX

  beforeEach(() => {
    resetStore()
    process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX = "3"
  })

  afterEach(() => {
    resetStore()
    if (originalEnv === undefined) {
      delete process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX
    } else {
      process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX = originalEnv
    }
  })

  it("blocks after RATE_LIMIT_LOGIN_GLOBAL_MAX global login failures regardless of IP", () => {
    const globalMax = 3
    // Simulate an attacker who rotates IPs — each call comes from a different IP
    // but they all share the global bucket
    for (let i = 0; i < globalMax; i++) {
      const result = checkRateLimit(`10.0.0.${i}`, "login", 5, 60_000, globalMax)
      expect(result.allowed).toBe(true)
    }
    // Next attempt from a brand-new IP should still be blocked by global limit
    const blocked = checkRateLimit("10.0.0.99", "login", 5, 60_000, globalMax)
    expect(blocked.allowed).toBe(false)
  })

  it("per-IP limit still fires independently of global limit", () => {
    const globalMax = 100 // high global limit so it doesn't interfere
    const perIpMax = 2

    const r1 = checkRateLimit("1.2.3.4", "login", perIpMax, 60_000, globalMax)
    const r2 = checkRateLimit("1.2.3.4", "login", perIpMax, 60_000, globalMax)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)

    const r3 = checkRateLimit("1.2.3.4", "login", perIpMax, 60_000, globalMax)
    expect(r3.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration — spoofed XFF + rate limit: rotating header cannot bypass limit
// ---------------------------------------------------------------------------

describe("Integration — spoofed rotating XFF cannot bypass per-IP limit", () => {
  const originalEnv = {
    trusted: process.env.TRUSTED_PROXY_COUNT,
    loginMax: process.env.RATE_LIMIT_LOGIN_MAX,
    globalMax: process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX,
  }

  beforeEach(() => {
    resetStore()
    process.env.TRUSTED_PROXY_COUNT = "1"
    process.env.RATE_LIMIT_LOGIN_MAX = "3"
    process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX = "10"
  })

  afterEach(() => {
    resetStore()
    if (originalEnv.trusted === undefined) delete process.env.TRUSTED_PROXY_COUNT
    else process.env.TRUSTED_PROXY_COUNT = originalEnv.trusted
    if (originalEnv.loginMax === undefined) delete process.env.RATE_LIMIT_LOGIN_MAX
    else process.env.RATE_LIMIT_LOGIN_MAX = originalEnv.loginMax
    if (originalEnv.globalMax === undefined) delete process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX
    else process.env.RATE_LIMIT_LOGIN_GLOBAL_MAX = originalEnv.globalMax
  })

  it("treats rotated spoofed XFF entries as the same real client IP", () => {
    // Reverse proxy is at 192.168.x.x; real attacker IP is 10.0.0.7
    // Attacker rotates the LEFTMOST (spoofed) XFF value but their real IP stays fixed
    const trustedProxyCount = 1
    const perIpMax = 3
    const globalMax = 10

    const realAttackerIp = "10.0.0.7"

    // Each request has a different spoofed prefix but the same real IP (appended by proxy)
    const xffHeaders = [
      `fake1, ${realAttackerIp}`,
      `fake2, ${realAttackerIp}`,
      `fake3, ${realAttackerIp}`,
    ]

    const results = xffHeaders.map((xff) => {
      const headers = makeHeaders(xff)
      const ip = getClientIp(headers, trustedProxyCount)
      return checkRateLimit(ip, "login", perIpMax, 60_000, globalMax)
    })

    expect(results[0].allowed).toBe(true)
    expect(results[1].allowed).toBe(true)
    expect(results[2].allowed).toBe(true)

    // 4th attempt — should be blocked (same real IP, per-IP limit exceeded)
    const ip = getClientIp(makeHeaders(`fake4, ${realAttackerIp}`), trustedProxyCount)
    const blocked = checkRateLimit(ip, "login", perIpMax, 60_000, globalMax)
    expect(blocked.allowed).toBe(false)
  })
})
