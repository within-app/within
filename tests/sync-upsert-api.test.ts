/**
 * POST /api/sync/upsert route tests.
 * Synthetic data only (Constraint D).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db/sync", () => ({
  upsertEntries: vi.fn(),
}))

import { upsertEntries } from "../src/lib/db/sync"
import { POST } from "../src/app/api/sync/upsert/route"
import { NextRequest } from "next/server"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID   = "20000000-0000-4000-8000-000000000001"
const REV_ID     = "30000000-0000-4000-8000-000000000001"

function makeSyncEntry(id = ENTRY_ID) {
  return { id, journalId: JOURNAL_ID, text: "Synthetic entry", createdAt: "2026-06-01T10:00:00.000Z", updatedAt: "2026-06-15T10:00:00.000Z", revisionId: REV_ID, starred: false, tags: [], locationName: null, locationLat: null, locationLng: null, weatherDescription: null, weatherTempCelsius: null, weatherIcon: null, deletedAt: null, thumbnailDataUrl: null }
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/sync/upsert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

describe("POST /api/sync/upsert", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(upsertEntries).mockReset()
  })

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/sync/upsert", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" })
    expect((await POST(req)).status).toBe(400)
  })

  it("returns 400 when entries array is empty", async () => {
    expect((await POST(makeRequest({ entries: [] }))).status).toBe(400)
  })

  it("returns 400 when entry is missing required fields", async () => {
    expect((await POST(makeRequest({ entries: [{ id: "bad" }] }))).status).toBe(400)
  })

  it("returns 200 with accepted list on success", async () => {
    vi.mocked(upsertEntries).mockResolvedValueOnce({ accepted: [ENTRY_ID], conflicts: [] })
    const res = await POST(makeRequest({ entries: [makeSyncEntry()] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accepted).toContain(ENTRY_ID)
  })

  it("returns 200 with conflicts list when server wins", async () => {
    vi.mocked(upsertEntries).mockResolvedValueOnce({ accepted: [], conflicts: [{ entryId: ENTRY_ID, serverVersion: makeSyncEntry() }] })
    const res = await POST(makeRequest({ entries: [makeSyncEntry()] }))
    expect(res.status).toBe(200)
    expect((await res.json()).conflicts[0].entryId).toBe(ENTRY_ID)
  })

  it("returns 503 when DATABASE_URL is not set", async () => {
    vi.unstubAllEnvs()
    expect((await POST(makeRequest({ entries: [makeSyncEntry()] }))).status).toBe(503)
  })

  it("returns 503 when upsertEntries throws", async () => {
    vi.mocked(upsertEntries).mockRejectedValueOnce(new Error("DB error"))
    expect((await POST(makeRequest({ entries: [makeSyncEntry()] }))).status).toBe(503)
  })
})
