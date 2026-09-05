"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import dynamic from "next/dynamic"
import { useOnline } from "@/hooks/use-online"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { ScrollBar } from "@/components/ui/scroll-area"
import { Loader2 } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { EntryCard, DayCard } from "@/components/timeline/entry-card"
import { EmptyState } from "@/components/timeline/empty-state"
import { TimelineToolbar } from "@/components/timeline/timeline-toolbar"
import { TimelineSkeleton } from "@/components/timeline/timeline-skeleton"
import { buildFlatItems, mergeDateGroups, timelineTargets, type TimelineTarget } from "@/lib/timeline-virtual-items"
import type { DateGroup, PaginatedTimeline, TimelineEntry, ViewMode, ActiveFilters, Tag } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { syncEntriesToDateGroups } from "@/lib/sync/idb-to-timeline"
import { applyPendingMediaToGroups } from "@/lib/sync/pending-media"
import { loadPendingMediaByEntry } from "@/lib/sync/pending-media-preview"
import { clearPreviewUrlCache } from "@/lib/sync/preview-urls"
import { mergePendingIntoDateGroups } from "@/lib/timeline/merge-pending"
import { isFilterActive } from "@/lib/timeline/filter-utils"
import { chainSequential } from "@/lib/sync/run-chain"
import { applyCachedMediaToGroups } from "@/lib/sync/entry-media-cache"
import { useI18n } from "@/components/locale-provider"

function ViewSpinner() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="h-7 w-7 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
    </div>
  )
}

const MediaGridView = dynamic(
  () => import("@/components/media/media-grid-view").then((m) => m.MediaGridView),
  { ssr: false, loading: ViewSpinner }
)

const CalendarView = dynamic(
  () => import("@/components/calendar/calendar-view").then((m) => m.CalendarView),
  { ssr: false, loading: ViewSpinner }
)

const OverviewView = dynamic(
  () => import("@/components/overview/overview-view").then((m) => m.OverviewView),
  { ssr: false, loading: ViewSpinner }
)

const MapView = dynamic(
  () => import("@/components/map/map-view").then((m) => m.MapView),
  { ssr: false, loading: ViewSpinner }
)

/**
 * Chunk-Warming (Feldbefund): Der SW cached statische Chunks
 * nur on first fetch (precache = '/' + '/login'). Ohne Aufwärmen hängt die
 * OFFLINE-Verfügbarkeit einer lazy geladenen Ansicht davon ab, ob sie seit
 * dem letzten Deploy zufällig online geöffnet wurde — Kalender/Medien
 * blieben sonst offline für immer beim ViewSpinner bzw. Fehler-Screen, und
 * ihre IDB-Fallbacks liefen nie.
 *
 * Bewusst HIDDEN-RENDER statt manuellem import(): Turbopack löst eigene
 * import()-Callsites als eigenen Chunk-Graphen auf — empirisch lud erst der
 * next/dynamic-RENDER den Klick-Chunk (Probe: `0x237…js` kam nur
 * beim Render, ein import() derselben Datei ließ ihn ungecacht). Der
 * versteckte Mount nimmt exakt den Pfad des Tab-Klicks; die Fetches der
 * Ansichten laufen online ins Leere-Cache-Warming mit (billig). Karte
 * bewusst NICHT dabei: online-gebunden (Pi-Kacheln)
 * und MapLibre-Boot wäre am Handy teuer.
 */
function ViewChunkWarmer() {
  const [phase, setPhase] = useState<"wait" | "warm" | "done">("wait")

  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    const start = () => setPhase("warm")
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(start)
      return () => w.cancelIdleCallback?.(id)
    }
    const id = setTimeout(start, 2_000)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (phase !== "warm") return
    // Chunks + Daten-Fetches sind nach Sekunden durch — danach abräumen.
    const id = setTimeout(() => setPhase("done"), 15_000)
    return () => clearTimeout(id)
  }, [phase])

  if (phase !== "warm") return null
  return (
    <div hidden aria-hidden="true" data-testid="view-chunk-warmer">
      <OverviewView journalId={null} />
      <CalendarView journalId={null} selectedDate={null} onDaySelect={() => {}} />
      <MediaGridView journalId={null} onEntrySelect={() => {}} chunkWarmup />
    </div>
  )
}

interface TimelineViewProps {
  journalId: string | null
  selectedEntryId?: string | null
  onEntrySelect?: (entryId: string) => void
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  /** Called whenever the ordered list of navigable cards (entries + day cards) changes — keyboard navigation. */
  onTargetsChange?: (targets: TimelineTarget[]) => void
  /** Tages-Karte: gewählter UTC-Tag (Timeline wie Kalender) und Auswahl-Callback der Karte. */
  selectedDate?: string | null
  onDaySelect?: (date: string) => void
  /** Kalender-Tipp: meldet den Tag mit seinen Einträgen — die Seite entscheidet Einzelansicht/Vorschau. */
  onCalendarDaySelect?: (date: string, entries: TimelineEntry[]) => void
  activeFilters: ActiveFilters
  onFiltersChange: (f: ActiveFilters) => void
  availableTags: Tag[]
  onNewEntry?: () => void
  /** Increment to force a fresh data fetch — used when the editor closes after an offline save. */
  refreshNonce?: number
  /** Öffnet die Vollbild-Lese-Ansicht "An diesem Tag" (Overview-Karte). */
  onOpenOnThisDay?: () => void
}

export function TimelineView({
  journalId,
  selectedEntryId,
  onEntrySelect,
  viewMode,
  onViewChange,
  onTargetsChange,
  selectedDate,
  onDaySelect,
  onCalendarDaySelect,
  activeFilters,
  onFiltersChange,
  availableTags,
  onNewEntry,
  refreshNonce,
  onOpenOnThisDay,
}: TimelineViewProps) {
  const { messages, locale } = useI18n()
  const online = useOnline()
  const [page, setPage] = useState(1)
  const [allDateGroups, setAllDateGroups] = useState<DateGroup[]>([])
  const [totalEntries, setTotalEntries] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  /** The infinite-scroll sentinel is a VIRTUALIZED row — it mounts only while
   *  the list end is inside the overscan window. A plain ref would be null when
   *  the observer effect runs after a page load (user near the top) and no
   *  effect re-runs on the later mount, so page 2+ would never be requested.
   *  State instead of ref: the mount itself must re-trigger the effect. */
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null)

  // Ref to the Radix ScrollArea viewport — the actual scrollable element
  const viewportRef = useRef<HTMLDivElement>(null)

  // Search state — local only; filters are lifted to page.tsx
  const [searchQuery, setSearchQuery] = useState("")

  const handleEntrySelect = useCallback((id: string) => onEntrySelect?.(id), [onEntrySelect])
  const handleResetFilters = useCallback(() => {
    setSearchQuery("")
    onFiltersChange(DEFAULT_FILTERS)
  }, [])
  const filtersActive = isFilterActive(activeFilters, searchQuery)

  // Stable filter keys for effect deps
  const filterTagsKey = activeFilters.tags.join(",")
  const { starred, mediaType, before, pinned } = activeFilters

  /** Preview URLs for photos still in the offline outbox, keyed by outbox id.
   *  Held for the component's lifetime and reused across reloads: the virtualiser
   *  remounts cards while scrolling, and a remount re-requests the URL. */
  const pendingPreviewUrls = useRef(new Map<string, string>())
  /** Pending-media loads are chained — two overlapping runs would mutate
   *  the shared URL cache against each other (revoke/create races). */
  const pendingLoadChain = useRef<Promise<unknown>>(Promise.resolve())
  /** Set on unmount, checked by still-running load continuations — a URL
   *  created after clearPreviewUrlCache ran would otherwise never be revoked. */
  const unmountedRef = useRef(false)
  useEffect(() => {
    const cache = pendingPreviewUrls.current
    return () => {
      unmountedRef.current = true
      clearPreviewUrlCache(cache)
    }
  }, [])


  // Reset accumulated entries whenever journal filter, search, view, or refresh nonce changes
  useEffect(() => {
    setPage(1)
    setAllDateGroups([])
    setTotalEntries(0)
    setHasNextPage(false)
    if (viewMode === "timeline") setLoading(true)
  }, [journalId, searchQuery, starred, filterTagsKey, mediaType, before, pinned, viewMode, refreshNonce])

  // Fetch entries — appends on page > 1, replaces on page 1
  useEffect(() => {
    if (viewMode !== "timeline") return

    // Filter „Offline verfügbar": Quelle ist der lokale Pin-Store —
    // der Server wird nie gefragt, online und Flugmodus verhalten sich
    // identisch (das ist die Wahrheit DIESES Geräts; nach Sync deckungsgleich
    // mit Server-pinned_at). Ein per Pull adoptierter Pin mit ausstehendem
    // Medien-Backfill (mediaUrlsPending) zählt mit — er IST gepinnt. Keine
    // Pagination: der Bestand ist durchs 200-MiB-Pin-Budget begrenzt.
    // mediaType/before greifen hier wie im Offline-Fallback nicht (IDB-Pfad
    // kennt beide nicht — vorbestehende Grenze, kein neuer Kontrakt).
    if (pinned) {
      let cancelled = false
      setLoading(true)
      const loadPinnedView = async () => {
        try {
          const [idbEntries, pins, pendingQueue, pendingMedia] = await Promise.all([
            realIDBAdapter.getAllEntries(),
            realIDBAdapter.listPins(),
            realIDBAdapter.listQueue(),
            chainSequential(pendingLoadChain, () =>
              loadPendingMediaByEntry(pendingPreviewUrls.current)
            ),
          ])
          if (cancelled) {
            if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
            return
          }
          let groups = syncEntriesToDateGroups(idbEntries, {
            journalId: journalId ?? undefined,
            q: searchQuery || undefined,
            starred: activeFilters.starred || undefined,
            tags: activeFilters.tags.length > 0 ? activeFilters.tags : undefined,
            pinnedIds: new Set(pins.map((p) => p.entryId)),
          })
          if (pendingQueue.length > 0) {
            const pendingIds = new Set(
              pendingQueue.filter((q) => q.operation !== "delete").map((q) => q.entryId)
            )
            for (const group of groups) {
              for (const entry of group.entries) {
                if (pendingIds.has(entry.id)) entry.pending = true
              }
            }
          }
          groups = await applyCachedMediaToGroups(realIDBAdapter, groups)
          if (cancelled) {
            if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
            return
          }
          groups = applyPendingMediaToGroups(groups, pendingMedia)
          // Anders als der Offline-Fallback IMMER setzen — null Treffer heißt
          // hier Empty-State („kein Eintrag offline verfügbar"), nicht
          // „Server-Daten stehen lassen".
          setAllDateGroups(groups)
          setTotalEntries(groups.reduce((n, g) => n + g.entries.length, 0))
          setHasNextPage(false)
        } catch (idbErr) {
          console.error("[within/timeline] pinned-filter IDB load failed:", idbErr)
          setAllDateGroups([])
          setTotalEntries(0)
          setHasNextPage(false)
        }
        if (!cancelled) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
      void loadPinnedView()
      return () => {
        cancelled = true
      }
    }

    const controller = new AbortController()
    // abort() only stops the fetch — the async continuation below keeps
    // running through its IDB awaits. Without this flag a stale run overwrites
    // the state of a newer filter/journal combination.
    let cancelled = false

    if (page === 1) setLoading(true)
    else setLoadingMore(true)

    const params = new URLSearchParams({ page: String(page), perPage: "25" })
    if (journalId) params.set("journalId", journalId)
    if (searchQuery) params.set("q", searchQuery)
    if (activeFilters.starred) params.set("starred", "true")
    if (activeFilters.tags.length > 0) params.set("tags", filterTagsKey)
    if (activeFilters.mediaType) params.set("mediaType", activeFilters.mediaType)
    if (activeFilters.before) params.set("before", activeFilters.before)

    fetch(`/api/entries?${params}`, { signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(async (data: PaginatedTimeline) => {
        if (cancelled) return
        if (page === 1) {
          let dateGroups = data.dateGroups
          try {
            const queue = await realIDBAdapter.listQueue()
            if (queue.length > 0) {
              dateGroups = mergePendingIntoDateGroups(data.dateGroups, queue)
            }
          } catch { /* IDB unavailable — show server data only */ }
          if (cancelled) return
          // Being online is no guarantee a picked file already made it up: the
          // upload may be running, failed, or out of retries, and then the server
          // serves the entry without it. So the outbox is folded in here too, not
          // just in the offline branch below.
          const pendingMedia = await chainSequential(pendingLoadChain, () =>
            loadPendingMediaByEntry(pendingPreviewUrls.current)
          )
          if (cancelled) {
            // Unmounted mid-load: the cleanup already emptied the cache, so
            // whatever this run just created would leak — revoke it here. On a
            // mere re-run the cache stays: the next (chained) run reuses it.
            if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
            return
          }
          dateGroups = applyPendingMediaToGroups(dateGroups, pendingMedia)
          setAllDateGroups(dateGroups)
          viewportRef.current?.scrollTo({ top: 0, behavior: "instant" })
          // Use the merged count so pending-only entries are visible even when
          // the server reports totalEntries=0 (empty DB or first offline save).
          const mergedTotal = dateGroups.reduce((n, g) => n + g.entries.length, 0)
          setTotalEntries(Math.max(data.totalEntries, mergedTotal))
          setHasNextPage(data.hasNextPage)
        } else {
          // Infinite-scroll pages need the outbox folded in too, else an
          // offline attachment on an older entry (beyond page 1) shows neither
          // thumbnail nor count. Applied to the NEW page only, before the merge:
          // mergeDateGroups keeps the existing (already patched) entry on a
          // pagination shift, so patching the merge result would double-count.
          const pendingMedia = await chainSequential(pendingLoadChain, () =>
            loadPendingMediaByEntry(pendingPreviewUrls.current)
          )
          if (cancelled) {
            if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
            return
          }
          const patchedPage = applyPendingMediaToGroups(data.dateGroups, pendingMedia)
          setAllDateGroups((prev) => mergeDateGroups(prev, patchedPage))
          setTotalEntries(data.totalEntries)
          setHasNextPage(data.hasNextPage)
        }
        setLoading(false)
        setLoadingMore(false)
      })
      .catch(async (err: unknown) => {
        if ((err as Error).name === "AbortError") return
        if (cancelled) return
        // Network failed on page 1 — try reading from IndexedDB (offline fallback)
        if (page === 1) {
          try {
            const [idbEntries, pendingQueue, pendingMedia] = await Promise.all([
              realIDBAdapter.getAllEntries(),
              realIDBAdapter.listQueue(),
              chainSequential(pendingLoadChain, () =>
                loadPendingMediaByEntry(pendingPreviewUrls.current)
              ),
            ])
            if (cancelled) {
              if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
              return
            }
            let groups = syncEntriesToDateGroups(idbEntries, {
              journalId: journalId ?? undefined,
              q: searchQuery || undefined,
              starred: activeFilters.starred || undefined,
              tags: activeFilters.tags.length > 0 ? activeFilters.tags : undefined,
            })
            // Mark queued entries as pending so the timeline shows the Pending badge
            if (pendingQueue.length > 0) {
              const pendingIds = new Set(
                pendingQueue.filter((q) => q.operation !== "delete").map((q) => q.entryId)
              )
              for (const group of groups) {
                for (const entry of group.entries) {
                  if (pendingIds.has(entry.id)) entry.pending = true
                }
              }
            }
            // Base media counts come from the entry-media cache — the
            // same source the offline detail view reads. Without this a card
            // says "1 Foto" (nur das wartende) while the detail shows 4.
            // Staleness handled by the sync pull (engine.ts).
            groups = await applyCachedMediaToGroups(realIDBAdapter, groups)
            if (cancelled) {
              if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
              return
            }
            // Offline the sync protocol carries no media metadata at all, so
            // without this the card of an entry with a queued photo shows no
            // preview and no count.
            groups = applyPendingMediaToGroups(groups, pendingMedia)
            if (groups.length > 0) {
              const total = groups.reduce((n, g) => n + g.entries.length, 0)
              setAllDateGroups(groups)
              setTotalEntries(total)
              setHasNextPage(false)
            }
          } catch (idbErr) {
            // IDB also unavailable — leave empty state. Log loudly: an empty
            // offline timeline looks identical to "no entries", so without this
            // the actual fault (blocked upgrade, quota, VersionError) is
            // invisible on a phone.
            console.error("[within/timeline] offline IDB fallback failed:", idbErr)
          }
        }
        if (cancelled) return
        // A failed page-N load must rewind the page counter: the reattached
        // observer fires immediately on a visible sentinel, and without the
        // rewind it would request page N+1 next — silently skipping page N's
        // entries for the rest of the session.
        if (page > 1) setPage((p) => Math.max(1, p - 1))
        setLoading(false)
        setLoadingMore(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [journalId, searchQuery, starred, filterTagsKey, mediaType, before, pinned, page, viewMode, refreshNonce])

  // Flat item list for the virtualizer — recomputed only when data changes
  const flatItems = useMemo(
    () => (totalEntries > 0 ? buildFlatItems(allDateGroups, locale) : []),
    [allDateGroups, totalEntries, locale]
  )

  // Notify parent of the ordered navigable cards (keyboard navigation + Tages-
  // Vorschau). Nur mit geladener Timeline: während eines Reloads oder in einer
  // anderen Ansicht ist flatItems leer, und der Elternteil darf daraus nicht
  // „der Tag existiert nicht mehr" schließen.
  useEffect(() => {
    if (!onTargetsChange || loading || viewMode !== "timeline") return
    onTargetsChange(timelineTargets(flatItems))
  }, [flatItems, onTargetsChange, loading, viewMode])

  // Virtualizer — measure mode: uses ResizeObserver on each rendered row so
  // variable-height cards (text length, thumbnails, tags) don't cause scroll drift.
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 80,
    measureElement:
      typeof window !== "undefined"
        ? (el) => el.getBoundingClientRect().height
        : undefined,
    overscan: 5,
  })

  // IntersectionObserver: auto-load next page when sentinel enters viewport
  useEffect(() => {
    if (!sentinelEl || !hasNextPage || loadingMore || loading) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setPage((p) => p + 1)
      },
      { rootMargin: "150px" }
    )
    observer.observe(sentinelEl)
    return () => observer.disconnect()
  }, [sentinelEl, hasNextPage, loadingMore, loading])

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="flex flex-col h-full">
      <ViewChunkWarmer />
      <TimelineToolbar
        viewMode={viewMode}
        onViewChange={onViewChange}
        hasActiveSearch={searchQuery.length > 0}
        onSearchChange={setSearchQuery}
        activeFilters={activeFilters}
        onFiltersChange={onFiltersChange}
        availableTags={availableTags}
        journalId={journalId}
      />

      {/* Media view */}
      {viewMode === "media" && (
        <MediaGridView
          journalId={journalId}
          onEntrySelect={onEntrySelect ?? (() => {})}
          refreshNonce={refreshNonce}
        />
      )}

      {/* Calendar view */}
      {viewMode === "calendar" && (
        <CalendarView
          journalId={journalId}
          selectedDate={selectedDate ?? null}
          onDaySelect={onCalendarDaySelect ?? (() => {})}
        />
      )}

      {/* Overview / stats view */}
      {viewMode === "overview" && (
        <OverviewView
          journalId={journalId}
          refreshNonce={refreshNonce}
          onOpenOnThisDay={onOpenOnThisDay}
        />
      )}

      {/* Map view — online-gebunden: offline Hinweis statt Chunk-Import (Deep-Link/Netzabriss) */}
      {viewMode === "map" && (online ? (
        <MapView
          journalId={journalId}
          selectedEntryId={selectedEntryId ?? null}
          onEntrySelect={onEntrySelect ?? (() => {})}
        />
      ) : (
        <p data-testid="map-offline-notice" className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {messages.timeline.toolbar.mapOffline}
        </p>
      ))}

      {/* Timeline view */}
      {viewMode === "timeline" && (
        <>
          {loading ? (
            <TimelineSkeleton />
          ) : totalEntries === 0 ? (
            <EmptyState
              isFiltered={filtersActive}
              onNewEntry={onNewEntry}
              onClearFilters={handleResetFilters}
            />
          ) : (
            <ScrollAreaPrimitive.Root className="relative overflow-hidden flex-1">
              <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                className="h-full w-full"
              >
                {/* Outer div sized to total virtual height — virtualizer positions items absolutely within it */}
                <div
                  className="pb-4 relative"
                  style={{ height: `${virtualizer.getTotalSize()}px` }}
                >
                  {virtualItems.map((vItem) => {
                    const item = flatItems[vItem.index]

                    return (
                      <div
                        key={vItem.key}
                        data-index={vItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem.start}px)`,
                        }}
                      >
                        {item.kind === "month-header" && (
                          <div className="px-4 pt-6 pb-2">
                            <span className="block text-[10px] font-bold tracking-[0.18em] text-muted-foreground/50 uppercase leading-none">
                              {item.month}
                            </span>
                            <div className="flex items-baseline gap-2 mt-[5px]">
                              <span className="text-[22px] font-bold leading-none text-foreground/85 tabular-nums">
                                {item.year}
                              </span>
                              <span className="text-[11px] font-medium text-muted-foreground/50 leading-none">
                                {messages.common.entryCount(item.entryCount)}
                              </span>
                            </div>
                          </div>
                        )}

                        {item.kind === "entry" && (
                          <EntryCard
                            entry={item.entry}
                            isSelected={selectedEntryId === item.entry.id}
                            onSelect={onEntrySelect ? handleEntrySelect : undefined}
                            showDate={item.showDate}
                          />
                        )}

                        {item.kind === "day" && (
                          <DayCard
                            group={item.group}
                            // Auch hervorheben, wenn ein Eintrag DIESES Tages per Sprung
                            // (Medien, Kalender, Karte, Palette) geöffnet ist.
                            isSelected={
                              selectedDate === item.group.date ||
                              (!!selectedEntryId && item.group.entries.some((e) => e.id === selectedEntryId))
                            }
                            onSelect={onDaySelect}
                          />
                        )}

                        {item.kind === "sentinel" && (
                          <div
                            ref={setSentinelEl}
                            className="flex items-center justify-center py-6 min-h-[60px]"
                          >
                            {loadingMore && (
                              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </ScrollAreaPrimitive.Viewport>
              <ScrollBar />
              <ScrollAreaPrimitive.Corner />
            </ScrollAreaPrimitive.Root>
          )}
        </>
      )}
    </div>
  )
}
