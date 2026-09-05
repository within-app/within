/**
 * Pure data-transformation functions for the virtualized timeline list.
 * Extracted here so they can be unit-tested without React or a DOM.
 */

import { format, parseISO } from "date-fns"
import { getDateFnsLocale } from "@/lib/i18n"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"
import { dateKey } from "@/lib/timezone"
import type { DateGroup, TimelineEntry } from "@/types/journal"

export type FlatItem =
  | { kind: "month-header"; month: string; year: string; entryCount: number }
  | { kind: "entry"; entry: TimelineEntry; showDate: boolean }
  /** Day card: a day with 2+ entries is ONE card. */
  | { kind: "day"; group: DateGroup }
  | { kind: "sentinel" }

/** Was Tastatur-Navigation (j/k, Pfeile) ansteuern kann — Einzelkarte oder
 *  Tages-Karte. Beide tragen den Tagesschlüssel der App-Zone; die Tages-Karte
 *  auch ihre Einträge (aufsteigend), denn sie sind die Wahrheit der
 *  Tages-Vorschau: gefiltert wie die Timeline, inklusive ausstehender
 *  Offline-Einträge. */
export type TimelineTarget =
  | { kind: "entry"; id: string; date: string }
  | { kind: "day"; date: string; entries: TimelineEntry[] }

export function timelineTargets(items: FlatItem[]): TimelineTarget[] {
  const out: TimelineTarget[] = []
  for (const item of items) {
    if (item.kind === "entry") {
      out.push({ kind: "entry", id: item.entry.id, date: dateKey(new Date(item.entry.createdAt)) })
    } else if (item.kind === "day") {
      out.push({ kind: "day", date: item.group.date, entries: item.group.entries })
    }
  }
  return out
}

function groupByMonth(
  dateGroups: DateGroup[],
  locale: Locale = DEFAULT_LOCALE
): Array<{ month: string; year: string; dateGroups: DateGroup[] }> {
  const dfnsLocale = getDateFnsLocale(locale)
  const map = new Map<string, { month: string; year: string; dateGroups: DateGroup[] }>()
  for (const g of dateGroups) {
    const monthKey = g.date.slice(0, 7)
    if (!map.has(monthKey)) {
      const month = format(parseISO(g.date), "MMMM", { locale: dfnsLocale }).toUpperCase()
      const year = format(parseISO(g.date), "yyyy")
      map.set(monthKey, { month, year, dateGroups: [] })
    }
    map.get(monthKey)!.dateGroups.push(g)
  }
  return Array.from(map.values())
}

export function mergeDateGroups(existing: DateGroup[], incoming: DateGroup[]): DateGroup[] {
  const map = new Map<string, DateGroup>()
  for (const g of existing) {
    map.set(g.date, { ...g, entries: [...g.entries] })
  }
  for (const g of incoming) {
    if (map.has(g.date)) {
      const group = map.get(g.date)!
      const seen = new Set(group.entries.map((e) => e.id))
      for (const entry of g.entries) {
        if (!seen.has(entry.id)) {
          group.entries.push(entry)
          seen.add(entry.id)
        }
      }
    } else {
      map.set(g.date, g)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * Flatten the grouped date structure into a single list of virtual items:
 * month-header → entry|day… → month-header → entry|day… → sentinel (always last).
 * A date group with 2+ entries becomes one `day` item (Tages-Karte); a single
 * entry stays an `entry` item carrying the date, exactly as before.
 *
 * The sentinel is always appended so the virtualizer count is stable and the
 * IntersectionObserver loaderRef reliably lands at the bottom of the list.
 */
export function buildFlatItems(dateGroups: DateGroup[], locale: Locale = DEFAULT_LOCALE): FlatItem[] {
  const items: FlatItem[] = []
  for (const { month, year, dateGroups: monthGroups } of groupByMonth(dateGroups, locale)) {
    const entryCount = monthGroups.reduce((sum, g) => sum + g.entries.length, 0)
    items.push({ kind: "month-header", month, year, entryCount })
    for (const group of monthGroups) {
      if (group.entries.length >= 2) {
        // Ein Tag liest sich vorwärts: einmal hier
        // aufsteigend sortiert — Karte und Vorschau übernehmen die Reihenfolge.
        const entries = [...group.entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        items.push({ kind: "day", group: { ...group, entries } })
        continue
      }
      group.entries.forEach((entry, idx) => {
        items.push({ kind: "entry", entry, showDate: idx === 0 })
      })
    }
  }
  items.push({ kind: "sentinel" })
  return items
}
