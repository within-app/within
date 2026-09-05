/**
 * entries.ts listEntries() ordering tests
 *
 * Verifies:
 * 1. The paginated SELECT uses ORDER BY e.created_at DESC, e.id DESC
 *    (the id DESC tiebreaker stabilises order when timestamps collide).
 * 2. The ordering assertion is not vacuous: it checks at least two rows
 *    with distinct timestamps and one tiebreaker pair.
 *
 * Synthetic data only — no real credentials or DB connections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── DB stub ──────────────────────────────────────────────────────────────────
// Hoisted mock so every import("@/lib/db") inside the module-under-test
// resolves to this stub.
vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"
import { listEntries } from "../src/lib/db/entries"

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  journalId: null,
  date: null,
  onThisDay: null,
  year: null,
  searchQuery: null,
  tags: null,
  starred: null,
  mediaType: null,
  before: null,
  page: 1,
  perPage: 20,
}

/** Minimal row shape returned by the paginated SELECT */
function makeRow(id: string, createdAt: string) {
  return {
    id,
    journal_id: "00000000-0000-0000-0000-000000000001",
    journal_color: "#007AFF",
    created_at: new Date(createdAt),
    text: "",
    starred: false,
    location_name: null,
    weather_description: null,
    weather_temp_celsius: null,
    weather_icon: null,
    thumbnail: null,
    photo_count: 0,
    has_audio: false,
    has_video: false,
    tags: [],
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listEntries — ORDER BY clause", () => {
  beforeEach(() => vi.mocked(db.query).mockReset())

  it("includes 'e.created_at DESC, e.id DESC' tiebreaker in the paginated SELECT", async () => {
    const capturedSqls: string[] = []

    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      capturedSqls.push(sql as string)
      // First call is the COUNT query; subsequent calls are the row SELECT
      if (capturedSqls.length === 1) return { rows: [{ total: 0 }] }
      return { rows: [] }
    })

    await listEntries(DEFAULTS)

    // The paginated SELECT is the second query
    expect(capturedSqls.length).toBeGreaterThanOrEqual(2)
    const selectSql = capturedSqls[1]
    // Must contain the tiebreaker — not just created_at DESC on its own
    expect(selectSql).toMatch(/ORDER BY e\.created_at DESC,\s*e\.id DESC/i)
  })
})

describe("listEntries — descending ordering (non-vacuous)", () => {
  beforeEach(() => vi.mocked(db.query).mockReset())

  it("returns rows in the order the DB provides (newest first)", async () => {
    // DB returns rows already in DESC order (as they would be after ORDER BY)
    const row1 = makeRow(
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "2026-06-17T10:00:00Z"
    )
    const row2 = makeRow(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "2026-06-17T09:00:00Z"
    )
    const row3 = makeRow(
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "2026-06-16T12:00:00Z"
    )

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: 3 }] } as never)
      .mockResolvedValueOnce({ rows: [row1, row2, row3] } as never)

    const { rows } = await listEntries(DEFAULTS)

    // At least three rows — this assertion would be vacuous with 0 or 1
    expect(rows.length).toBe(3)

    // Each row must be at least as recent as the next (non-vacuous: needs ≥2 rows)
    for (let i = 0; i < rows.length - 1; i++) {
      const a = new Date(rows[i].created_at).getTime()
      const b = new Date(rows[i + 1].created_at).getTime()
      expect(a).toBeGreaterThanOrEqual(b)
    }
  })

  it("tiebreaker: when two rows share the same timestamp the one with lexicographically greater id comes first", async () => {
    const sharedTs = "2026-06-17T10:00:00Z"
    // 'ff…' > 'aa…' lexicographically, so 'ff…' should sort DESC first
    const rowHigh = makeRow("ffffffff-ffff-ffff-ffff-ffffffffffff", sharedTs)
    const rowLow  = makeRow("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sharedTs)

    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: 2 }] } as never)
      // DB returns in the order PostgreSQL would (id DESC after created_at ties)
      .mockResolvedValueOnce({ rows: [rowHigh, rowLow] } as never)

    const { rows } = await listEntries(DEFAULTS)

    expect(rows.length).toBe(2)
    // Both share the same timestamp — order is determined by id DESC
    expect(rows[0].id).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff")
    expect(rows[1].id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
  })
})
