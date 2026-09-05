/**
 * Zeitzone P3+P4 — Kalender-, Jahres- und Statistik-Route binden die App-Zone
 * explizit statt fest 'UTC' (Muster tests/entries-app-timezone.test.ts).
 *
 * Rechenbeispiel (Nutzer in UTC−5 = "Etc/GMT+5"): 4. September 20:00
 * Ortszeit → gespeichert 2026-09-05T01:00Z → Tagesschlüssel "2026-09-04".
 * Silvester 23:00 Ortszeit (= 2026-01-01T04:00Z) zählt zum 31.12., Monat-Tag
 * "12-31".
 *
 * Synthetische Daten — kein DB-Zugriff (gemockter Query-Layer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"

describe("GET /api/calendar — App-Zone als expliziter Parameter", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setAppTimeZone(DEFAULT_TIME_ZONE)
  })

  it("hängt die App-Zone als letzten Parameter an — kein festes 'UTC'", async () => {
    setAppTimeZone("America/New_York")
    let capturedSql = ""
    let capturedParams: unknown[] = []
    vi.mocked(db.query).mockImplementation(async (sql: unknown, params?: unknown) => {
      capturedSql = sql as string
      capturedParams = (params as unknown[]) ?? []
      return { rows: [] }
    })

    const { GET } = await import("@/app/api/calendar/route")
    await GET(new NextRequest("http://localhost/api/calendar?from=2026-09&to=2026-09"))

    expect(capturedParams[capturedParams.length - 1]).toBe("America/New_York")
    expect(capturedSql).not.toContain("AT TIME ZONE 'UTC'")
    expect(capturedSql).toMatch(/AT TIME ZONE \$\d+/g)
  })
})

describe("GET /api/entries/years — App-Zone als expliziter Parameter", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setAppTimeZone(DEFAULT_TIME_ZONE)
  })

  it("hängt die App-Zone als zweiten Parameter an — kein festes 'UTC'", async () => {
    setAppTimeZone("America/New_York")
    let capturedSql = ""
    let capturedParams: unknown[] = []
    vi.mocked(db.query).mockImplementation(async (sql: unknown, params?: unknown) => {
      capturedSql = sql as string
      capturedParams = (params as unknown[]) ?? []
      return { rows: [] }
    })

    const { GET } = await import("@/app/api/entries/years/route")
    await GET(new NextRequest("http://localhost/api/entries/years"))

    expect(capturedParams[1]).toBe("America/New_York")
    expect(capturedSql).not.toContain("AT TIME ZONE 'UTC'")
    expect(capturedSql).toMatch(/AT TIME ZONE \$\d+/)
  })
})

describe("GET /api/stats — Streak über Mitternacht und on-this-day-Parameter in der App-Zone", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    setAppTimeZone(DEFAULT_TIME_ZONE)
  })

  it("Streak über Mitternacht in UTC−5: drei aufeinanderfolgende Abende 20:00 Ortszeit ergeben Streak 3", async () => {
    setAppTimeZone("Etc/GMT+5")
    vi.useFakeTimers()
    // Kurz nach dem dritten Abend-Eintrag (6.9. 20:00 Ortszeit) — "heute" bleibt der 6.9.
    vi.setSystemTime(new Date("2026-09-07T02:00:00.000Z"))

    let capturedParams: unknown[] = []
    vi.mocked(db.query).mockImplementation(async (_sql: unknown, params?: unknown) => {
      capturedParams = (params as unknown[]) ?? []
      return {
        rows: [{
          total_entries: 3, total_days: 3, on_this_day: 0, total_media: 0,
          total_countries: 0,
          // Die drei Vorabende (4./5./6.9., je 20:00 Ortszeit) — vom SQL
          // bereits als App-Zone-Kalendertage geliefert (hier gemockt).
          streak_days: ["2026-09-06", "2026-09-05", "2026-09-04"],
        }],
      }
    })

    const { GET } = await import("@/app/api/stats/route")
    const res = await GET(new NextRequest("http://localhost/api/stats"))
    const body = (await res.json()) as { streak: number }
    expect(body.streak).toBe(3)
    // todayMonthDay- und Zonen-Parameter folgen dem Kalendertag der App-Zone.
    expect(capturedParams[1]).toBe("09-06")
    expect(capturedParams[2]).toBe("Etc/GMT+5")
  })

  it("on-this-day-Parameter am Silvester 23:00 Ortszeit (= 1.1. 04:00Z) ist 12-31, nicht 01-01", async () => {
    setAppTimeZone("Etc/GMT+5")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T04:00:00.000Z"))

    let capturedParams: unknown[] = []
    vi.mocked(db.query).mockImplementation(async (_sql: unknown, params?: unknown) => {
      capturedParams = (params as unknown[]) ?? []
      return {
        rows: [{
          total_entries: 0, total_days: 0, on_this_day: 0, total_media: 0,
          total_countries: 0, streak_days: [],
        }],
      }
    })

    const { GET } = await import("@/app/api/stats/route")
    await GET(new NextRequest("http://localhost/api/stats"))
    expect(capturedParams[1]).toBe("12-31")
  })
})
