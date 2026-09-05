"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Suspense } from "react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { BookOpenText, PencilLine } from "lucide-react"
import { cn } from "@/lib/utils"
import { JournalSidebar } from "@/components/journal-sidebar"
import { TimelineView } from "@/components/timeline/timeline-view"
import { EntryDetail } from "@/components/detail/entry-detail"
import { DayDetail } from "@/components/detail/day-detail"
import { EntryEditor } from "@/components/editor/entry-editor"
import { OnThisDayView } from "@/components/on-this-day/on-this-day-view"
import { TimelineSkeleton } from "@/components/timeline/timeline-skeleton"
import { SyncBadge } from "@/components/sync/sync-badge"
import { CommandPalette } from "@/components/command-palette"
import { useHotkeys } from "@/hooks/use-hotkeys"
import { loadJournals } from "@/lib/journals/load-journals"
import {
  resolvePanelMode,
  panelTakesOverMobile,
  calendarDayTarget,
  daySelectionOrphaned,
  selectedDayEntries,
  sameEntryIds,
  type DaySelection,
} from "@/lib/timeline/panel-mode"
import { loadDayFull } from "@/lib/timeline/day-entries"
import type { TimelineTarget } from "@/lib/timeline-virtual-items"
import { useSyncContext } from "@/components/sync/sync-provider"
import { syncRequiresMediaRefresh } from "@/lib/sync/refresh-rules"
import { useI18n } from "@/components/locale-provider"
import type { Journal, ViewMode, ActiveFilters, Tag, JournalEntryDetail, TimelineEntry } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"

function JournalPage() {
  const { messages } = useI18n()
  const searchParams = useSearchParams()
  const router = useRouter()
  const journalId = searchParams.get("journal")
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  // Tages-Vorschau: Ein Tag mit 2+ Einträgen ist in der
  // Timeline eine Karte; ihr Klick zeigt rechts alle Einträge des Tages (nur Lesen).
  // Bleibt gesetzt, während ein Eintrag daraus geöffnet ist — Zurück landet im Tag.
  // Trägt ihre Herkunft: aus dem Kalender kommen die Einträge mit, aus
  // der Timeline stammen sie aus den Karten (panel-mode.ts).
  const [daySelection, setDaySelection] = useState<DaySelection | null>(null)
  const selectedDate = daySelection?.date ?? null
  const [showNewEntry, setShowNewEntry] = useState(false)
  // Editing runs inline instead of navigating to /entry/<id>/edit — that route is
  // not precached, so offline the service worker serves the '/' shell and the
  // editor never appears.
  const [editingEntry, setEditingEntry] = useState<JournalEntryDetail | null>(null)
  // Vollbild-Lese-Ansicht "An diesem Tag" — inline statt eigener Route, damit
  // sie offline aus dem precachten '/'-Shell heraus funktioniert.
  const [showOnThisDay, setShowOnThisDay] = useState(false)
  const [detailNonce, setDetailNonce] = useState(0)
  const [journals, setJournals] = useState<Journal[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>("timeline")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [navTargets, setNavTargets] = useState<TimelineTarget[]>([])
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>(DEFAULT_FILTERS)
  const [availableTags, setAvailableTags] = useState<Tag[]>([])
  const [timelineNonce, setTimelineNonce] = useState(0)

  // Network-first with IDB fallback: offline the editor still needs a real
  // journalId, otherwise queued edits are rejected on sync forever.
  useEffect(() => {
    void loadJournals().then(setJournals)
  }, [])

  // A sync run that uploaded media happened AFTER open views read
  // server + outbox — the photo sits in neither source and the entry-media
  // cache was written stale. Refetching heals display, cache and pin list;
  // no event other than this one triggers a reload (refresh-rules.ts).
  const { lastResult } = useSyncContext()
  useEffect(() => {
    if (!syncRequiresMediaRefresh(lastResult)) return
    // Synchronisation MIT einem externen System (Sync-Engine-Ergebnis), genau
    // ein zusätzlicher Re-Render — der Zweck der Nonces, keine Kaskade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimelineNonce((n) => n + 1)
    setDetailNonce((n) => n + 1)
  }, [lastResult])

  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then(setAvailableTags)
      .catch(() => {})
  }, [])

  // Einzelkarte und alle Sprünge (Medien, Kalender, Karte, Palette, „An diesem
  // Tag") öffnen die Einzelansicht und wählen den Tag ab.
  const selectEntry = useCallback((id: string) => {
    setDaySelection(null)
    setSelectedEntryId(id)
  }, [])
  const selectDay = useCallback((date: string) => {
    setSelectedEntryId(null)
    setDaySelection({ source: "timeline", date })
  }, [])
  // Kalender-Tipp: der Kalender meldet den Tag mit seinen
  // Einträgen — ein Eintrag → Einzelansicht, 2+ → Tages-Vorschau, keiner → nichts.
  const selectCalendarDay = useCallback((date: string, entries: TimelineEntry[]) => {
    const target = calendarDayTarget(date, entries)
    if (!target) return
    if (target.kind === "entry") selectEntry(target.id)
    else {
      setSelectedEntryId(null)
      setDaySelection(target.selection)
    }
  }, [selectEntry])

  function handleJournalSelect(id: string | null) {
    setSelectedEntryId(null)
    setDaySelection(null)
    if (id) {
      router.push(`/?journal=${id}`)
    } else {
      router.push("/")
    }
  }

  function handleNewEntry() {
    setSelectedEntryId(null)
    setDaySelection(null)
    setEditingEntry(null)
    setShowNewEntry(true)
  }

  function handleCloseEditor() {
    setEditingEntry(null)
    // The detail panel below still holds the pre-edit version — force a refetch.
    setDetailNonce((n) => n + 1)
    setTimelineNonce((n) => n + 1)
  }

  // Tages-Vorschau folgt der Timeline: Verschwindet die Tages-Karte (Löschen,
  // Datum verschoben, Filter), löst sich die Auswahl auf — übrig gebliebener
  // Einzeleintrag wird Einzelansicht, sonst leer. Kein verwaistes Panel. Gilt
  // nur für die Timeline-Herkunft: ein Kalender-Tag steht nie in den Zielen.
  useEffect(() => {
    if (!daySelectionOrphaned(daySelection, navTargets)) return
    const solo = navTargets.find((t) => t.kind === "entry" && t.date === daySelection?.date)
    setDaySelection(null)
    if (solo?.kind === "entry" && !selectedEntryId) setSelectedEntryId(solo.id)
  }, [navTargets, daySelection, selectedEntryId])

  // Kalender-Herkunft folgt Bearbeiten/Löschen/Sync (timelineNonce): den Tag neu
  // laden und dieselbe Regel anwenden — schrumpft er auf einen Eintrag, wird der
  // zur Einzelansicht (falls nichts offen ist), auf keinen → Auswahl weg. Gleiche
  // Einträge behalten ihre Identität (sonst lüde DayDetail über die Dep `entries`
  // ein zweites Mal); ein Doppelfehler (Netz + IDB → null) lässt die Vorschau stehen.
  const seenNonce = useRef(timelineNonce)
  useEffect(() => {
    if (timelineNonce === seenNonce.current) return
    seenNonce.current = timelineNonce
    if (daySelection?.source !== "calendar") return
    let cancelled = false
    void loadDayFull(daySelection.date, journalId).then((data) => {
      if (cancelled || !data) return
      const target = calendarDayTarget(daySelection.date, data.entries)
      if (target?.kind === "day") {
        if (!sameEntryIds(target.selection.entries, daySelection.entries)) setDaySelection(target.selection)
        return
      }
      setDaySelection(null)
      if (target?.kind === "entry") setSelectedEntryId((current) => current ?? target.id)
    })
    return () => { cancelled = true }
  }, [timelineNonce, daySelection, journalId])

  const dayEntries = useMemo(() => selectedDayEntries(daySelection, navTargets), [daySelection, navTargets])

  const navigateEntry = useCallback(
    (direction: "prev" | "next") => {
      if (navTargets.length === 0) return
      const nothingSelected = !selectedEntryId && !selectedDate
      let idx = -1
      if (!nothingSelected) {
        // Position: Einzelkarte per Eintrag, sonst die Tages-Karte — die gewählte
        // oder die, die den (per Sprung) geöffneten Eintrag enthält. Ohne Karte in
        // der geladenen Timeline (Kalender-Tag außerhalb des Fensters, Sprung aus
        // Medien/Palette) bleibt j/k ein No-op — kein Sprung in eine Liste, die
        // gerade nicht zu sehen ist (in der Kalenderansicht sind die Ziele der
        // letzte Timeline-Stand).
        idx = navTargets.findIndex((t) =>
          t.kind === "entry"
            ? t.id === selectedEntryId
            : t.date === selectedDate || (!!selectedEntryId && t.entries.some((e) => e.id === selectedEntryId))
        )
        if (idx === -1) return
      }
      const target = nothingSelected
        ? direction === "next" ? navTargets[0] : navTargets[navTargets.length - 1]
        : navTargets[direction === "next" ? idx + 1 : idx - 1]
      if (!target) return
      if (target.kind === "entry") selectEntry(target.id)
      else selectDay(target.date)
    },
    [selectedEntryId, selectedDate, navTargets, selectEntry, selectDay]
  )

  useHotkeys([
    {
      key: "n",
      cmdOrCtrl: true,
      handler(e) {
        e.preventDefault()
        handleNewEntry()
      },
    },
    {
      key: "k",
      cmdOrCtrl: true,
      handler(e) {
        e.preventDefault()
        setPaletteOpen(true)
      },
    },
    {
      key: "Escape",
      handler() {
        if (paletteOpen) return
        if (selectedEntryId) setSelectedEntryId(null)
        else if (selectedDate) setDaySelection(null)
      },
    },
    {
      key: "ArrowUp",
      handler(e) {
        if (!paletteOpen) { e.preventDefault(); navigateEntry("prev") }
      },
    },
    {
      key: "ArrowDown",
      handler(e) {
        if (!paletteOpen) { e.preventDefault(); navigateEntry("next") }
      },
    },
    {
      key: "k",
      handler() {
        if (!paletteOpen) navigateEntry("prev")
      },
    },
    {
      key: "j",
      handler() {
        if (!paletteOpen) navigateEntry("next")
      },
    },
  ])

  const panelState = {
    selectedEntryId,
    editingEntryId: editingEntry?.id ?? null,
    showNewEntry,
    selectedDate,
  }
  const panelMode = resolvePanelMode(panelState)

  return (
    <SidebarProvider defaultOpen={true} className="!min-h-0 h-dvh overflow-hidden">
      <JournalSidebar
        journals={journals}
        selectedJournalId={journalId}
        onJournalSelect={handleJournalSelect}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        availableTags={availableTags}
      />
      <SidebarInset
        className="overflow-hidden flex flex-col page-enter"
        style={{ minHeight: 0 }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-4 pt-safe" style={{ minHeight: "calc(3rem + var(--safe-top))" }}>
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-medium text-muted-foreground flex-1">
            {journalId
              ? journals.find((j) => j.id === journalId)?.name ?? messages.home.journalFallback
              : messages.home.allEntries}
          </h1>
          <SyncBadge />
          <Button
            size="sm"
            onClick={handleNewEntry}
            title={messages.home.newEntryShortcutTitle}
            className="gap-1.5 h-8"
          >
            <PencilLine className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{messages.home.newEntry}</span>
          </Button>
        </header>

        <div className="flex flex-1 min-h-0">
          {/* Timeline Panel — fixed width, independent scroll */}
          <div
            className={cn(
              "flex flex-col overflow-hidden border-r",
              panelTakesOverMobile(panelState)
                ? "hidden md:flex md:w-[440px] md:min-w-[440px] md:shrink-0"
                : "flex-1 md:flex-none md:w-[440px] md:min-w-[440px] md:shrink-0"
            )}
          >
            <TimelineView
              journalId={journalId}
              selectedEntryId={selectedEntryId}
              onEntrySelect={selectEntry}
              selectedDate={selectedDate}
              onDaySelect={selectDay}
              onCalendarDaySelect={selectCalendarDay}
              viewMode={viewMode}
              onViewChange={setViewMode}
              onTargetsChange={setNavTargets}
              activeFilters={activeFilters}
              onFiltersChange={setActiveFilters}
              availableTags={availableTags}
              onNewEntry={handleNewEntry}
              refreshNonce={timelineNonce}
              onOpenOnThisDay={() => setShowOnThisDay(true)}
            />
          </div>

          {/* Detail Panel — fills remaining width, independent scroll */}
          {panelMode === "edit" && editingEntry ? (
            <div className="flex-1 min-w-0 overflow-hidden">
              <EntryEditor
                key={editingEntry.id}
                initialEntry={editingEntry}
                journals={journals}
                onClose={handleCloseEditor}
                onDeleted={() => {
                  setEditingEntry(null)
                  setSelectedEntryId(null)
                  setTimelineNonce((n) => n + 1)
                }}
              />
            </div>
          ) : panelMode === "detail" && selectedEntryId ? (
            <div className="flex-1 min-w-0 overflow-hidden">
              <EntryDetail
                entryId={selectedEntryId}
                onBack={() => setSelectedEntryId(null)}
                onEdit={setEditingEntry}
                reloadNonce={detailNonce}
                onDeleted={() => setTimelineNonce((n) => n + 1)}
                onPinChanged={() => setTimelineNonce((n) => n + 1)}
              />
            </div>
          ) : panelMode === "day" && selectedDate ? (
            <div className="flex-1 min-w-0 overflow-hidden">
              <DayDetail
                date={selectedDate}
                entries={dayEntries}
                journalId={journalId}
                onBack={() => setDaySelection(null)}
                onOpenEntry={setSelectedEntryId}
                reloadNonce={timelineNonce}
              />
            </div>
          ) : panelMode === "new" ? (
            <div className="flex-1 min-w-0 overflow-hidden">
              <EntryEditor
                journals={journals}
                defaultJournalId={journalId ?? undefined}
                onClose={() => { setShowNewEntry(false); setTimelineNonce((n) => n + 1) }}
              />
            </div>
          ) : (
            <div className="hidden md:flex flex-col flex-1 items-center justify-center gap-3 text-muted-foreground/60 select-none">
              <BookOpenText className="h-10 w-10 opacity-30" aria-hidden="true" />
              <p className="text-sm font-medium">{messages.home.selectEntry}</p>
            </div>
          )}
        </div>

        {/* Mobile FAB -- only visible on < md, only when timeline panel is showing */}
        {!selectedEntryId && !showNewEntry && !selectedDate && (
          <button
            onClick={handleNewEntry}
            aria-label={messages.home.newEntry}
            className={cn(
              "md:hidden fixed right-4 size-14 rounded-full",
              "bg-primary text-primary-foreground shadow-lg",
              "flex items-center justify-center",
              "transition-transform duration-fast active:scale-95",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
            style={{ bottom: "calc(16px + var(--safe-bottom))" }}
          >
            <PencilLine className="size-6" />
          </button>
        )}
      </SidebarInset>

      {/* Vollbild-Lese-Ansicht "An diesem Tag" — überlagert beide Panels */}
      {showOnThisDay && (
        <OnThisDayView
          journalId={journalId}
          onClose={() => setShowOnThisDay(false)}
          onEntryOpen={selectEntry}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        journals={journals}
        journalId={journalId}
        onJournalSelect={handleJournalSelect}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onNewEntry={handleNewEntry}
        onEntrySelect={selectEntry}
      />
    </SidebarProvider>
  )
}

export default function Home() {
  return (
    <Suspense fallback={<TimelineSkeleton />}>
      <JournalPage />
    </Suspense>
  )
}
