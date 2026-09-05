/**
 * Zeitzone (Fundament): alle Kalendertag-Ableitungen laufen über EINE
 * konfigurierte Zone (APP_TIMEZONE, IANA-Name, Standard UTC) — nie über die
 * Browser-Ortszeit und nie über UTC-Felder.
 *
 * Rechenbeispiel aus dem Befund (Nutzer in UTC−5 = "Etc/GMT+5"):
 *   geschrieben 4. September 20:00 Ortszeit → gespeichert 2026-09-05T01:00Z
 *   → Tagesschlüssel muss "2026-09-04" sein, Uhrzeit "20:00".
 *
 * Die Erwartungen sind fest kodiert und unabhängig von der Zeitzone des
 * Test-Prozesses (CI läuft in UTC, ein Entwickler-Mac z.B. in Europe/Berlin).
 */

import { describe, it, expect, afterEach } from "vitest"
import { format } from "date-fns"
import {
  DEFAULT_TIME_ZONE,
  dateKey,
  fromZonedFields,
  getAppTimeZone,
  isValidTimeZone,
  monthDay,
  setAppTimeZone,
  shiftDateKey,
  timeHHmm,
  toZonedDate,
  zonedParts,
} from "@/lib/timezone"

// 4. September 20:00 in UTC−5 = 5. September 01:00 UTC
const EVENING_UTC_MINUS_5 = new Date("2026-09-05T01:00:00.000Z")
// Kurz vor / nach Mitternacht UTC
const BEFORE_MIDNIGHT = new Date("2026-09-04T23:30:00.000Z")
const AFTER_MIDNIGHT = new Date("2026-09-05T00:30:00.000Z")

afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

describe("isValidTimeZone", () => {
  it("akzeptiert IANA-Namen und UTC", () => {
    for (const tz of ["UTC", "Etc/GMT+5", "Etc/GMT-2", "Europe/Berlin", "America/New_York"]) {
      expect(isValidTimeZone(tz), tz).toBe(true)
    }
  })
  it("lehnt Unsinn, leere Werte und Nicht-Strings ab", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false)
    expect(isValidTimeZone("")).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
  })
})

describe("dateKey — Tagesschlüssel yyyy-MM-dd in der Zone", () => {
  it("Rechenbeispiel: Abendeintrag in UTC−5 bleibt beim 4. September", () => {
    expect(dateKey(EVENING_UTC_MINUS_5, "Etc/GMT+5")).toBe("2026-09-04")
    expect(dateKey(EVENING_UTC_MINUS_5, "UTC")).toBe("2026-09-05")
    expect(dateKey(EVENING_UTC_MINUS_5, "Etc/GMT-2")).toBe("2026-09-05")
  })
  it("Tageswechsel 23:30 UTC: östlich von UTC schon der nächste Tag, westlich noch nicht", () => {
    expect(dateKey(BEFORE_MIDNIGHT, "UTC")).toBe("2026-09-04")
    expect(dateKey(BEFORE_MIDNIGHT, "Etc/GMT-2")).toBe("2026-09-05")
    expect(dateKey(BEFORE_MIDNIGHT, "Etc/GMT+5")).toBe("2026-09-04")
  })
  it("Tageswechsel 00:30 UTC: westlich von UTC noch der Vortag", () => {
    expect(dateKey(AFTER_MIDNIGHT, "UTC")).toBe("2026-09-05")
    expect(dateKey(AFTER_MIDNIGHT, "Etc/GMT-2")).toBe("2026-09-05")
    expect(dateKey(AFTER_MIDNIGHT, "Etc/GMT+5")).toBe("2026-09-04")
  })
  it("Europe/Berlin: Sommerzeit (+2) und Winterzeit (+1) korrekt", () => {
    expect(dateKey(new Date("2026-07-01T22:30:00Z"), "Europe/Berlin")).toBe("2026-07-02")
    expect(dateKey(new Date("2026-07-01T21:30:00Z"), "Europe/Berlin")).toBe("2026-07-01")
    expect(dateKey(new Date("2026-01-01T23:30:00Z"), "Europe/Berlin")).toBe("2026-01-02")
    expect(dateKey(new Date("2026-01-01T22:30:00Z"), "Europe/Berlin")).toBe("2026-01-01")
  })
  it("Jahreswechsel: Silvester 23:00 in UTC−5 (= 04:00Z am 1.1.) zählt zum 31.12.", () => {
    expect(dateKey(new Date("2026-01-01T04:00:00Z"), "Etc/GMT+5")).toBe("2025-12-31")
  })
  it("ohne Zonenargument gilt die App-Zone (Standard UTC, per setAppTimeZone umstellbar)", () => {
    expect(getAppTimeZone()).toBe("UTC")
    expect(dateKey(EVENING_UTC_MINUS_5)).toBe("2026-09-05")
    setAppTimeZone("Etc/GMT+5")
    expect(getAppTimeZone()).toBe("Etc/GMT+5")
    expect(dateKey(EVENING_UTC_MINUS_5)).toBe("2026-09-04")
  })
  it("setAppTimeZone ignoriert ungültige Zonen (bleibt bei der letzten gültigen)", () => {
    setAppTimeZone("Etc/GMT-2")
    setAppTimeZone("Mars/Olympus")
    expect(getAppTimeZone()).toBe("Etc/GMT-2")
  })
})

describe("timeHHmm — Uhrzeit in der Zone", () => {
  it("Rechenbeispiel: 20:00 in UTC−5, 01:00 in UTC, 03:00 in UTC+2", () => {
    expect(timeHHmm(EVENING_UTC_MINUS_5, "Etc/GMT+5")).toBe("20:00")
    expect(timeHHmm(EVENING_UTC_MINUS_5, "UTC")).toBe("01:00")
    expect(timeHHmm(EVENING_UTC_MINUS_5, "Etc/GMT-2")).toBe("03:00")
  })
  it("Mitternacht ist 00:00, nicht 24:00", () => {
    expect(timeHHmm(new Date("2026-09-05T05:00:00Z"), "Etc/GMT+5")).toBe("00:00")
  })
})

describe("monthDay — MM-DD in der Zone (An diesem Tag)", () => {
  it("Silvester 23:00 in UTC−5 ist 12-31, in UTC schon 01-01", () => {
    const d = new Date("2026-01-01T04:00:00Z")
    expect(monthDay(d, "Etc/GMT+5")).toBe("12-31")
    expect(monthDay(d, "UTC")).toBe("01-01")
  })
  it("einstellige Werte werden gepolstert", () => {
    expect(monthDay(new Date("2026-03-04T12:00:00Z"), "UTC")).toBe("03-04")
  })
})

describe("zonedParts / toZonedDate — Felder für date-fns-Formatierung", () => {
  it("liefert die Wanduhr-Felder der Zone", () => {
    expect(zonedParts(EVENING_UTC_MINUS_5, "Etc/GMT+5")).toEqual({
      year: 2026, month: 9, day: 4, hour: 20, minute: 0, second: 0, weekday: 5,
    })
  })
  it("toZonedDate + date-fns format ergibt die Zonen-Zeit, egal wo der Prozess läuft", () => {
    expect(format(toZonedDate(EVENING_UTC_MINUS_5, "Etc/GMT+5"), "yyyy-MM-dd HH:mm EEEE")).toBe(
      "2026-09-04 20:00 Friday"
    )
    expect(format(toZonedDate(EVENING_UTC_MINUS_5, "Etc/GMT-2"), "yyyy-MM-dd HH:mm")).toBe("2026-09-05 03:00")
  })
})

describe("shiftDateKey — Kalenderarithmetik auf Schlüsseln (Streak, Blättern)", () => {
  it("rollt über Monats-, Schaltjahr- und Jahresgrenzen", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28")
    expect(shiftDateKey("2024-02-28", 1)).toBe("2024-02-29")
    expect(shiftDateKey("2025-12-31", 1)).toBe("2026-01-01")
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31")
    expect(shiftDateKey("2026-09-04", 0)).toBe("2026-09-04")
  })
})

describe("fromZonedFields — Wanduhr-Felder der Zone → Zeitpunkt (Editor-Eingabe)", () => {
  it("Rechenbeispiel rückwärts: 4. September 20:00 in UTC−5 ist 5. September 01:00 UTC", () => {
    expect(fromZonedFields({ year: 2026, month: 9, day: 4, hour: 20 }, "Etc/GMT+5").toISOString()).toBe(
      "2026-09-05T01:00:00.000Z"
    )
    expect(fromZonedFields({ year: 2026, month: 9, day: 4, hour: 20 }, "UTC").toISOString()).toBe(
      "2026-09-04T20:00:00.000Z"
    )
  })
  it("Europe/Berlin: Sommerzeit (+2) und Winterzeit (+1)", () => {
    expect(fromZonedFields({ year: 2026, month: 7, day: 1, hour: 12 }, "Europe/Berlin").toISOString()).toBe(
      "2026-07-01T10:00:00.000Z"
    )
    expect(fromZonedFields({ year: 2026, month: 1, day: 1, hour: 12 }, "Europe/Berlin").toISOString()).toBe(
      "2026-01-01T11:00:00.000Z"
    )
  })
  it("Rundreise zonedParts → fromZonedFields ist verlustfrei", () => {
    for (const tz of ["UTC", "Etc/GMT+5", "Etc/GMT-2", "Europe/Berlin", "America/New_York"]) {
      const p = zonedParts(EVENING_UTC_MINUS_5, tz)
      expect(fromZonedFields(p, tz).getTime(), tz).toBe(EVENING_UTC_MINUS_5.getTime())
    }
  })
  it("Sommerzeit-Lücke (Berlin 29.03.2026 02:30 existiert nicht) landet höchstens eine Stunde daneben", () => {
    const d = fromZonedFields({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin")
    expect(Math.abs(d.getTime() - Date.UTC(2026, 2, 29, 1, 30))).toBeLessThanOrEqual(3600_000)
  })
})

