/**
 * Convert SyncEntry[] from IndexedDB into the data shapes consumed by
 * Calendar, Overview, and Map views.
 *
 * journalColor is unavailable in the sync protocol — it is left as "" and
 * the views that display it degrade gracefully (no colour swatch).
 * totalMedia is null offline for the same reason — unknown, not zero; the
 * overview renders it as "–" instead of a wrong number.
 */

import type { SyncEntry } from "@/lib/sync/types"
import type { CalendarData, FullTimelineEntry, JournalEntryDetail, JournalStats, MapMarker, TimelineEntry } from "@/types/journal"
import { extractTitle } from "@/lib/format"
import { toTimelineEntry, weatherOf } from "@/lib/sync/idb-to-timeline"
import { dateKey, monthDay as monthDayIn, shiftDateKey } from "@/lib/timezone"
// ── Entry detail ──────────────────────────────────────────────────────────

/**
 * Map a SyncEntry from IDB into a JournalEntryDetail for offline display.
 *
 * Offline degradations (invariants of the sync protocol):
 *   - media: [] — a SyncEntry carries no media metadata, and files uploaded to the
 *     server are not mirrored into IDB (still out of scope)
 *   - journalName / journalColor: "" — not part of the sync payload
 *   - tags: synthetic Tag objects (id = name) from the stored string array
 *
 * `media: []` is NOT the whole story for files picked while offline: their bytes
 * do sit locally, in the `mediaOutbox` store. Merging those in stays out of here
 * on purpose — it needs `URL.createObjectURL` and a revoke, so this function
 * would stop being pure, and the online path needs the same merge anyway. The
 * caller does it via mergePendingMedia.
 */
export function idbToEntryDetail(entry: SyncEntry): JournalEntryDetail {
  return {
    id: entry.id,
    journalId: entry.journalId,
    text: entry.text,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revisionId: entry.revisionId,
    starred: entry.starred,
    tags: entry.tags.map((name) => ({ id: name, name })),
    media: [],
    // A location exists when it has a name OR coordinates — the GPS picker
    // stores coordinates without a name (no reverse geocoding by design), and
    // gating on the name alone would make those entries look location-less.
    location:
      entry.locationName || (entry.locationLat != null && entry.locationLng != null)
        ? {
            name: entry.locationName || null,
            latitude: entry.locationLat ?? undefined,
            longitude: entry.locationLng ?? undefined,
          }
        : undefined,
    weather: weatherOf(entry),
    journalName: "",
    journalColor: "",
  }
}


// ── Calendar ─────────────────────────────────────────────────────────────

/** Build a CalendarData map (count + thumbnail per day) from IDB.
 *
 *  Tageszellen offline wie online: thumbnail kommt
 *  aus dem Timeline-Thumbnail (`thumbnailDataUrl`, data:-URL — liegt bereits
 *  in der IDB, null Zusatzspeicher); der neueste Eintrag des Tages MIT Thumb
 *  gewinnt — Einträge ohne Thumb blockieren nicht. Tombstones bleiben draußen
 *  (gleiche Invariante wie idb-to-timeline/idb-to-media). */
export function idbToCalendarData(
  entries: SyncEntry[],
  journalId: string | null
): CalendarData {
  const result: CalendarData = {}
  const thumbAt: Record<string, string> = {}
  for (const e of entries) {
    if (e.deletedAt) continue
    if (journalId && e.journalId !== journalId) continue
    const day = dateKey(new Date(e.createdAt))
    if (result[day]) {
      result[day].count++
    } else {
      result[day] = { count: 1 }
    }
    if (e.thumbnailDataUrl && (!thumbAt[day] || e.createdAt > thumbAt[day])) {
      result[day].thumbnail = e.thumbnailDataUrl
      thumbAt[day] = e.createdAt
    }
  }
  return result
}

// ── Overview / Stats ──────────────────────────────────────────────────────

/** Derive JournalStats from IDB. totalMedia is null (no media metadata in IDB). */
export function idbToStats(
  entries: SyncEntry[],
  journalId: string | null
): JournalStats {
  const filtered = journalId
    ? entries.filter((e) => e.journalId === journalId)
    : entries

  const daySet = new Set(filtered.map((e) => dateKey(new Date(e.createdAt))))

  // Streak: consecutive days with entries, ending today (App-Zone)
  let streak = 0
  const now = new Date()
  const todayKey = dateKey(now)
  for (let i = 0; i < 3650; i++) {
    if (daySet.has(shiftDateKey(todayKey, -i))) {
      streak++
    } else {
      break
    }
  }

  // Countries: last comma-separated segment of locationName, matching the SQL
  // REGEXP_REPLACE(location_name, '^.*,\s*', '') used server-side.
  const countries = new Set<string>()
  for (const e of filtered) {
    if (e.locationName?.includes(",")) {
      const country = e.locationName.split(",").pop()?.trim()
      if (country) countries.add(country)
    }
  }

  // on-this-day: entries whose MM-DD matches today (App-Zone)
  const todayMonthDay = monthDayIn(now)
  const onThisDayCount = filtered.filter(
    (e) => monthDayIn(new Date(e.createdAt)) === todayMonthDay
  ).length

  return {
    streak,
    totalEntries: filtered.length,
    totalMedia: null,
    totalDays: daySet.size,
    totalCountries: countries.size,
    onThisDayCount,
  }
}

/** Volle Einträge aus der IDB für die Lese-Ansichten. media ist [] (ein
 *  SyncEntry trägt keine Medien-Metadaten, gleiche Invariante wie
 *  idbToEntryDetail) — der Aufrufer mischt den Medien-Cache dazu. Tombstones
 *  bleiben draußen wie in syncEntriesToDateGroups. Neueste zuerst. */
function idbToFullEntries(
  entries: SyncEntry[],
  matches: (e: SyncEntry) => boolean,
  journalId: string | null
): FullTimelineEntry[] {
  const filtered = entries.filter(
    (e) => !e.deletedAt && matches(e) && (!journalId || e.journalId === journalId)
  )
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return filtered.map((e) => ({ ...toTimelineEntry(e), text: e.text, media: [] }))
}

/** „An diesem Tag": alle Jahre mit diesem MM-DD (App-Zone). */
export function idbToOnThisDayFull(
  entries: SyncEntry[],
  monthDay: string,
  journalId: string | null
): FullTimelineEntry[] {
  return idbToFullEntries(entries, (e) => monthDayIn(new Date(e.createdAt)) === monthDay, journalId)
}

/** Tages-Vorschau: ein Kalendertag der App-Zone (YYYY-MM-DD). */
export function idbToDayFull(
  entries: SyncEntry[],
  dateStr: string,
  journalId: string | null
): FullTimelineEntry[] {
  return idbToFullEntries(entries, (e) => dateKey(new Date(e.createdAt)) === dateStr, journalId)
}

// ── Map ───────────────────────────────────────────────────────────────────

/** MapMarker[] from IDB entries that carry coordinates.
 *  journalColor is not stored in IDB so it defaults to "" — the marker
 *  renders as a neutral dot instead of the journal colour. */
export function idbToMapMarkers(
  entries: SyncEntry[],
  journalId: string | null
): MapMarker[] {
  return entries
    .filter(
      (e) =>
        e.locationLat !== null &&
        e.locationLng !== null &&
        (!journalId || e.journalId === journalId)
    )
    .map((e) => {
      const { title } = extractTitle(e.text)
      return {
        id: e.id,
        lat: e.locationLat!,
        lng: e.locationLng!,
        journalColor: "",
        title: title || "Ohne Titel",
        createdAt: e.createdAt,
      }
    })
}
