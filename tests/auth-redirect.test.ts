/**
 * Smoke tests — Auth-Redirect Guard (src/proxy.ts)
 *
 * Verifies that:
 * - Public paths (/login, /api/auth/login) bypass the auth check.
 * - PWA static assets (manifest.webmanifest, sw.js) bypass the auth check.
 * - Unauthenticated page requests redirect to /login.
 * - Unauthenticated API requests return 401 JSON (no HTML redirect).
 * - Missing SESSION_SECRET returns 500 for API and redirects to /login for pages.
 *
 * Synthetic data only — no real credentials or session cookies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { proxy, config } from "../src/proxy"
import { NextRequest } from "next/server"

const BASE_URL = "http://localhost:3000"

function makeRequest(path: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, BASE_URL), options as ConstructorParameters<typeof NextRequest>[1])
}

function makeRequestWithCookie(path: string, cookieName: string, cookieValue: string): NextRequest {
  return new NextRequest(new URL(path, BASE_URL), {
    headers: { cookie: `${cookieName}=${cookieValue}` },
  })
}

describe("Auth-Redirect Guard — public paths", () => {
  it("passes /login through without auth", async () => {
    const req = makeRequest("/login")
    const res = await proxy(req)
    // NextResponse.next() has no Location header
    expect(res.headers.get("location")).toBeNull()
    expect(res.status).toBe(200)
  })

  it("passes /api/auth/login through without auth", async () => {
    const req = makeRequest("/api/auth/login", { method: "POST" })
    const res = await proxy(req)
    expect(res.headers.get("location")).toBeNull()
    expect(res.status).toBe(200)
  })

  it("passes /api/auth/logout through without auth", async () => {
    const req = makeRequest("/api/auth/logout", { method: "POST" })
    const res = await proxy(req)
    expect(res.headers.get("location")).toBeNull()
    expect(res.status).toBe(200)
  })

  it("passes /api/health through without auth — deployed-SHA gate", async () => {
    // /api/health must be unauthenticated so the deploy-verify curl can reach it
    const req = makeRequest("/api/health")
    const res = await proxy(req)
    expect(res.headers.get("location")).toBeNull()
    expect(res.status).toBe(200)
  })
})

describe("Middleware config.matcher — PWA static assets exemption", () => {
  // The matcher controls which paths Next.js passes to proxy(). Paths that do NOT
  // match the regex are served directly (public/ files, sw.js, manifest.webmanifest)
  // without going through the auth guard. These tests verify the exclusion list.

  // Build the negative-lookahead exclusion set from the compiled config.matcher pattern.
  // Pattern format: /((?!<exclusions>).*)
  function getExclusions(): string[] {
    const [pattern] = config.matcher
    const m = pattern.match(/\(\?!([^)]+)\)/)
    if (!m) throw new Error("matcher pattern has unexpected format")
    return m[1].split("|").map((e) => e.replace(/\\\./g, "."))
  }

  function isExcluded(assetName: string): boolean {
    return getExclusions().some((exc) => {
      // exc may be a prefix like "_next/static" or an exact name like "sw.js"
      return assetName === exc || assetName.startsWith(exc)
    })
  }

  it("excludes manifest.webmanifest", () => {
    expect(isExcluded("manifest.webmanifest")).toBe(true)
  })

  it("excludes sw.js", () => {
    expect(isExcluded("sw.js")).toBe(true)
  })

  it("excludes favicon.ico", () => {
    expect(isExcluded("favicon.ico")).toBe(true)
  })

  it("excludes icon.svg", () => {
    expect(isExcluded("icon.svg")).toBe(true)
  })

  it("excludes _next/static prefix", () => {
    expect(isExcluded("_next/static")).toBe(true)
    expect(isExcluded("_next/static/chunks/main.js")).toBe(true)
  })

  it("does not exclude regular page paths", () => {
    expect(isExcluded("")).toBe(false)
    expect(isExcluded("entry/some-entry")).toBe(false)
    expect(isExcluded("api/entries")).toBe(false)
  })
})

describe("Auth-Redirect Guard — unauthenticated requests", () => {
  const originalSecret = process.env.SESSION_SECRET

  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-at-least-32-characters-long-for-iron"
  })

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET
    } else {
      process.env.SESSION_SECRET = originalSecret
    }
  })

  it("redirects unauthenticated page request to /login", async () => {
    const req = makeRequest("/")
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toMatch(/\/login/)
  })

  it("preserves the original path in ?from= param for non-root pages", async () => {
    const req = makeRequest("/entries/2024-01-01")
    const res = await proxy(req)
    expect(res.status).toBe(307)
    const location = res.headers.get("location") ?? ""
    expect(location).toMatch(/from=/)
  })

  it("returns 401 JSON for unauthenticated API request (no HTML redirect)", async () => {
    const req = makeRequest("/api/entries")
    const res = await proxy(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty("error")
  })

  it("returns 401 for tampered/invalid session cookie on API route", async () => {
    const req = makeRequestWithCookie("/api/entries", "mpj_session", "invalid-tampered-cookie")
    const res = await proxy(req)
    expect(res.status).toBe(401)
  })

  it("redirects page request with tampered session cookie to /login", async () => {
    const req = makeRequestWithCookie("/", "mpj_session", "invalid-tampered-cookie")
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toMatch(/\/login/)
  })
})

describe("Auth-Redirect Guard — missing SESSION_SECRET", () => {
  const originalSecret = process.env.SESSION_SECRET

  beforeEach(() => {
    delete process.env.SESSION_SECRET
  })

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.SESSION_SECRET = originalSecret
    }
  })

  it("returns 500 for API routes when SESSION_SECRET is missing", async () => {
    const req = makeRequest("/api/entries")
    const res = await proxy(req)
    expect(res.status).toBe(500)
  })

  it("redirects page routes to /login when SESSION_SECRET is missing", async () => {
    const req = makeRequest("/")
    const res = await proxy(req)
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toMatch(/\/login/)
  })
})
