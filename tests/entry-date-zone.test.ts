/**
 * Editor: Datum/Uhrzeit-Eingabe rechnet in der App-Zone, nicht in der
 * Zeitzone des Geräts. Rechenbeispiel: Eintrag 2026-09-05T01:00Z ist in
 * UTC−5 der 4. September 20:00.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { DEFAULT_TIME_ZONE, setAppTimeZone } from "@/lib/timezone"
import { entryTimeString, entryWallClockDate, withEntryDay, withEntryTime } from "@/lib/editor/entry-date"

const EVENING = new Date("2026-09-05T01:00:00.000Z")

describe("Editor-Datum in UTC−5", () => {
  beforeEach(() => setAppTimeZone("Etc/GMT+5"))
  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("zeigt 20:00 und den 4. September", () => {
    expect(entryTimeString(EVENING)).toBe("20:00")
    const wall = entryWallClockDate(EVENING)
    expect([wall.getFullYear(), wall.getMonth() + 1, wall.getDate(), wall.getHours()]).toEqual([2026, 9, 4, 20])
  })

  it("Uhrzeit 21:30 eintippen → gleicher Kalendertag, 02:30Z am Folgetag", () => {
    expect(withEntryTime(EVENING, "21:30")?.toISOString()).toBe("2026-09-05T02:30:00.000Z")
    expect(withEntryTime(EVENING, "nonsense")).toBeNull()
  })

  it("Tag im Kalender wählen (lokale Mitternacht des 10.09.) → 10.09. 20:00 in der Zone", () => {
    const picked = new Date(2026, 8, 10) // DayPicker: lokale Mitternacht des aufgedruckten Tages
    expect(withEntryDay(EVENING, picked).toISOString()).toBe("2026-09-11T01:00:00.000Z")
  })
})

describe("Editor-Datum in UTC (Standard) — Verhalten wie zuvor", () => {
  it("zeigt 01:00 und den 5. September", () => {
    expect(entryTimeString(EVENING)).toBe("01:00")
    expect(entryWallClockDate(EVENING).getDate()).toBe(5)
  })
})
