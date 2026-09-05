/**
 * i18n PR1 — /api/settings route: locale validation + no-DB dev behaviour.
 *
 * Runs without DATABASE_URL (vitest env), which exercises the mock-fallback
 * path; the DB upsert path is covered by the deployed smoke test.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { NextRequest } from "next/server"
import { GET, PUT } from "@/app/api/settings/route"

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL

function putRequest(body: string): NextRequest {
  return new NextRequest("http://test.local/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  })
}

beforeEach(() => {
  delete process.env.DATABASE_URL
})

afterAll(() => {
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
})

describe("GET /api/settings (no DB configured)", () => {
  it("answers an honest 503 (no mock fallback)", async () => {
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("db_unavailable")
  })
})

describe("PUT /api/settings", () => {
  it("rejects invalid JSON with a stable error code", async () => {
    const res = await PUT(putRequest("{nope"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("invalid_json")
  })

  it("rejects an unsupported locale", async () => {
    const res = await PUT(putRequest(JSON.stringify({ locale: "es" })))
    expect(res.status).toBe(400)
  })

  it("accepts each supported locale but answers 503 without a database (no mock echo)", async () => {
    for (const locale of ["de", "en", "fr"]) {
      const res = await PUT(putRequest(JSON.stringify({ locale })))
      expect(res.status).toBe(503)
    }
  })
})
