/**
 * Timeline month-jump: `before` query parameter
 *
 * Tests:
 * 1. Schema: `before=YYYY-MM` is accepted; invalid formats return 400.
 * 2. API: valid `before` param is forwarded to listEntries / the DB query.
 * 3. DB layer: `listEntries` passes `before` at the correct position in both
 *    the count query and the data query.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// ── Schema unit tests ──────────────────────────────────────────────────────

import { EntryQuerySchema } from "../src/lib/schemas/entry.schema"

describe("EntryQuerySchema — before field", () => {
  it("accepts a valid YYYY-MM value", () => {
    const result = EntryQuerySchema.safeParse({ before: "2024-03" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.before).toBe("2024-03")
  })

  it("accepts before=2000-01 (boundary)", () => {
    const result = EntryQuerySchema.safeParse({ before: "2000-01" })
    expect(result.success).toBe(true)
  })

  it("rejects YYYY-MM-DD (date, not month)", () => {
    const result = EntryQuerySchema.safeParse({ before: "2024-03-15" })
    expect(result.success).toBe(false)
  })

  it("rejects MM-YYYY (wrong order)", () => {
    const result = EntryQuerySchema.safeParse({ before: "03-2024" })
    expect(result.success).toBe(false)
  })

  it("rejects free text", () => {
    const result = EntryQuerySchema.safeParse({ before: "März 2024" })
    expect(result.success).toBe(false)
  })

  it("is optional — omitting it parses fine with before=undefined", () => {
    const result = EntryQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.before).toBeUndefined()
  })
})

// ── API route tests ────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
  },
}))

describe("GET /api/entries — before param", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
    vi.resetModules()
  })

  it("returns 400 when before has an invalid format", async () => {
    const { GET } = await import("../src/app/api/entries/route")
    const req = new NextRequest(
      new URL("http://localhost/api/entries?before=notadate")
    )
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it("passes before to db.query when a valid YYYY-MM is supplied", async () => {
    const { db } = await import("@/lib/db")
    const mockQuery = vi.mocked(db.query)

    // count query + data query both always run in listEntries
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ total: 0 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }))
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }))

    const { GET } = await import("../src/app/api/entries/route")
    const req = new NextRequest(
      new URL("http://localhost/api/entries?before=2024-03")
    )
    await GET(req)

    expect(mockQuery).toHaveBeenCalledTimes(2)
    // Count query (first call) params must include "2024-03"
    const countParams = mockQuery.mock.calls[0][1] as unknown[]
    expect(countParams).toContain("2024-03")
  })

  it("omits before param from DB query when not provided", async () => {
    const { db } = await import("@/lib/db")
    const mockQuery = vi.mocked(db.query)

    mockQuery.mockImplementationOnce(async () => ({ rows: [{ total: 0 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }))
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }))

    const { GET } = await import("../src/app/api/entries/route")
    const req = new NextRequest(
      new URL("http://localhost/api/entries")
    )
    await GET(req)

    const countParams = mockQuery.mock.calls[0][1] as unknown[]
    // before should be null (not a string) when omitted — second-to-last
    // param (Zeitzone P2 hängt die App-Zone als letzten Parameter an)
    const beforeParam = countParams[countParams.length - 2]
    expect(beforeParam).toBeNull()
  })
})

// ── listEntries DB layer tests ─────────────────────────────────────────────

describe("listEntries — before param SQL position", () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
  })

  it("includes before in the count query params at the last position", async () => {
    const { db } = await import("@/lib/db")
    const mockQuery = vi.mocked(db.query)

    // count query
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ total: 0 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }))
    // data query (won't be called when total=0, but set up anyway)
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }))

    const { listEntries } = await import("../src/lib/db/entries")
    await listEntries({
      journalId: null,
      date: null,
      onThisDay: null,
      year: null,
      before: "2024-03",
      searchQuery: null,
      tags: null,
      starred: null,
      mediaType: null,
      page: 1,
      perPage: 25,
    })

    const countCallParams = mockQuery.mock.calls[0][1] as unknown[]
    // before is second-to-last in count params: [journalId, date, onThisDay,
    // year, searchQuery, tags, starred, mediaType, before, tz] — die App-Zone
    // (Zeitzone P2) ist der neue letzte Parameter.
    expect(countCallParams[countCallParams.length - 2]).toBe("2024-03")
  })

  it("count SQL includes the before date-range clause", async () => {
    const { db } = await import("@/lib/db")
    const mockQuery = vi.mocked(db.query)

    mockQuery.mockImplementationOnce(async () => ({ rows: [{ total: 2 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }))
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }))

    const { listEntries } = await import("../src/lib/db/entries")
    await listEntries({
      journalId: null,
      date: null,
      onThisDay: null,
      year: null,
      before: "2024-03",
      searchQuery: null,
      tags: null,
      starred: null,
      mediaType: null,
      page: 1,
      perPage: 25,
    })

    const countSql = mockQuery.mock.calls[0][0] as string
    // SQL must filter entries that are strictly before the start of next month
    expect(countSql).toMatch(/e\.created_at\s*</)
    expect(countSql).toMatch(/INTERVAL '1 month'/)
  })

  it("passes null for before when not provided — no date restriction", async () => {
    const { db } = await import("@/lib/db")
    const mockQuery = vi.mocked(db.query)

    mockQuery.mockImplementationOnce(async () => ({ rows: [{ total: 0 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }))
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }))

    const { listEntries } = await import("../src/lib/db/entries")
    await listEntries({
      journalId: null,
      date: null,
      onThisDay: null,
      year: null,
      before: null,
      searchQuery: null,
      tags: null,
      starred: null,
      mediaType: null,
      page: 1,
      perPage: 25,
    })

    const countCallParams = mockQuery.mock.calls[0][1] as unknown[]
    expect(countCallParams[countCallParams.length - 2]).toBeNull()
  })
})
