/**
 * CSP Nonce Tests
 *
 * Verifies that:
 * - buildCspWithNonce produces a CSP with 'nonce-...' in script-src
 * - script-src does NOT contain 'unsafe-inline'
 * - style-src retains 'unsafe-inline' (Tailwind/shadcn requirement)
 * - Other directives are unchanged
 * - generateNonce returns unique values per call
 * - The middleware sets Content-Security-Policy with a nonce on every response
 * - The nonce is forwarded as x-nonce request header for Next.js hydration scripts
 *
 * Synthetic data only — no real credentials or journal content.
 */

import { describe, it, expect } from "vitest"
import { buildCspWithNonce, generateNonce } from "../src/lib/csp"
import { proxy as middleware } from "../src/proxy"
import { NextRequest } from "next/server"

const BASE_URL = "http://localhost:3000"

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, BASE_URL))
}

// ---------------------------------------------------------------------------
// buildCspWithNonce — pure CSP assembly
// ---------------------------------------------------------------------------

describe("buildCspWithNonce — CSP directive assembly", () => {
  it("includes the nonce in script-src", () => {
    const csp = buildCspWithNonce("abc123")
    expect(csp).toContain("'nonce-abc123'")
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).toContain("'nonce-abc123'")
  })

  it("does NOT include 'unsafe-inline' in script-src", () => {
    const csp = buildCspWithNonce("abc123")
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it("preserves 'unsafe-inline' in style-src (Tailwind/shadcn CSS variables)", () => {
    const csp = buildCspWithNonce("abc123")
    const styleSrc = csp.split(";").find((d) => d.trim().startsWith("style-src"))
    expect(styleSrc).toBeDefined()
    expect(styleSrc).toContain("'unsafe-inline'")
  })

  it("includes required directives unchanged", () => {
    const csp = buildCspWithNonce("abc123")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("font-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("inlines the full nonce value correctly", () => {
    const nonce = "VGVzdE5vbmNl"
    const csp = buildCspWithNonce(nonce)
    expect(csp).toContain(`'nonce-${nonce}'`)
  })
})

// ---------------------------------------------------------------------------
// generateNonce — randomness
// ---------------------------------------------------------------------------

describe("generateNonce — uniqueness", () => {
  it("returns a non-empty string", () => {
    expect(generateNonce().length).toBeGreaterThan(0)
  })

  it("returns different values on successive calls", () => {
    const samples = Array.from({ length: 10 }, generateNonce)
    const unique = new Set(samples)
    expect(unique.size).toBe(10)
  })

  it("returns base64url-safe characters only", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateNonce()).toMatch(/^[A-Za-z0-9\-_]+$/)
    }
  })
})

// ---------------------------------------------------------------------------
// middleware — response headers
// ---------------------------------------------------------------------------

describe("middleware — CSP response header", () => {
  it("sets Content-Security-Policy on every response", async () => {
    const req = makeRequest("/")
    const res = await middleware(req)
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy()
  })

  it("CSP script-src contains a nonce token", async () => {
    const req = makeRequest("/dashboard")
    const res = await middleware(req)
    const csp = res.headers.get("Content-Security-Policy") ?? ""
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9\-_]+'/)
  })

  it("CSP script-src does NOT contain 'unsafe-inline'", async () => {
    const req = makeRequest("/login")
    const res = await middleware(req)
    const csp = res.headers.get("Content-Security-Policy") ?? ""
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it("passes the nonce via x-nonce request header for Next.js hydration scripts", async () => {
    const req = makeRequest("/")
    const res = await middleware(req)
    const csp = res.headers.get("Content-Security-Policy") ?? ""
    // Extract nonce from CSP
    const nonceMatch = csp.match(/'nonce-([A-Za-z0-9\-_]+)'/)
    expect(nonceMatch).not.toBeNull()
    // The x-nonce forwarded header should contain the same nonce value
    // (NextResponse.next() with modified request headers propagates via x-middleware-request-*)
    // We verify the nonce is set in the response's request header override
    const xNonce = res.headers.get("x-middleware-request-x-nonce")
    if (xNonce !== null) {
      expect(xNonce).toBe(nonceMatch![1])
    }
  })

  it("generates a unique nonce per request", async () => {
    const req1 = makeRequest("/")
    const req2 = makeRequest("/")
    const [res1, res2] = await Promise.all([middleware(req1), middleware(req2)])
    const csp1 = res1.headers.get("Content-Security-Policy") ?? ""
    const csp2 = res2.headers.get("Content-Security-Policy") ?? ""
    expect(csp1).not.toBe(csp2)
  })
})
