/**
 * Sargable date-range queries
 *
 * Calendar route must use a raw created_at range comparison
 *         (>= / <) instead of wrapping the column in TO_CHAR/DATE_TRUNC,
 *         so the existing created_at indexes are usable.
 *
 * Stats route streak query must bound the scan to the last 3650 days
 *         (matching the JS loop ceiling) instead of scanning the whole table.
 *
 * Synthetic data only — no real DB connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"

// ── Calendar sargable range ──────────────────────────────────────────────────

describe("GET /api/calendar — sargable date range", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("sends a sargable range predicate (>= / <) not a TO_CHAR/DATE_TRUNC wrap", async () => {
    const capturedSql: string[] = []

    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      capturedSql.push(sql as string)
      return { rows: [] }
    })

    const { GET } = await import("../src/app/api/calendar/route")
    const req = new NextRequest(
      "http://localhost/api/calendar?from=2026-01&to=2026-02"
    )
    const res = await GET(req)
    expect(res.status).toBe(200)

    expect(capturedSql.length).toBeGreaterThanOrEqual(1)
    const sql = capturedSql[0]

    // Must NOT use the non-sargable pattern
    expect(sql).not.toMatch(/TO_CHAR\s*\(/i)
    expect(sql).not.toMatch(/DATE_TRUNC\s*\(/i)
    expect(sql).not.toMatch(/BETWEEN\s+\$1\s+AND\s+\$2/i)

    // Must use a sargable range on the raw column
    expect(sql).toMatch(/e\.created_at\s*>=/i)
    expect(sql).toMatch(/e\.created_at\s*</i)
  })

  it("returns correct CalendarData shape for a row from the DB", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ day: "2026-01-15", count: 3, thumbnail: null }],
    } as never)

    const { GET } = await import("../src/app/api/calendar/route")
    const req = new NextRequest(
      "http://localhost/api/calendar?from=2026-01&to=2026-01"
    )
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["2026-01-15"]).toEqual({ count: 3 })
  })
})

// ── Stats streak bounded scan ─────────────────────────────────────────────────

describe("GET /api/stats — streak scan bounded to 3650 days", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("includes '3650 days' interval in the streak days query", async () => {
    const capturedSqls: string[] = []

    // Single CTE query fires one db.query call; mock returns a valid combined row.
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      capturedSqls.push(sql as string)
      return {
        rows: [{
          total_entries: 0,
          total_days: 0,
          on_this_day: 0,
          total_media: 0,
          total_countries: 0,
          streak_days: [],
        }],
      }
    })

    const { GET } = await import("../src/app/api/stats/route")
    const req = new NextRequest("http://localhost/api/stats")
    const res = await GET(req)
    expect(res.status).toBe(200)

    // The single CTE query embeds the streak subquery — check the combined SQL.
    expect(capturedSqls.length).toBe(1)
    const sql = capturedSqls[0]
    // Must contain the 3650-day bound matching the JS loop ceiling
    expect(sql).toMatch(/3650\s+days/i)
    // Must NOT omit a time-bound (the old query had no created_at filter beyond journalId)
    expect(sql).toMatch(/created_at\s*>=/i)
    // Streak days collected via DISTINCT DATE subquery inside streak_days CTE
    expect(sql).toMatch(/SELECT DISTINCT DATE/i)
  })

  it("calculates streak correctly from bounded day set", async () => {
    // Provide 3 consecutive days ending today so streak = 3
    const today = new Date()
    const days = [0, 1, 2].map((offset) => {
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - offset)
      return d.toISOString().slice(0, 10)
    })

    // Single CTE query returns a combined row; streak_days is an array of date strings.
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{
        total_entries: 5,
        total_days: 3,
        on_this_day: 1,
        total_media: 2,
        total_countries: 0,
        streak_days: days,
      }],
    } as never)

    const { GET } = await import("../src/app/api/stats/route")
    const req = new NextRequest("http://localhost/api/stats")
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { streak: number }
    expect(body.streak).toBe(3)
  })
})
