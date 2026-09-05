"use client"

import { useState, useEffect, useCallback, useRef, useMemo, memo, type ComponentProps } from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { format, parseISO, startOfMonth, subMonths, isSameMonth } from "date-fns"
import type { DayButtonProps } from "react-day-picker"
import { Calendar, CalendarDayButton } from "@/components/ui/calendar"
import { ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { localDateKey } from "@/lib/format"
import { getDateFnsLocale } from "@/lib/i18n"
import { useI18n } from "@/components/locale-provider"
import type { CalendarData, TimelineEntry } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { idbToCalendarData } from "@/lib/sync/idb-to-views"
import { loadDayFull } from "@/lib/timeline/day-entries"
import { toZonedDate } from "@/lib/timezone"

/** Obergrenze der Monatsraster (wie bisher) — zugleich Zeitraum des Tageszähler-Requests. */
export const MAX_MONTHS = 24
/** Startfenster. Gerätebefund: 24 react-day-picker-Monate auf einmal
 *  (779 Tages-Buttons) blockierten den Hauptthread 600–900 ms bei 4× CPU-Drosselung,
 *  Medien lagen bei 45–100 ms. Drei Monate füllen ein Handy-Display; der Rest kommt
 *  per Sentinel beim Scrollen nach (Muster Medien-Grid/Timeline). */
export const INITIAL_MONTHS = 3
// intentionally minimal: auf sehr hohen Viewports (≥ ~1120 px) liegt der
// Sentinel schon im Beobachtungsband, das Fenster wächst dann im zweiten
// Commit auf 6 — bewusst nicht am Viewport bemessen.
const MONTHS_STEP = 3

/** Pure Fensterlogik — exportiert für den Unit-Test. */
export function nextMonthCount(current: number): number {
  return Math.min(MAX_MONTHS, current + MONTHS_STEP)
}

/** Per-month classNames — module-level, damit die Referenz über Renders hinweg
 *  stabil bleibt: DayPicker memoisiert classNames/components/formatters intern
 *  auf genau diesen Prop-Identitäten (siehe ui/calendar.tsx) — ein Objekt-
 *  literal hier würde dieses interne useMemo bei jedem Render invalidieren. */
const CALENDAR_CLASSNAMES = {
  root: "w-full",
  months: "flex flex-col",
  month: "w-full flex flex-col gap-2",
  month_caption: "flex h-[--cell-size] w-full items-center justify-start px-1 mb-1",
  caption_label: "text-[13px] font-semibold text-foreground",
  month_grid: "w-full border-collapse",
  weekdays: "flex w-full",
  weekday: "flex-1 text-center text-[0.7rem] text-muted-foreground/60 font-normal select-none pb-1",
  week: "flex w-full mt-0.5",
  day: "flex-1 group/day relative aspect-square p-0 text-center select-none",
}

interface CalendarViewProps {
  journalId: string | null
  /** Von der Seite gehaltener Tag (UTC-Schlüssel) — im Raster markiert, solange
   *  die Tages-Vorschau rechts offen ist. */
  selectedDate: string | null
  /** Tipp auf einen Tag: meldet den Tag mit seinen Einträgen. Die Seite entscheidet
   *  (calendarDayTarget): ein Eintrag → Einzelansicht, 2+ → Tages-Vorschau, keiner → nichts. */
  onDaySelect: (date: string, entries: TimelineEntry[]) => void
}

export function CalendarView({ journalId, selectedDate, onDaySelect }: CalendarViewProps) {
  const { messages, locale } = useI18n()
  // App-Zone statt Gerätezeit: toZonedDate liefert ein Date mit den Wanduhr-
  // Feldern der Zone, damit localDateKey (lokale Felder) den Kalendertag der
  // App-Zone trägt — sonst wichen "heute" und die Monatsgrenzen von der Zone ab.
  const today = useMemo(() => toZonedDate(new Date()), [])
  const startMonth = useMemo(() => subMonths(startOfMonth(today), MAX_MONTHS - 1), [today])
  // Months from current going backwards — newest first; only the current window is mounted
  const [monthCount, setMonthCount] = useState(INITIAL_MONTHS)
  const months = useMemo(
    () => Array.from({ length: monthCount }, (_, i) => subMonths(startOfMonth(today), i)),
    [today, monthCount]
  )
  // Sentinel unter dem letzten Monat: der Button ist im ersten Render bereits
  // committed, der Ref steht damit vor diesem Effekt — kein State-Umweg nötig.
  // Bleibt bei MAX_MONTHS gemountet (disabled statt entfernt, siehe unten) —
  // ohne den frühen Ausstieg hier würde ohnehin kein weiterer Observer mehr
  // gebraucht.
  const sentinelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!sentinelRef.current || monthCount >= MAX_MONTHS) return
    // Pro Fensterstand neu beobachten: observe() feuert einmal mit dem aktuellen
    // Zustand — bleibt der Sentinel nach dem Nachladen sichtbar, folgt so der
    // nächste Schritt, bis das Fenster den Bildschirm füllt. root muss die
    // ScrollArea-Viewport sein, sonst bezieht sich rootMargin auf den (nicht
    // scrollenden) Dokument-Viewport und bleibt wirkungslos.
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setMonthCount((n) => nextMonthCount(n)) },
      { root: scrollViewportRef.current, rootMargin: "150px" }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [monthCount])

  const [calendarData, setCalendarData] = useState<CalendarData>({})

  // Tages-Auswahl ist kontrolliert: die Markierung im Raster lebt genau so lange
  // wie die Tages-Vorschau rechts. parseISO liest den Tagesschlüssel als lokale
  // Mitternacht — so datiert DayPicker seine Zellen (localDateKey).
  const selected = useMemo(() => (selectedDate ? parseISO(selectedDate) : undefined), [selectedDate])

  // Ref for stable DayButton (avoids DayPicker remounting on every calendarData change)
  const calendarDataRef = useRef<CalendarData>(calendarData)
  calendarDataRef.current = calendarData // always current, read during render

  // Today string for ring marker — stable ref so DayButtonWithData stays stable
  const todayStr = useMemo(() => localDateKey(today), [today])
  const todayRef = useRef(todayStr)
  todayRef.current = todayStr

  // Ref to scroll viewport for "Heute" anchor (Radix primitive exposes the div directly)
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  function scrollToToday() {
    scrollViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }

  // Fetch all months in range on mount / journal change
  useEffect(() => {
    let cancelled = false
    const from = localDateKey(startMonth).slice(0, 7)
    const to = localDateKey(today).slice(0, 7)
    const params = new URLSearchParams({ from, to })
    if (journalId) params.set("journalId", journalId)
    fetch(`/api/calendar?${params}`)
      .then((r) => {
        // Fehler-Bodies (z.B. 503 bei DB-Ausfall) sind keine Kalenderdaten —
        // ohne den Check rendert der Kalender still "keine Einträge".
        if (!r.ok) throw new Error(`calendar request failed: ${r.status}`)
        return r.json()
      })
      .then((data) => { if (!cancelled) setCalendarData(data) })
      .catch(async () => {
        // Network failed — read calendar day-counts from IndexedDB
        try {
          const idbEntries = await realIDBAdapter.getAllEntries()
          if (!cancelled) setCalendarData(idbToCalendarData(idbEntries, journalId))
        } catch {
          if (!cancelled) setCalendarData({})
        }
      })
    return () => { cancelled = true }
  }, [journalId, startMonth, today])

  // Tipp auf einen Tag: die Einträge des Tages sind die Wahrheit für den
  // Kalender-Weg — derselbe Tages-Request wie die Vorschau (loadDayFull: Netz,
  // IDB-Fallback ohne Tombstones, null bei Doppelfehler → keine Meldung). Der
  // letzte Tipp gewinnt; nach Journalwechsel oder Unmount meldet eine späte
  // Antwort nichts mehr (sonst landeten Journal-A-Einträge unter Journal B).
  const pendingDate = useRef<string | null>(null)
  useEffect(() => () => { pendingDate.current = null }, [journalId])
  // triggerDate statt selected: ein zweiter Tipp auf den markierten Tag liefert
  // in mode="single" undefined (Abwählen) — hier zählt der getippte Tag,
  // geschlossen wird über Escape/Zurück. Stabile Identität (Deps ohne
  // calendarData), damit MonthCalendars memo bei Datenankunft hält.
  const handleDaySelect = useCallback(
    (_selected: Date | undefined, triggerDate: Date) => {
      const date = localDateKey(triggerDate)
      pendingDate.current = date
      void loadDayFull(date, journalId).then((data) => {
        if (data && pendingDate.current === date) onDaySelect(date, data.entries)
      })
    },
    [journalId, onDaySelect]
  )

  // Stable DayButton: reads from ref, never causes DayPicker remount
  const DayButtonWithData = useCallback(
    function DayButtonWithData({
      children,
      modifiers,
      className,
      day,
      ...rest
    }: DayButtonProps) {
      const dayStr = localDateKey(day.date)
      const dayData = calendarDataRef.current[dayStr]
      const hasThumbnail = Boolean(dayData?.thumbnail)
      const hasEntries = Boolean(dayData?.count)
      const isToday = dayStr === todayRef.current

      return (
        <CalendarDayButton
          day={day}
          modifiers={modifiers}
          className={cn(
            className,
            "relative overflow-hidden",
            isToday && !hasThumbnail && "ring-1 ring-primary ring-inset rounded-md"
          )}
          {...rest}
        >
          {/* Photo thumbnail as background */}
          {hasThumbnail && (
            <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden rounded-md">
              <img
                src={dayData!.thumbnail}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
              />
              {/* Darkening overlay so the number is readable */}
              <div className="absolute inset-0 bg-black/35 rounded-md" />
            </div>
          )}

          {/* Today ring overlay for days with a photo */}
          {isToday && hasThumbnail && (
            <div className="absolute inset-0 ring-1 ring-primary ring-inset rounded-md pointer-events-none z-20" />
          )}

          {/* Day number — white + bold over thumbnail, default otherwise */}
          <div
            className={cn(
              "relative z-10 tabular-nums leading-none text-sm",
              hasThumbnail && "text-white font-semibold drop-shadow-sm"
            )}
          >
            {children}
          </div>

          {/* Blue dot for entries without a photo */}
          {!hasThumbnail && hasEntries && (
            <div className="w-[5px] h-[5px] rounded-full bg-primary mx-auto relative z-10 flex-shrink-0" />
          )}
        </CalendarDayButton>
      )
    },
    [] // stable — reads data from ref
  )
  // Memoized, damit die Referenz stabil bleibt — hält DayPickers internes
  // useMemo (classNames/components/formatters-Deps, siehe ui/calendar.tsx)
  // gültig, statt es bei jedem Render zu invalidieren.
  const calendarComponents = useMemo(() => ({ DayButton: DayButtonWithData }), [DayButtonWithData])

  return (
    <div className="flex flex-col h-full">
      {/* ── "Heute" anchor button ─────────────────────────────── */}
      <div className="flex justify-end px-3 pt-2 pb-0 shrink-0">
        <button
          onClick={scrollToToday}
          aria-label={messages.calendar.jumpToToday}
          className={cn(
            "text-[11px] font-medium text-primary px-2 py-0.5 rounded-md",
            "hover:bg-primary/10 transition-colors duration-fast",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {messages.date.today}
        </button>
      </div>

      {/* ── Scrollable month grid (newest first) ─────────────── */}
      <ScrollAreaPrimitive.Root className="relative overflow-hidden flex-1">
        <ScrollAreaPrimitive.Viewport ref={scrollViewportRef} className="h-full w-full rounded-[inherit]">
          <div className="px-3 pt-3 pb-4 flex flex-col gap-6">
            {months.map((month) => (
              <MonthCalendar
                key={format(month, "yyyy-MM")}
                month={month}
                selected={selected && isSameMonth(month, selected) ? selected : undefined}
                onSelect={handleDaySelect}
                components={calendarComponents}
                locale={getDateFnsLocale(locale)}
                calendarData={calendarData}
              />
            ))}
            {/* intentionally minimal: Tab scrollt den Knopf ins Bild, der
                Observer lädt dann schon nach; Enter lädt einen weiteren
                Schritt — harmlos, kein Fokusverlust. Bleibt bei MAX_MONTHS
                disabled statt entfernt (Label bleibt, aria-disabled folgt
                automatisch), sonst springt der Fokus beim letzten Schritt
                auf body. */}
            <button
              ref={sentinelRef}
              type="button"
              data-testid="calendar-month-sentinel"
              disabled={monthCount >= MAX_MONTHS}
              onClick={() => setMonthCount((n) => nextMonthCount(n))}
              className={cn(
                "w-full py-2 text-center text-[11px] font-medium text-primary px-2 rounded-md",
                "hover:bg-primary/10 transition-colors duration-fast",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:pointer-events-none"
              )}
            >
              {messages.calendar.loadEarlierMonths}
            </button>
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </div>
  )
}

interface MonthCalendarProps {
  month: Date
  selected: Date | undefined
  onSelect: (date: Date | undefined, triggerDate: Date) => void
  components: ComponentProps<typeof Calendar>["components"]
  locale: ReturnType<typeof getDateFnsLocale>
  /** Nur hier, damit React.memo unten bei Datenankunft (setCalendarData)
   *  genau einmal pro Monat neu rendert — DayButtonWithData liest die Daten
   *  selbst weiter aus dem Ref, nie aus dieser Prop direkt. */
  calendarData: CalendarData
}

/** Ein Monatsraster. Memoized, weil sonst jede Elternzustand-Änderung (z.B.
 *  ein anderer selectedDate in einem fernen Monat) alle Monate re-rendert. */
const MonthCalendar = memo(function MonthCalendar({
  month,
  selected,
  onSelect,
  components,
  locale,
}: MonthCalendarProps) {
  return (
    <Calendar
      mode="single"
      selected={selected}
      onSelect={onSelect}
      month={month}
      numberOfMonths={1}
      disableNavigation
      hideNavigation
      showOutsideDays={false}
      locale={locale}
      components={components}
      className="p-0 bg-transparent [--cell-size:2.25rem]"
      classNames={CALENDAR_CLASSNAMES}
    />
  )
})
