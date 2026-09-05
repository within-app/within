/**
 * Übersicht-Zahlen veraltet, Beifang derselben
 * Fehlerklasse: Lese-Routen, die entries ohne deleted_at-Filter abfragen und
 * damit Soft-Delete-Tombstones ausliefern.
 *
 * Guard über den SQL-Text (Muster: query-sargability.test.ts) — jede Query
 * dieser Routen, die entries berührt, muss auf deleted_at IS NULL filtern.
 * Die inhaltliche Verifikation gegen echtes Postgres liegt für die Hauptroute
 * in stats-tombstone.test.ts. Synthetic data only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Bestand-Flake-Klasse: unter Parallel-Last (testcontainers gleichzeitig)
// zahlt der erste Test einer Datei den Modul-Import und reißt das 5s-Limit.
// Die Tests hier sind reine Mock-Tests — großzügiges Limit statt Flake.
vi.setConfig({ testTimeout: 20_000 })

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"

const TOMBSTONE_FILTER = /deleted_at\s+IS\s+NULL/i

function captureQueries() {
  const captured: string[] = []
  vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
    captured.push(sql as string)
    // Count queries need a row to destructure; everything else copes with [].
    if (/COUNT\(\*\)::int AS total\b/.test(sql as string)) {
      return { rows: [{ total: 0 }] }
    }
    return { rows: [] }
  })
  return captured
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  vi.mocked(db.query).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("read routes filter soft-deleted entries (deleted_at IS NULL)", () => {
  it("GET /api/calendar", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/calendar/route")
    const res = await GET(new NextRequest("http://localhost/api/calendar?from=2026-01&to=2026-02"))
    expect(res.status).toBe(200)
    const entriesQueries = captured.filter((q) => /FROM entries/i.test(q))
    expect(entriesQueries.length).toBeGreaterThanOrEqual(1)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/locations", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/locations/route")
    const res = await GET(new NextRequest("http://localhost/api/locations"))
    expect(res.status).toBe(200)
    const entriesQueries = captured.filter((q) => /FROM entries/i.test(q))
    expect(entriesQueries.length).toBeGreaterThanOrEqual(1)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/media — count and page query", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/media/route")
    const res = await GET(new NextRequest("http://localhost/api/media"))
    expect(res.status).toBe(200)
    const entriesQueries = captured.filter((q) => /JOIN entries/i.test(q))
    expect(entriesQueries.length).toBe(2)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/media/preview-stats", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/media/preview-stats/route")
    const res = await GET(new NextRequest("http://localhost/api/media/preview-stats"))
    expect(res.status).toBe(200)
    expect(captured.length).toBeGreaterThanOrEqual(1)
    for (const q of captured) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/journals — entry_count", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/journals/route")
    const res = await GET()
    expect(res.status).toBe(200)
    const entriesQueries = captured.filter((q) => /JOIN entries/i.test(q))
    expect(entriesQueries.length).toBeGreaterThanOrEqual(1)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/stats — all four aggregates", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/stats/route")
    // The single CTE query returns one row with all aggregates.
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      captured.push(sql as string)
      return {
        rows: [{
          total_entries: 0, total_days: 0, on_this_day: 0,
          total_media: 0, total_countries: 0, streak_days: [],
        }],
      }
    })
    const res = await GET(new NextRequest("http://localhost/api/stats"))
    expect(res.status).toBe(200)
    expect(captured.length).toBe(1)
    // One filter per subquery that reads entries: counts, media_count,
    // country_count, streak_days.
    const occurrences = captured[0].match(/deleted_at\s+IS\s+NULL/gi) ?? []
    expect(occurrences.length).toBe(4)
  })

  it("GET /api/export", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest("http://localhost/api/export"))
    expect(res.status).toBe(200)
    const entriesQueries = captured.filter((q) => /FROM entries/i.test(q))
    expect(entriesQueries.length).toBeGreaterThanOrEqual(1)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })

  it("GET /api/export/[id] — tombstoned entry is a 404", async () => {
    const captured = captureQueries()
    const { GET } = await import("../src/app/api/export/[id]/route")
    const res = await GET(
      new NextRequest("http://localhost/api/export/00000000-0000-4000-8000-000000000001"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) }
    )
    expect(res.status).toBe(404)
    const entriesQueries = captured.filter((q) => /FROM entries/i.test(q))
    expect(entriesQueries.length).toBeGreaterThanOrEqual(1)
    for (const q of entriesQueries) expect(q).toMatch(TOMBSTONE_FILTER)
  })
})
