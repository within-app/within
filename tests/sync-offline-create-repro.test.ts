/**
 * Diagnostic: buildQueuedEdit() payload validates against POST /api/sync/upsert.
 *
 * Purpose: confirm the Zod schema in the upsert route accepts the exact payload
 * shape that the editor produces via buildQueuedEdit(). If this test FAILS on
 * current main it means the root cause of the split-brain is a validation gap;
 * if it passes the bug is client-side (sync hook scope, error visibility, etc.).
 *
 * This test is expected to be GREEN — it proves the server-side contract is fine
 * and points the investigation to the client fixes (F1–F4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db/sync", () => ({
  upsertEntries: vi.fn(),
}))

import { upsertEntries } from "../src/lib/db/sync"
import { POST } from "../src/app/api/sync/upsert/route"
import { NextRequest } from "next/server"
import { buildQueuedEdit } from "../src/lib/sync/queue-edit"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID   = "20000000-0000-4000-8000-000000000099"

/** Realistic editor payload matching buildPayload() in entry-editor.tsx */
const realisticEditorPayload = {
  text: "Diagnostischer Offline-Eintrag",
  journalId: JOURNAL_ID,
  createdAt: "2026-07-26T18:00:00.000Z",
  starred: false,
  tags: [],
  photos: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
}

describe("diagnostic — buildQueuedEdit payload validates on server", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(upsertEntries).mockReset()
  })

  it("buildQueuedEdit() with realistic editor payload produces a valid upsert body", async () => {
    const edit = buildQueuedEdit({
      entryId: ENTRY_ID,
      payload: realisticEditorPayload,
      queuedAt: "2026-07-26T18:00:00.000Z",
    })

    expect(edit.payload).not.toBeNull()
    const entry = edit.payload!

    // Confirm the payload has all required SyncEntry fields
    expect(entry.id).toBe(ENTRY_ID)
    expect(entry.journalId).toBe(JOURNAL_ID)
    expect(entry.tags).toEqual([])
    expect(entry.locationName).toBeNull()
    expect(entry.deletedAt).toBeNull()

    // POST to the route with this exact payload
    vi.mocked(upsertEntries).mockResolvedValueOnce({ accepted: [ENTRY_ID], conflicts: [] })

    const body = { entries: [entry] }
    const req = new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const res = await POST(req)

    // Must be 200 — Zod schema accepts the payload
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.accepted).toContain(ENTRY_ID)
  })

  it("buildQueuedEdit() with tags produces a valid upsert body", async () => {
    const edit = buildQueuedEdit({
      payload: { ...realisticEditorPayload, tags: ["Reise", "Notiz"] },
      queuedAt: "2026-07-26T18:00:00.000Z",
    })

    vi.mocked(upsertEntries).mockResolvedValueOnce({ accepted: [edit.entryId], conflicts: [] })

    const req = new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [edit.payload] }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it("create-flow (no entryId supplied) produces a valid upsert body", async () => {
    const edit = buildQueuedEdit({
      payload: realisticEditorPayload,
      queuedAt: "2026-07-26T18:00:00.000Z",
    })

    expect(edit.operation).toBe("create")
    expect(edit.entryId).toMatch(/^[0-9a-f-]{36}$/)

    vi.mocked(upsertEntries).mockResolvedValueOnce({ accepted: [edit.entryId], conflicts: [] })

    const req = new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [edit.payload] }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })
})
