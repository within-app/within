/**
 * Datum/Uhrzeit-Eingabe im Editor in der Zone des Eintrags.
 *
 * Der Editor zeigt und ändert Wanduhr-Felder (Kalendertag, HH:mm). Die gehören
 * zur Zone des Eintrags, ohne Angabe zur App-Zone, nie zur aktuellen Zone des
 * Geräts — sonst zeigt der Editor auf Reisen eine andere Uhrzeit als Zeitleiste
 * und Detailansicht.
 * Pure Funktionen, damit die Umrechnung ohne DOM testbar ist.
 */

import { fromZonedFields, toZonedDate, zonedParts, zoneOf } from "@/lib/timezone"

/** "HH:mm" des Zeitpunkts in der App-Zone (Wert des <input type="time">). */
export function entryTimeString(createdAt: Date, timeZone?: string | null): string {
  const p = zonedParts(createdAt, zoneOf(timeZone))
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`
}

/** Lokales Date mit den Wanduhr-Feldern der App-Zone — für DayPicker
 *  (`selected`) und date-fns `format`, die auf lokalen Feldern arbeiten. */
export function entryWallClockDate(createdAt: Date, timeZone?: string | null): Date {
  return toZonedDate(createdAt, zoneOf(timeZone))
}

/** Neue Uhrzeit "HH:mm" (App-Zone) bei gleichem Kalendertag; null bei Unsinn. */
export function withEntryTime(createdAt: Date, value: string, timeZone?: string | null): Date | null {
  const [h, m] = value.split(":").map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  const tz = zoneOf(timeZone)
  const p = zonedParts(createdAt, tz)
  return fromZonedFields({ year: p.year, month: p.month, day: p.day, hour: h, minute: m }, tz)
}

/** Neuer Kalendertag aus einer DayPicker-Zelle (lokale Mitternacht = der
 *  aufgedruckte Tag) bei gleicher Uhrzeit in der App-Zone. */
export function withEntryDay(createdAt: Date, day: Date, timeZone?: string | null): Date {
  const tz = zoneOf(timeZone)
  const p = zonedParts(createdAt, tz)
  return fromZonedFields({
    year: day.getFullYear(),
    month: day.getMonth() + 1,
    day: day.getDate(),
    hour: p.hour,
    minute: p.minute,
  }, tz)
}
