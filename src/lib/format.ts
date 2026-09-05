import { format } from "date-fns"
import { getDateFnsLocale, getMessages, localeTag } from "@/lib/i18n"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"
import { dateKey, getAppTimeZone, shiftDateKey, timeHHmm, toZonedDate, zonedParts } from "@/lib/timezone"

export function formatEntryDate(isoString: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(isoString)
  const m = getMessages(locale)
  // Heute/Gestern über den Kalendertag der App-Zone entscheiden — Timeline
  // und Datums-Header gruppieren danach (dateKey/formatEntryCardDate). Mit
  // dem lokalen isToday() zeigte die Detailansicht nach lokaler Mitternacht
  // "Heute" für einen Eintrag, der in der Timeline unter dem Vortages-Header steht.
  const key = dateKey(date)
  const todayKey = dateKey(new Date())
  if (key === todayKey) return m.date.today
  if (key === shiftDateKey(todayKey, -1)) return m.date.yesterday
  return format(toZonedDate(date), m.date.long, { locale: getDateFnsLocale(locale) })
}

export function formatEntryTime(isoString: string): string {
  return timeHHmm(new Date(isoString))
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n/g, " ")
    .trim()
}

export function truncateText(text: string, maxLength: number = 120): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength).trim() + "\u2026"
}

/**
 * Extracts a display title from markdown text.
 * Priority: # or ## heading → first line → empty string
 */
export function extractTitle(text: string): { title: string; body: string } {
  if (!text.trim()) return { title: "", body: "" }

  // Markdown heading (# or ##)
  const headingMatch = text.match(/^#{1,2}\s+(.+?)(?:\n|$)/)
  if (headingMatch) {
    return {
      title: headingMatch[1].trim(),
      body: text.slice(headingMatch[0].length).trim(),
    }
  }

  // First line as title
  const newlineIdx = text.indexOf("\n")
  if (newlineIdx === -1) return { title: text.trim(), body: "" }
  return {
    title: text.slice(0, newlineIdx).trim(),
    body: text.slice(newlineIdx + 1).trim(),
  }
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/** yyyy-MM-dd aus den LOKALEN Datumskomponenten — für Dates, die eine
 *  lokale Kalenderzelle repräsentieren (react-day-picker liefert lokale
 *  Mitternachten). dateKey (App-Zone) würde die östlich der App-Zone auf den
 *  Vortag verschieben: Punkte, Zählungen, Heute-Ring und Tages-Klick säßen
 *  eine Zelle daneben. Die aufgedruckte Zellen-Zahl IST der Server-Bucket-Key. */
export function localDateKey(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

/**
 * Returns weekday abbreviation and day number for an entry card using the
 * app-zone calendar day — matching the server's bucket keys (see dateKey in
 * timezone.ts and tests/entry-card-zoned-date.test.ts). Previously this used
 * a hardcoded UTC day, which diverged from a configured non-UTC app zone.
 */
export function formatEntryCardDate(
  createdAt: string,
  locale: Locale = DEFAULT_LOCALE
): { weekdayAbbr: string; dayNum: string } {
  const d = new Date(createdAt)
  const tz = getAppTimeZone()
  const weekdayAbbr = d
    .toLocaleDateString(localeTag(locale), { weekday: "short", timeZone: tz })
    .replace(/\./g, "")
    .toUpperCase()
  const dayNum = String(zonedParts(d, tz).day)
  return { weekdayAbbr, dayNum }
}
