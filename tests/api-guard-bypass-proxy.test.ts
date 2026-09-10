/**
 * /api/upload and /api/import bypass the proxy matcher: with Node middleware
 * Next clones every non-GET body into memory (cloneBodyStream + finalize in
 * next-server.js) BEFORE the route handler runs — a 100 MB video became 100 MB
 * of off-heap buffers regardless of how the route streams. The two routes
 * therefore run session check + API rate limit themselves, through the same
 * functions the proxy uses (src/lib/request-guard.ts): same 401/429/500
 * bodies, same limits (the production build gives the routes their own
 * bucket — the middleware is a separate module layer — so proxy coupling is
 * deliberately not asserted here).
 *
 * Synthetic data only — no real credentials or journal content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { sealData } from "iron-session"
import { SESSION_COOKIE_NAME } from "@/lib/session"
import { resetStore } from "@/lib/rate-limiter"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() } }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock("@/lib/video-thumbnail", () => ({
  extractPoster: vi.fn(), generateLoopClip: vi.fn(), probeDuration: vi.fn(), probeMediaStreams: vi.fn(),
}))

const { POST: uploadPost } = await import("@/app/api/upload/route")
const { POST: importPost } = await import("@/app/api/import/route")

const SECRET = "test-secret-at-least-32-characters-long-for-iron"
const ENV = { ...process.env }

async function validCookie(): Promise<string> {
  const sealed = await sealData({ authenticated: true, expiresAt: Date.now() + 60_000 }, { password: SECRET })
  return `${SESSION_COOKIE_NAME}=${sealed}`
}

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers })
}

beforeEach(() => {
  resetStore()
  process.env.SESSION_SECRET = SECRET
  delete process.env.DATABASE_URL
  delete process.env.TRUSTED_PROXY_COUNT
  delete process.env.RATE_LIMIT_API_MAX
})
afterEach(() => { process.env = { ...ENV } })

describe("session check inside the routes (a)", () => {
  it("/api/upload without a session cookie → 401 unauthorized, like the proxy", async () => {
    const res = await uploadPost(req("/api/upload"))
    expect(res.status).toBe(401)
    expect((await res.json() as { code: string }).code).toBe("unauthorized")
  })

  it("/api/import without a session cookie → 401 unauthorized", async () => {
    const res = await importPost(req("/api/import"))
    expect(res.status).toBe(401)
    expect((await res.json() as { code: string }).code).toBe("unauthorized")
  })

  it("a tampered cookie is 401 as well", async () => {
    const res = await uploadPost(req("/api/upload", { cookie: `${SESSION_COOKIE_NAME}=garbage` }))
    expect(res.status).toBe(401)
  })

  it("a valid session passes into the handlers (upload: 400 for the missing type, import: 503 without DB)", async () => {
    const cookie = await validCookie()
    const up = await uploadPost(req("/api/upload", { cookie }))
    expect(up.status).toBe(400)
    expect((await up.json() as { code: string }).code).toBe("file_type_not_allowed")
    const im = await importPost(req("/api/import", { cookie }))
    expect(im.status).toBe(503)
    expect((await im.json() as { code: string }).code).toBe("import_no_db")
  })

  it("missing SESSION_SECRET → 500 config_session_secret_missing, like the proxy's API branch", async () => {
    delete process.env.SESSION_SECRET
    const res = await uploadPost(req("/api/upload", { cookie: await validCookie() }))
    expect(res.status).toBe(500)
    expect((await res.json() as { code: string }).code).toBe("config_session_secret_missing")
  })
})

describe("the routes enforce the API rate limit themselves (b)", () => {
  it("upload: the request over RATE_LIMIT_API_MAX answers 429 rate_limited with Retry-After", async () => {
    process.env.RATE_LIMIT_API_MAX = "2"
    const cookie = await validCookie()
    await uploadPost(req("/api/upload", { cookie }))
    await uploadPost(req("/api/upload", { cookie }))
    const res = await uploadPost(req("/api/upload", { cookie }))
    expect(res.status).toBe(429)
    expect((await res.json() as { code: string }).code).toBe("rate_limited")
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/)
  })

  it("import: same limit, same bucket type as upload", async () => {
    process.env.RATE_LIMIT_API_MAX = "2"
    const cookie = await validCookie()
    await uploadPost(req("/api/upload", { cookie }))
    await importPost(req("/api/import", { cookie }))
    const res = await importPost(req("/api/import", { cookie }))
    expect(res.status).toBe(429)
  })

  it("rate limit is checked before the session, like the proxy", async () => {
    process.env.RATE_LIMIT_API_MAX = "1"
    await uploadPost(req("/api/upload"))
    const res = await uploadPost(req("/api/upload"))
    expect(res.status).toBe(429)
  })
})
