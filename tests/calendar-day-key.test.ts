// TZ vor allen Imports pinnen — der Bug ist nur östlich von UTC sichtbar
// und CI läuft in UTC (exakt die Falle, die format.ts:84 für entry-card
// dokumentiert).
process.env.TZ = "Europe/Berlin"

/**
 * Kalender-Zeitzonenverschiebung:
 *
 * react-day-picker v9 liefert day.date als LOKALE Mitternacht der Zelle.
 * utcDateKey (toISOString) mappte die östlich von UTC auf den VORTAG: alle
 * Punkte/Zählungen/Thumbnails/Heute-Ring saßen in Berlin (UTC+1/+2) eine
 * Zelle zu spät, der Tages-Klick lud den falschen Tag, der Panel-Header
 * widersprach der Detailansicht. Die Zellen-Keys müssen aus den LOKALEN
 * Datumskomponenten kommen (localDateKey) — das entspricht der aufgedruckten
 * Zahl der Zelle und damit dem UTC-Tages-Bucket des Servers.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { localDateKey } from "../src/lib/format"
import { dateKey } from "../src/lib/timezone"

describe("localDateKey", () => {
  it("liefert die aufgedruckten Datumskomponenten der Zelle — unabhängig von der Zeitzone", () => {
    // new Date(y, m, d) ist die lokale Mitternacht, exakt was DayPicker liefert.
    expect(localDateKey(new Date(2026, 7, 22))).toBe("2026-08-22")
    expect(localDateKey(new Date(2026, 0, 1))).toBe("2026-01-01")
    expect(localDateKey(new Date(2024, 1, 29))).toBe("2024-02-29")
  })

  const eastOfUtc = new Date(2026, 7, 22).getTimezoneOffset() < 0
  it.runIf(eastOfUtc)("Beleg: der frühere utcDateKey (jetzt dateKey mit UTC) verschiebt lokale Mitternachten östlich von UTC auf den Vortag", () => {
    expect(dateKey(new Date(2026, 7, 22), "UTC")).toBe("2026-08-21")
    expect(localDateKey(new Date(2026, 7, 22))).toBe("2026-08-22")
  })

  it("calendar-view nutzt localDateKey für Zellen-Keys — utcDateKey(day.date) ist der Bug", () => {
    const src = readFileSync(join(__dirname, "../src/components/calendar/calendar-view.tsx"), "utf8")
    expect(src).toContain("localDateKey")
    expect(src).not.toMatch(/utcDateKey\(\s*(day\.date|date|today|selectedDate|startMonth)\s*\)/)
  })
})
