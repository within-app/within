/**
 * Zeitzone P2: EntryCard-Datum muss der
 * App-Zone folgen, nicht fest UTC, damit es mit der Server-Gruppierung
 * (dateKey in timezone.ts) übereinstimmt.
 *
 * 2024-01-15T23:30:00.000Z gewählt, weil:
 *   - UTC-Tag = 15 (Montag)
 *   - UTC+2-Tag = 16 (Dienstag) — Tageswechsel schon bei kleinem positivem Offset
 *
 * Zone wird pro Test explizit gesetzt — Ergebnisse hängen nie von der
 * Zeitzone des Test-Prozesses ab (CI läuft in UTC, der Mac in Europe/Berlin).
 */

import { describe, it, expect, afterEach } from "vitest"
import { formatEntryCardDate } from "@/lib/format"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"

describe("formatEntryCardDate — folgt der App-Zone", () => {
  const NEAR_MIDNIGHT_UTC = "2024-01-15T23:30:00.000Z"

  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("dayNum ist der Kalendertag der App-Zone, Standard UTC", () => {
    const { dayNum } = formatEntryCardDate(NEAR_MIDNIGHT_UTC)
    expect(dayNum).toBe("15")
  })

  it("weekdayAbbr ist der Wochentag der App-Zone (Montag → 'MO') in der Standardzone", () => {
    const { weekdayAbbr } = formatEntryCardDate(NEAR_MIDNIGHT_UTC)
    expect(weekdayAbbr).toBe("MO")
  })

  it("weekday-Abkürzung folgt der UI-Sprache, der Tag bleibt in der Standardzone gleich", () => {
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC, "en")).toEqual({ weekdayAbbr: "MON", dayNum: "15" })
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC, "fr")).toEqual({ weekdayAbbr: "LUN", dayNum: "15" })
  })

  it("Rechenbeispiel: in einer östlichen Zone ist der Tag schon der nächste, wenn UTC noch beim vorherigen ist", () => {
    setAppTimeZone("Etc/GMT-2") // UTC+2
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC)).toEqual({ weekdayAbbr: "DI", dayNum: "16" })
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC, "en")).toEqual({ weekdayAbbr: "TUE", dayNum: "16" })
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC, "fr")).toEqual({ weekdayAbbr: "MAR", dayNum: "16" })
  })

  it("Rechenbeispiel: in einer westlichen Zone (UTC−5) bleibt der Vortag noch länger gültig", () => {
    setAppTimeZone("Etc/GMT+5") // UTC−5
    expect(formatEntryCardDate(NEAR_MIDNIGHT_UTC)).toEqual({ weekdayAbbr: "MO", dayNum: "15" })
  })
})
