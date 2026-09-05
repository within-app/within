/**
 * Convert SyncEntry[] from IndexedDB into the DateGroup[] shape consumed by
 * the timeline view. Used as an offline fallback when the live API is
 * unreachable.
 *
 * Missing UI-only fields (journalColor, thumbnail, photoCount, media flags)
 * are set to safe defaults — they are not stored in the sync protocol. Files
 * picked while offline are the exception: their bytes are in the `mediaOutbox`
 * store, and the caller folds them in with applyPendingMediaToGroups so a card
 * shows the queued photo instead of nothing.
 */

import type { SyncEntry } from "@/lib/sync/types"
import type { DateGroup, TimelineEntry } from "@/types/journal"
import { extractTitle, stripMarkdown, truncateText } from "@/lib/format"
import { dateKey } from "@/lib/timezone"

export interface IDBTimelineFilters {
  journalId?: string | null
  q?: string
  starred?: boolean
  tags?: string[]
  /** „Offline verfügbar": nur Einträge aus diesem Set (IDs des
   *  lokalen pinnedEntries-Stores). Ein leeres Set filtert auf leer —
   *  undefined heißt „Filter aus". */
  pinnedIds?: ReadonlySet<string>
}

/** Weather chip data from the synced columns (icon falls back to "cloudy"). */
export function weatherOf(entry: SyncEntry): TimelineEntry["weather"] {
  return entry.weatherDescription
    ? { description: entry.weatherDescription, temperatureCelsius: entry.weatherTempCelsius, icon: entry.weatherIcon ?? "cloudy" }
    : undefined
}

export function toTimelineEntry(entry: SyncEntry): TimelineEntry {
  const { title, body } = extractTitle(entry.text)
  const previewText = truncateText(stripMarkdown(body || entry.text), 120)

  return {
    id: entry.id,
    journalId: entry.journalId,
    journalColor: "",
    createdAt: entry.createdAt,
    title,
    previewText,
    thumbnail: entry.thumbnailDataUrl ?? undefined,
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: entry.starred,
    location: entry.locationName ?? undefined,
    weather: weatherOf(entry),
    tags: entry.tags,
  }
}

function applyFilters(entries: SyncEntry[], filters: IDBTimelineFilters): SyncEntry[] {
  let result = entries.filter((e) => !e.deletedAt)
  if (filters.journalId) {
    result = result.filter((e) => e.journalId === filters.journalId)
  }
  if (filters.starred) {
    result = result.filter((e) => e.starred)
  }
  if (filters.pinnedIds) {
    const pinned = filters.pinnedIds
    result = result.filter((e) => pinned.has(e.id))
  }
  if (filters.tags && filters.tags.length > 0) {
    const required = filters.tags
    result = result.filter((e) => required.every((t) => e.tags.includes(t)))
  }
  if (filters.q) {
    const q = filters.q.toLowerCase()
    result = result.filter((e) => e.text.toLowerCase().includes(q))
  }
  return result
}

/**
 * Convert a flat SyncEntry array into sorted DateGroup[] ready for the
 * timeline virtualiser. Entries are sorted newest-first within each day,
 * and days are also sorted newest-first.
 */
export function syncEntriesToDateGroups(
  entries: SyncEntry[],
  filters: IDBTimelineFilters = {}
): DateGroup[] {
  const filtered = applyFilters(entries, filters)

  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const groups = new Map<string, TimelineEntry[]>()
  for (const entry of filtered) {
    const key = dateKey(new Date(entry.createdAt))
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(toTimelineEntry(entry))
    } else {
      groups.set(key, [toTimelineEntry(entry)])
    }
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, groupEntries]) => ({
      date,
      formattedDate: date,
      entries: groupEntries,
    }))
}
