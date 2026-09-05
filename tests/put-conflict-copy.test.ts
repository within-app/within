/**
 * PUT /api/entries/[id] must save a conflict copy when
 * clientRevisionId is provided and differs from the server's current revision_id.
 *
 * Acceptance:
 *  1. No clientRevisionId supplied → backward-compatible, no conflict SELECT, no conflict copy.
 *  2. clientRevisionId matches server → no conflict copy, normal update.
 *  3. clientRevisionId differs from server → INSERT INTO sync_conflict_copies, then normal update.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const ENTRY_ID    = "00000000-0000-4000-8000-000000000099"
const JOURNAL_ID  = "00000000-0000-4000-8000-000000000001"
const SERVER_REV  = "aaaaaaaa-0000-4000-8000-000000000000"
const CLIENT_REV  = "bbbbbbbb-0000-4000-8000-000000000000"   // different → conflict
const SERVER_NOW  = new Date("2024-06-01T12:00:00.000Z")

const BASE_BODY = {
  journalId: JOURNAL_ID,
  text: "Synthetic update — conflict copy test",
  createdAt: "2024-01-01T00:00:00.000Z",
  starred: false,
  tags: [],
}

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    new URL(`http://localhost:3000/api/entries/${ENTRY_ID}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function makeParams() {
  return { params: Promise.resolve({ id: ENTRY_ID }) }
}

/** Returns a row as the server would return for the existing entry. */
function serverEntryRow(revisionId: string) {
  return {
    revision_id: revisionId,
    updated_at: new Date("2024-05-30T10:00:00.000Z"),
    text: "Original server text",
    created_at: new Date("2024-01-01T00:00:00.000Z"),
    starred: false,
    location_name: null,
    location_lat: null,
    location_lng: null,
    tags: [],
  }
}

describe("PUT /api/entries/[id] — conflict copy", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.resetModules()
  })

  // ─── 1. No clientRevisionId → backward-compatible path ──────────────────

  it("does not do a conflict-detection SELECT when clientRevisionId is absent", async () => {
    const { db } = await import("@/lib/db")
    const queriedSqls: string[] = []

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        queriedSqls.push(sql.trim())
        const s = sql.trim()
        if (s === "BEGIN" || s === "COMMIT") return { rows: [] }
        if (s.includes("UPDATE entries"))   return { rows: [] }
        if (s.includes("DELETE FROM entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const res = await PUT(makeRequest(BASE_BODY), makeParams())

    expect(res.status).toBe(200)
    const selectConflict = queriedSqls.find(
      (s) => s.includes("FROM entries e") && s.includes("revision_id")
    )
    expect(selectConflict).toBeUndefined()
    const conflictInsert = queriedSqls.find((s) =>
      s.includes("INSERT INTO sync_conflict_copies")
    )
    expect(conflictInsert).toBeUndefined()
  })

  // ─── 2. clientRevisionId matches server → no conflict copy ──────────────

  it("does not insert a conflict copy when clientRevisionId matches server revision", async () => {
    const { db } = await import("@/lib/db")
    let conflictCopyInserted = false
    const { rows: _serverNowRows } = { rows: [{ server_now: SERVER_NOW }] }

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN" || s === "COMMIT") return { rows: [] }
        // Conflict-detection SELECT — return entry with SAME revision as client
        if (s.includes("FROM entries e") && s.includes("revision_id")) {
          return { rows: [serverEntryRow(SERVER_REV)] }
        }
        // Server time SELECT (if implemented as a separate query)
        if (s.includes("SELECT NOW()")) {
          return { rows: [{ server_now: SERVER_NOW }] }
        }
        if (s.includes("INSERT INTO sync_conflict_copies")) {
          conflictCopyInserted = true
          return { rows: [] }
        }
        if (s.includes("UPDATE entries"))    return { rows: [] }
        if (s.includes("DELETE FROM entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const res = await PUT(
      makeRequest({ ...BASE_BODY, clientRevisionId: SERVER_REV }),  // same as server
      makeParams()
    )

    expect(res.status).toBe(200)
    expect(conflictCopyInserted).toBe(false)
  })

  // ─── 3. clientRevisionId differs → conflict copy saved ──────────────────

  it("inserts a conflict copy before updating when clientRevisionId differs from server revision", async () => {
    const { db } = await import("@/lib/db")
    let conflictCopyInserted = false
    let conflictCopyBeforeUpdate = false
    let updateCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN" || s === "COMMIT") return { rows: [] }
        // Server time SELECT
        if (s.includes("SELECT NOW()")) {
          return { rows: [{ server_now: SERVER_NOW }] }
        }
        // Conflict-detection SELECT — return entry with DIFFERENT revision than client
        if (s.includes("FROM entries e") && s.includes("revision_id")) {
          return { rows: [serverEntryRow(SERVER_REV)] }  // SERVER_REV ≠ CLIENT_REV
        }
        if (s.includes("INSERT INTO sync_conflict_copies")) {
          conflictCopyInserted = true
          conflictCopyBeforeUpdate = !updateCalled
          return { rows: [] }
        }
        if (s.includes("UPDATE entries")) {
          updateCalled = true
          return { rows: [] }
        }
        if (s.includes("DELETE FROM entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const res = await PUT(
      makeRequest({ ...BASE_BODY, clientRevisionId: CLIENT_REV }),  // differs from SERVER_REV
      makeParams()
    )

    expect(res.status).toBe(200)
    expect(conflictCopyInserted).toBe(true)
    expect(conflictCopyBeforeUpdate).toBe(true)   // conflict copy saved BEFORE update
    expect(updateCalled).toBe(true)
  })

  // ─── 4. entry not found (with clientRevisionId) → 404 ──────────────────

  it("returns 404 when the entry does not exist and clientRevisionId is supplied", async () => {
    const { db } = await import("@/lib/db")

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN" || s === "ROLLBACK") return { rows: [] }
        if (s.includes("FROM entries e") && s.includes("revision_id")) {
          return { rows: [] }   // entry not found
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const res = await PUT(
      makeRequest({ ...BASE_BODY, clientRevisionId: CLIENT_REV }),
      makeParams()
    )

    expect(res.status).toBe(404)
  })
})
