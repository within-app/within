"use client"

import { useState, useEffect, useRef, type ReactNode } from "react"
import {
  BookOpen, Globe2, Search, SlidersHorizontal, X,
  Heart, Camera, Mic, Video, Layers, CalendarSearch, ChevronDown, ChevronRight,
  WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useI18n } from "@/components/locale-provider"
import { getDateFnsLocale } from "@/lib/i18n"
import type { Messages } from "@/lib/i18n"
import type { Month } from "date-fns"
import type { Locale } from "@/lib/i18n/config"
import type { ViewMode, ActiveFilters, MediaFilter, Tag } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"
import { countPanelFilters } from "@/lib/timeline/filter-utils"
import { useOnline } from "@/hooks/use-online"

function buildTabs(t: Messages["timeline"]["toolbar"]): { mode: ViewMode; label: string; icon?: ReactNode }[] {
  return [
    { mode: "overview", icon: <BookOpen className="h-3.5 w-3.5" />, label: t.tabs.overview },
    { mode: "timeline", label: t.tabs.timeline },
    { mode: "calendar", label: t.tabs.calendar },
    { mode: "media", label: t.tabs.media },
    { mode: "map", icon: <Globe2 className="h-3.5 w-3.5" />, label: t.tabs.map },
  ]
}

// "Alle" spiegelt den Sidebar-Eintrag "Medien" — ohne diesen Chip wäre dessen
// Filter im Panel weder sichtbar noch einzeln abwählbar.
function buildMediaOptions(
  t: Messages["timeline"]["toolbar"]
): { type: MediaFilter; label: string; Icon: typeof Camera }[] {
  return [
    { type: "any",   label: t.media.all,   Icon: Layers },
    { type: "photo", label: t.media.photo, Icon: Camera },
    { type: "audio", label: t.media.audio, Icon: Mic },
    { type: "video", label: t.media.video, Icon: Video },
  ]
}

function monthName(locale: Locale, monthIndex1to12: number): string {
  // date-fns Localize erwartet Month = 0–11
  return getDateFnsLocale(locale).localize.month((monthIndex1to12 - 1) as Month, { width: "wide" })
}

function formatBeforeLabel(before: string, locale: Locale, t: Messages["timeline"]["toolbar"]): string {
  const [year, month] = before.split("-")
  const monthIdx = parseInt(month, 10)
  const name = Number.isNaN(monthIdx) ? month : monthName(locale, monthIdx)
  return t.beforeLabel(name, year)
}

interface YearEntry { year: number; count: number }

interface TimelineToolbarProps {
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  hasActiveSearch: boolean
  onSearchChange: (q: string) => void
  activeFilters: ActiveFilters
  onFiltersChange: (f: ActiveFilters) => void
  availableTags: Tag[]
  journalId: string | null
}

export function TimelineToolbar({
  viewMode,
  onViewChange,
  hasActiveSearch,
  onSearchChange,
  activeFilters,
  onFiltersChange,
  availableTags,
  journalId,
}: TimelineToolbarProps) {
  const { messages, locale } = useI18n()
  const tb = messages.timeline.toolbar
  const TABS = buildTabs(tb)
  const MEDIA_OPTIONS = buildMediaOptions(tb)
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [expandedYear, setExpandedYear] = useState<number | null>(null)
  const [years, setYears] = useState<YearEntry[]>([])
  const [yearsLoading, setYearsLoading] = useState(false)
  const [yearsError, setYearsError] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const calendarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setTimeout(() => onSearchChange(inputValue.trim()), 350)
    return () => clearTimeout(id)
  }, [inputValue, onSearchChange])

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  // Fetch years when calendar popover opens
  useEffect(() => {
    if (!calendarOpen) return
    let cancelled = false
    setYearsError(false)
    setYearsLoading(true)
    const params = new URLSearchParams()
    if (journalId) params.set("journalId", journalId)
    fetch(`/api/entries/years${params.size ? `?${params}` : ""}`)
      .then((r) => r.json())
      .then((data: YearEntry[]) => {
        if (cancelled) return
        setYears(data)
        if (data.length > 0 && expandedYear === null) {
          setExpandedYear(data[0].year)
        }
      })
      .catch(() => { if (!cancelled) setYearsError(true) })
      .finally(() => { if (!cancelled) setYearsLoading(false) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarOpen, journalId])

  // Close calendar on outside click
  useEffect(() => {
    if (!calendarOpen) return
    function handler(e: MouseEvent) {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setCalendarOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [calendarOpen])

  function handleSearchToggle() {
    if (searchOpen) {
      setSearchOpen(false)
      setInputValue("")
      onSearchChange("")
    } else {
      setSearchOpen(true)
      setFilterOpen(false)
      setCalendarOpen(false)
    }
  }

  function handleFilterToggle() {
    setFilterOpen((o) => !o)
    if (!filterOpen) {
      setSearchOpen(false)
      setCalendarOpen(false)
    }
  }

  function handleCalendarToggle() {
    setCalendarOpen((o) => !o)
    if (!calendarOpen) {
      setSearchOpen(false)
      setFilterOpen(false)
    }
  }

  function clearInput() {
    setInputValue("")
    onSearchChange("")
    inputRef.current?.focus()
  }

  function clearAll() {
    setSearchOpen(false)
    setFilterOpen(false)
    setCalendarOpen(false)
    setInputValue("")
    onSearchChange("")
    onFiltersChange(DEFAULT_FILTERS)
  }

  function jumpToMonth(year: number, month: number) {
    const mm = String(month).padStart(2, "0")
    onFiltersChange({ ...activeFilters, before: `${year}-${mm}` })
    setCalendarOpen(false)
  }

  const activeFilterCount = countPanelFilters(activeFilters)
  // Karte ist online-gebunden (kein Chunk-Warming, Pi-Kacheln)
  // — offline durchgestrichen und gesperrt statt ChunkLoadError beim Klick.
  const online = useOnline()

  const anyActive = hasActiveSearch || activeFilterCount > 0 || activeFilters.before !== null

  return (
    <div className="shrink-0 border-b">
      {/* ── Main toolbar row ── */}
      <div className="flex items-center justify-between px-3 py-1.5">
        {/* View tabs */}
        <div className="flex items-center gap-0.5">
          {TABS.map(({ mode, label, icon }) => {
            const offlineLocked = mode === "map" && !online
            return (
              <button
                key={mode}
                onClick={() => { if (!offlineLocked) onViewChange(mode) }}
                disabled={offlineLocked}
                aria-disabled={offlineLocked || undefined}
                title={offlineLocked ? tb.mapOffline : icon ? label : undefined}
                className={cn(
                  "text-[13px] px-2 py-1 rounded-md transition-colors duration-fast",
                  offlineLocked
                    ? "text-muted-foreground/60 line-through cursor-not-allowed"
                    : viewMode === mode
                      ? "font-medium text-primary bg-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                {icon ?? label}
              </button>
            )
          })}
        </div>

        {/* Action buttons — only shown on timeline view */}
        {viewMode === "timeline" && (
          <div className="flex items-center gap-0.5">
            {/* Calendar jump */}
            <div className="relative" ref={calendarRef}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  (calendarOpen || activeFilters.before !== null) && "bg-primary/10 text-primary"
                )}
                onClick={handleCalendarToggle}
                aria-label={calendarOpen ? tb.calendarClose : tb.calendarOpen}
                aria-expanded={calendarOpen}
              >
                <CalendarSearch className="h-4 w-4" />
              </Button>

              {calendarOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border border-border bg-popover shadow-md"
                  role="dialog"
                  aria-label={tb.jumpDialogLabel}
                >
                  {/* Heute */}
                  <div className="border-b px-2 py-1.5">
                    <button
                      onClick={clearAll}
                      className="w-full text-left text-[12.5px] font-medium px-2 py-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
                    >
                      {messages.date.today}
                    </button>
                  </div>

                  {/* Year / month list */}
                  <div className="max-h-64 overflow-y-auto py-1">
                    {yearsLoading && (
                      <p className="text-[12px] text-muted-foreground px-4 py-3">{messages.common.loading}</p>
                    )}
                    {!yearsLoading && yearsError && (
                      <p className="text-[12px] text-destructive px-4 py-3">{tb.loadError}</p>
                    )}
                    {!yearsLoading && !yearsError && years.length === 0 && (
                      <p className="text-[12px] text-muted-foreground px-4 py-3">{tb.noEntries}</p>
                    )}
                    {!yearsLoading && years.map(({ year }) => (
                      <div key={year}>
                        <button
                          onClick={() => setExpandedYear(expandedYear === year ? null : year)}
                          className="flex w-full items-center justify-between px-3 py-1 text-[12.5px] font-semibold text-foreground hover:bg-accent/50 transition-colors"
                          aria-expanded={expandedYear === year}
                        >
                          {year}
                          {expandedYear === year
                            ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          }
                        </button>
                        {expandedYear === year && (
                          <div className="grid grid-cols-3 gap-0.5 px-2 pb-1">
                            {Array.from({ length: 12 }, (_, idx) => monthName(locale, idx + 1)).map((name, idx) => {
                              const mm = String(idx + 1).padStart(2, "0")
                              const isActive = activeFilters.before === `${year}-${mm}`
                              return (
                                <button
                                  key={idx}
                                  onClick={() => jumpToMonth(year, idx + 1)}
                                  className={cn(
                                    "text-[11px] px-1 py-1 rounded transition-colors text-center",
                                    isActive
                                      ? "bg-primary text-primary-foreground font-medium"
                                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                                  )}
                                >
                                  {name.slice(0, 3)}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Search */}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-7 w-7",
                (searchOpen || hasActiveSearch) && "bg-primary/10 text-primary"
              )}
              onClick={handleSearchToggle}
              aria-label={searchOpen ? tb.searchClose : tb.searchOpen}
            >
              <Search className="h-4 w-4" />
            </Button>

            {/* Filter — with badge */}
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  (filterOpen || activeFilterCount > 0) && "bg-primary/10 text-primary"
                )}
                onClick={handleFilterToggle}
                aria-label={filterOpen ? tb.filterClose : tb.filterOpen}
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
              {activeFilterCount > 0 && (
                <span className="pointer-events-none absolute -top-1 -right-1 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground leading-none">
                  {activeFilterCount}
                </span>
              )}
            </div>

            {/* Global clear */}
            {anyActive && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={clearAll}
                aria-label={tb.resetAll}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Search bar ── */}
      {viewMode === "timeline" && searchOpen && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 h-8 border border-border/40">
            <Search className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && handleSearchToggle()}
              placeholder={tb.searchPlaceholder}
              aria-label={tb.searchAriaLabel}
              className="flex-1 bg-transparent text-[13px] outline-none focus-visible:outline-none placeholder:text-muted-foreground/40"
            />
            {inputValue && (
              <button onClick={clearInput} className="text-muted-foreground/50 hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Filter panel ── */}
      {viewMode === "timeline" && filterOpen && (
        <div className="px-3 pb-3 pt-2 border-t space-y-3">

          {/* Starred */}
          <button
            onClick={() => onFiltersChange({ ...activeFilters, starred: !activeFilters.starred })}
            className={cn(
              "flex items-center gap-2 text-[12.5px] w-full rounded-md px-2 py-1.5 transition-colors",
              activeFilters.starred
                ? "bg-heart/10 text-heart"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            <Heart className={cn("h-3.5 w-3.5", activeFilters.starred && "fill-heart text-heart")} />
            {tb.starredOnly}
          </button>

          {/* Offline verfügbar: nur gepinnte Einträge — Quelle ist der
              lokale Pin-Store, der Filter funktioniert damit auch im Flugmodus. */}
          <button
            onClick={() => onFiltersChange({ ...activeFilters, pinned: !activeFilters.pinned })}
            className={cn(
              "flex items-center gap-2 text-[12.5px] w-full rounded-md px-2 py-1.5 transition-colors",
              activeFilters.pinned
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            <WifiOff className={cn("h-3.5 w-3.5", activeFilters.pinned && "text-primary")} />
            {tb.pinnedOnly}
          </button>

          {/* Tags */}
          {availableTags.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-1.5 px-1">
                {tb.tagsLabel}
              </p>
              <div className="flex flex-wrap gap-1">
                {availableTags.map((tag) => {
                  const active = activeFilters.tags.includes(tag.name)
                  return (
                    <button
                      key={tag.id}
                      onClick={() =>
                        onFiltersChange({
                          ...activeFilters,
                          tags: active
                            ? activeFilters.tags.filter((t) => t !== tag.name)
                            : [...activeFilters.tags, tag.name],
                        })
                      }
                      className={cn(
                        "text-[11.5px] px-2.5 py-0.5 rounded-full border transition-colors",
                        active
                          ? "bg-primary/10 border-primary/40 text-primary font-medium"
                          : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                      )}
                    >
                      {tag.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Media type */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-1.5 px-1">
              {tb.mediaLabel}
            </p>
            <div className="flex gap-1.5">
              {MEDIA_OPTIONS.map(({ type, label, Icon }) => (
                <button
                  key={type}
                  onClick={() =>
                    onFiltersChange({
                      ...activeFilters,
                      mediaType: activeFilters.mediaType === type ? null : type,
                    })
                  }
                  className={cn(
                    "flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-md border transition-colors",
                    activeFilters.mediaType === type
                      ? "bg-primary/10 border-primary/40 text-primary font-medium"
                      : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Reset */}
          {activeFilterCount > 0 && (
            <button
              onClick={() => onFiltersChange({ ...DEFAULT_FILTERS })}
              className="text-[11.5px] text-destructive/70 hover:text-destructive transition-colors px-1"
            >
              {tb.resetFilters}
            </button>
          )}
        </div>
      )}

      {/* ── Active month-jump chip ── */}
      {activeFilters.before !== null && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[12px] bg-primary/10 text-primary rounded-full px-3 py-0.5 font-medium">
            <CalendarSearch className="h-3 w-3" />
            {formatBeforeLabel(activeFilters.before, locale, tb)}
            <button
              onClick={() => onFiltersChange({ ...activeFilters, before: null })}
              className="ml-0.5 hover:opacity-70 transition-opacity"
              aria-label={tb.monthFilterReset}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
