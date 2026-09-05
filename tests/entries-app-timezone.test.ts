/**
 * Zeitzone P2 — listEntries bindet die App-Zone explizit (kein Session-
 * Setting) an DATE(...)/EXTRACT(YEAR ...) und die before-Monatsgrenze.
 * GET /api/entries gruppiert Zeilen nach dem Kalendertag der App-Zone.
 *
 * Rechenbeispiel (Nutzer in UTC−5 = "Etc/GMT+5"): 4. September 20:00
 * Ortszeit → gespeichert 2026-09-05T01:00Z → Tagesschlüssel "2026-09-04".
 * In UTC wäre der Schlüssel "2026-09-05".
 *
 * Synthetische Daten — kein DB-Zugriff (gemockter Query-Layer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"

const DEFAULTS = {
  journalId: null, date: null, onThisDay: null, year: null, before: null,
  searchQuery: null, tags: null, starred: null, mediaType: null,
  page: 1, perPage: 25,
}

describe("listEntries — App-Zone als expliziter Parameter", () => {
  beforeEach(() => vi.mocked(db.query).mockReset())
  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("hängt die App-Zone als letzten Parameter an count- und paginierte SELECT-Query an", async () => {
    setAppTimeZone("America/New_York")
    const sqls: string[] = []
    const paramLists: unknown[][] = []
    vi.mocked(db.query).mockImplementation(async (sql: unknown, params?: unknown) => {
      sqls.push(sql as string)
      paramLists.push((params as unknown[]) ?? [])
      if (sqls.length === 1) return { rows: [{ total: 0 }] }
      return { rows: [] }
    })

    const { listEntries } = await import("@/lib/db/entries")
    await listEntries(DEFAULTS)

    expect(paramLists[0][paramLists[0].length - 1]).toBe("America/New_York")
    expect(paramLists[1][paramLists[1].length - 1]).toBe("America/New_York")
    // Kein Session-Setting — die Zone steht explizit als Parameter im SQL-Text.
    expect(sqls[0]).not.toContain("AT TIME ZONE 'UTC'")
    expect(sqls[1]).not.toContain("AT TIME ZONE 'UTC'")
    expect(sqls[0]).toMatch(/AT TIME ZONE \$\d+/)
    expect(sqls[1]).toMatch(/AT TIME ZONE \$\d+/)
  })

  it("Standardzone (APP_TIMEZONE ungesetzt) bindet weiterhin 'UTC' — Verhalten bleibt identisch", async () => {
    const paramLists: unknown[][] = []
    vi.mocked(db.query).mockImplementation(async (_sql: unknown, params?: unknown) => {
      paramLists.push((params as unknown[]) ?? [])
      return paramLists.length === 1 ? { rows: [{ total: 0 }] } : { rows: [] }
    })

    const { listEntries } = await import("@/lib/db/entries")
    await listEntries(DEFAULTS)

    expect(paramLists[0][paramLists[0].length - 1]).toBe("UTC")
    expect(paramLists[1][paramLists[1].length - 1]).toBe("UTC")
  })

  it("on-this-day-Filter bindet die Zone über month_day_in() statt der UTC-fixen month_day_utc()", async () => {
    setAppTimeZone("Etc/GMT+5")
    const sqls: string[] = []
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      sqls.push(sql as string)
      return sqls.length === 1 ? { rows: [{ total: 0 }] } : { rows: [] }
    })

    const { listEntries } = await import("@/lib/db/entries")
    await listEntries({ ...DEFAULTS, onThisDay: "12-31" })

    expect(sqls[0]).toContain("month_day_in(e.created_at, $10)")
    expect(sqls[1]).toContain("month_day_in(e.created_at, $12)")
    expect(sqls[0]).not.toContain("month_day_utc")
    expect(sqls[1]).not.toContain("month_day_utc")
  })
})

describe("GET /api/entries — Gruppierung folgt der App-Zone (Rechenbeispiel)", () => {
  function row(id: string, createdAt: string) {
    return {
      id, journal_id: "j1", journal_color: "#007AFF", created_at: new Date(createdAt),
      text: "", starred: false, location_name: null, weather_description: null,
      weather_temp_celsius: null, weather_icon: null, thumbnail: null, photo_count: 0,
      has_audio: false, has_video: false, tags: [],
    }
  }

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setAppTimeZone(DEFAULT_TIME_ZONE)
  })

  it("bündelt einen Abendeintrag in UTC−5 unter dem Vortag der App-Zone", async () => {
    setAppTimeZone("Etc/GMT+5")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: 1 }] } as never)
      .mockResolvedValueOnce({ rows: [row("a", "2026-09-05T01:00:00.000Z")] } as never)

    const { GET } = await import("@/app/api/entries/route")
    const res = await GET(new NextRequest("http://localhost/api/entries"))
    const body = (await res.json()) as { dateGroups: { date: string }[] }
    expect(body.dateGroups.map((g) => g.date)).toEqual(["2026-09-04"])
  })

  it("in UTC bleibt derselbe Zeitpunkt unter dem nächsten Tag", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ total: 1 }] } as never)
      .mockResolvedValueOnce({ rows: [row("a", "2026-09-05T01:00:00.000Z")] } as never)

    const { GET } = await import("@/app/api/entries/route")
    const res = await GET(new NextRequest("http://localhost/api/entries"))
    const body = (await res.json()) as { dateGroups: { date: string }[] }
    expect(body.dateGroups.map((g) => g.date)).toEqual(["2026-09-05"])
  })
})
