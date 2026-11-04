/**
 * /api/stats rechnet Serie und „An diesem Tag“ ab dem Tag, den das Gerät nennt.
 * Zwei Zonen liegen höchstens zwei Kalendertage auseinander; alles darüber ist eine
 * falsche Uhr und zählt nicht. Synthetische Daten, gemockter Query-Layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"

async function streak(query: string, days: string[]): Promise<number> {
  vi.mocked(db.query).mockImplementation(async () => ({
    rows: [{ total_entries: 1, total_days: 1, on_this_day: 0, total_media: 0, total_countries: 0, streak_days: days }],
  }) as never)
  const { GET } = await import("@/app/api/stats/route")
  const res = await GET(new NextRequest(`http://localhost/api/stats${query}`))
  return ((await res.json()) as { streak: number }).streak
}

describe("GET /api/stats — Serie ab dem Tag des Geräts", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.stubEnv("APP_TIMEZONE", "Europe/Berlin")
    vi.mocked(db.query).mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z")) // Berlin: 06.11. 01:00, Los Angeles: 05.11. 16:00
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    setAppTimeZone(DEFAULT_TIME_ZONE)
  })

  it("nimmt den Tag des Geräts", async () => {
    expect(await streak("?today=2026-11-05", ["2026-11-04", "2026-11-03"])).toBe(2)
  })
  it("ohne Angabe gilt die App-Zone", async () => {
    expect(await streak("", ["2026-11-04", "2026-11-03"])).toBe(0)
  })
  it("zwei Kalendertage neben der App-Zone sind noch eine Zeitzone", async () => {
    expect(await streak("?today=2026-11-04", ["2026-11-03", "2026-11-02"])).toBe(2)
  })
  it("was weiter neben der App-Zone liegt, ist eine falsche Uhr", async () => {
    expect(await streak("?today=2026-11-03", ["2026-11-02", "2026-11-01"])).toBe(0)
    expect(await streak("?today=unsinn", ["2026-11-04", "2026-11-03"])).toBe(0)
  })
  it("„An diesem Tag“ fragt nach dem Tag des Geräts, ohne Angabe nach dem der App-Zone", async () => {
    await streak("?today=2026-11-05", [])
    expect((vi.mocked(db.query).mock.calls[0][1] as unknown[])[1]).toBe("11-05")
    vi.mocked(db.query).mockClear()
    await streak("", [])
    expect((vi.mocked(db.query).mock.calls[0][1] as unknown[])[1]).toBe("11-06")
  })
  it("Eintrag für morgen ohne Eintrag heute: 1", async () => {
    expect(await streak("?today=2026-11-06", ["2026-11-07", "2026-11-05", "2026-11-04"])).toBe(1)
  })
})
