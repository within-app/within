/**
 * GET /api/sync/changes route tests.
 * Synthetic data only (Constraint D).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db/sync", () => ({
  getChangesSince: vi.fn(),
}))

import { getChangesSince } from "../src/lib/db/sync"
import { GET } from "../src/app/api/sync/changes/route"
import { NextRequest } from "next/server"

const SINCE = "2026-01-01T00:00:00.000Z"
const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/sync/changes")
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return new NextRequest(url)
}

describe("GET /api/sync/changes", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(getChangesSince).mockReset()
  })

  it("returns 400 when `since` is missing (validation)", async () => {
    expect((await GET(makeRequest({}))).status).toBe(400)
  })

  it("returns 400 when `since` is not a valid datetime (validation)", async () => {
    expect((await GET(makeRequest({ since: "not-a-date" }))).status).toBe(400)
  })

  it("returns 200 with page from getChangesSince", async () => {
    vi.mocked(getChangesSince).mockResolvedValueOnce({ entries: [], nextCursor: null, serverTime: "2026-07-04T12:00:00.000Z" })
    const res = await GET(makeRequest({ since: SINCE }))
    expect(res.status).toBe(200)
    expect((await res.json()).serverTime).toBe("2026-07-04T12:00:00.000Z")
  })

  it("passes journalId to getChangesSince when provided", async () => {
    vi.mocked(getChangesSince).mockResolvedValueOnce({ entries: [], nextCursor: null, serverTime: "" })
    await GET(makeRequest({ since: SINCE, journalId: JOURNAL_ID }))
    expect(getChangesSince).toHaveBeenCalledWith(SINCE, JOURNAL_ID, null, 50)
  })

  it("returns 503 when DATABASE_URL is not set", async () => {
    vi.unstubAllEnvs()
    expect((await GET(makeRequest({ since: SINCE }))).status).toBe(503)
  })

  it("returns 503 when getChangesSince throws", async () => {
    vi.mocked(getChangesSince).mockRejectedValueOnce(new Error("DB down"))
    expect((await GET(makeRequest({ since: SINCE }))).status).toBe(503)
  })
})
