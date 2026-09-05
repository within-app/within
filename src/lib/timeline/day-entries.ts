/**
 * Lese-Ansichten mit Volltext + Medienliste in EINEM Request (`full=true`):
 * „An diesem Tag" (onThisDay=MM-DD) und die Tages-Vorschau (date=YYYY-MM-DD).
 * Netz zuerst, IndexedDB-Fallback (UTC-Tag, gecachte
 * Medienlisten pro Eintrag gemischt), null wenn beides scheitert — dasselbe
 * Muster wie loadOverviewStats. Deps injizierbar für Tests ohne Netz/IDB.
 */

import { realIDBAdapter } from "@/lib/sync/idb"
import { idbToDayFull, idbToOnThisDayFull } from "@/lib/sync/idb-to-views"
import { readCachedEntryMedia } from "@/lib/sync/entry-media-cache"
import type { SyncEntry } from "@/lib/sync/types"
import type { FullTimelineEntry, Media, PaginatedTimeline } from "@/types/journal"

export interface ReadingData {
  /** Volle Einträge in Server-Reihenfolge (neueste zuerst). */
  entries: FullTimelineEntry[]
  /** Server-Gesamtzahl — kann entries.length übersteigen (perPage-Deckel 100). */
  totalEntries: number
  /** True, wenn die Daten aus dem IDB-Fallback stammen. */
  offline: boolean
}

export interface ReadingDeps {
  fetchImpl?: typeof fetch
  getAllEntries?: () => Promise<SyncEntry[]>
  readCachedMedia?: (entryId: string) => Promise<Media[]>
}

export type ReadingFilter = { date: string } | { onThisDay: string }

export async function loadFullEntries(
  filter: ReadingFilter,
  journalId: string | null,
  deps: ReadingDeps = {}
): Promise<ReadingData | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const params = new URLSearchParams({ full: "true", perPage: "100" })
  if ("date" in filter) params.set("date", filter.date)
  else params.set("onThisDay", filter.onThisDay)
  if (journalId) params.set("journalId", journalId)
  try {
    const res = await fetchImpl(`/api/entries?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as PaginatedTimeline
    const entries = data.dateGroups.flatMap((g) => g.entries as FullTimelineEntry[])
    return { entries, totalEntries: data.totalEntries, offline: false }
  } catch {
    try {
      const getAllEntries = deps.getAllEntries ?? (() => realIDBAdapter.getAllEntries())
      const readCachedMedia =
        deps.readCachedMedia ?? ((entryId: string) => readCachedEntryMedia(realIDBAdapter, entryId))
      const all = await getAllEntries()
      const base =
        "date" in filter
          ? idbToDayFull(all, filter.date, journalId)
          : idbToOnThisDayFull(all, filter.onThisDay, journalId)
      const entries = await Promise.all(
        base.map(async (e) => ({ ...e, media: await readCachedMedia(e.id) }))
      )
      return { entries, totalEntries: entries.length, offline: true }
    } catch {
      return null
    }
  }
}

/** Alle Einträge eines UTC-Tages, vollständig — Tages-Vorschau. */
export function loadDayFull(
  date: string,
  journalId: string | null,
  deps?: ReadingDeps
): Promise<ReadingData | null> {
  return loadFullEntries({ date }, journalId, deps)
}
