/**
 * Kalender → Tages-Vorschau: ein
 * Kalendertag mit 2+ Einträgen öffnet rechts dieselbe Tages-Vorschau wie die
 * Tages-Karte der Timeline; genau ein Eintrag öffnet weiter direkt die
 * Einzelansicht; ein leerer Tag tut nichts. Die Tagesliste unter dem
 * Kalender (DayEntryRow-Panel) entfällt komplett.
 *
 * 1) Auswahlregel (pure). 2) Herkunft: eine Kalender-Auswahl steht nie in den
 *    Timeline-Zielen und darf sich dort nicht auflösen — nur die
 *    Timeline-Auswahl folgt den Karten; gleiche Einträge behalten beim
 *    Nachladen ihre Identität. 3) SSR-Probe: calendar-view markiert den von
 *    der Seite gehaltenen Tag; die Tagesliste (DayEntryRow) ist aus der Quelle.
 * Synthetisch — kein Netz, keine DB.
 */
import { describe, it, expect } from "vitest"
import React from "react"
import { readFileSync } from "fs"
import { join } from "path"
import { renderToStaticMarkup } from "react-dom/server"
import { format } from "date-fns"
import { LocaleProvider } from "@/components/locale-provider"
import { CalendarView } from "@/components/calendar/calendar-view"
import {
  calendarDayTarget,
  daySelectionOrphaned,
  selectedDayEntries,
  sameEntryIds,
  type DaySelection,
} from "@/lib/timeline/panel-mode"
import type { TimelineTarget } from "@/lib/timeline-virtual-items"
import type { TimelineEntry } from "@/types/journal"

const DATE = "2026-01-15"

function entry(id: string, createdAt: string): TimelineEntry {
  return {
    id, journalId: "j1", journalColor: "#007AFF", createdAt, title: id, previewText: "",
    photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [],
  }
}

const a = entry("a", `${DATE}T08:00:00.000Z`)
const b = entry("b", `${DATE}T17:30:00.000Z`)

describe("calendarDayTarget — Auswahlregel des Kalender-Tipps", () => {
  it("leerer Tag → nichts", () => {
    expect(calendarDayTarget(DATE, [])).toBeNull()
  })

  it("genau ein Eintrag → Einzelansicht dieses Eintrags", () => {
    expect(calendarDayTarget(DATE, [a])).toEqual({ kind: "entry", id: "a" })
  })

  it("2+ Einträge → Kalender-Auswahl mit genau diesen Einträgen, aufsteigend wie die Tages-Karte", () => {
    // Server und IDB liefern neueste zuerst — die Vorschau liest den Tag vorwärts.
    expect(calendarDayTarget(DATE, [b, a])).toEqual({
      kind: "day",
      selection: { source: "calendar", date: DATE, entries: [a, b] },
    })
  })
})

describe("Herkunft der Tages-Auswahl — Timeline folgt den Karten, Kalender trägt seine Einträge selbst", () => {
  const dayTarget: TimelineTarget = { kind: "day", date: DATE, entries: [a, b] }
  const soloTarget: TimelineTarget = { kind: "entry", id: "z", date: "2026-01-20" }
  const timelineSel: DaySelection = { source: "timeline", date: DATE }
  const calendarSel: DaySelection = { source: "calendar", date: DATE, entries: [a, b] }

  it("Timeline-Auswahl ist verwaist, sobald die Timeline keine Tages-Karte für das Datum mehr hat", () => {
    expect(daySelectionOrphaned(timelineSel, [dayTarget, soloTarget])).toBe(false)
    expect(daySelectionOrphaned(timelineSel, [soloTarget])).toBe(true)
    expect(daySelectionOrphaned(timelineSel, [])).toBe(true)
  })

  it("Kalender-Auswahl steht nie in den Timeline-Zielen und ist trotzdem nie verwaist", () => {
    expect(daySelectionOrphaned(calendarSel, [])).toBe(false)
    expect(daySelectionOrphaned(calendarSel, [soloTarget])).toBe(false)
    expect(daySelectionOrphaned(null, [])).toBe(false)
  })

  it("Einträge der Vorschau: Timeline aus der Tages-Karte, Kalender aus der Auswahl selbst", () => {
    expect(selectedDayEntries(timelineSel, [dayTarget]).map((e) => e.id)).toEqual(["a", "b"])
    expect(selectedDayEntries(timelineSel, [])).toEqual([])
    expect(selectedDayEntries(calendarSel, []).map((e) => e.id)).toEqual(["a", "b"])
    expect(selectedDayEntries(null, [dayTarget])).toEqual([])
  })

  it("sameEntryIds: gleiche Ids in gleicher Reihenfolge — sonst neue Auswahl (Löschen, Verschieben)", () => {
    expect(sameEntryIds([a, b], [{ ...a, title: "geändert" }, b])).toBe(true)
    expect(sameEntryIds([a, b], [b])).toBe(false)
    expect(sameEntryIds([a, b], [b, a])).toBe(false)
    expect(sameEntryIds([], [])).toBe(true)
  })
})

describe("CalendarView — Tag markiert, keine Tagesliste mehr", () => {
  // Der 15. des laufenden Monats liegt immer im Startfenster (3 Monate).
  const selectedDate = `${format(new Date(), "yyyy-MM")}-15`

  function render(selected: string | null): string {
    return renderToStaticMarkup(
      <LocaleProvider initialLocale="de">
        <CalendarView journalId={null} selectedDate={selected} onDaySelect={() => {}} />
      </LocaleProvider>
    )
  }

  it("markiert den von der Seite gehaltenen Tag im Raster (kontrollierte Auswahl)", () => {
    expect((render(null).match(/aria-selected="true"/g) ?? []).length).toBe(0)
    expect((render(selectedDate).match(/aria-selected="true"/g) ?? []).length).toBe(1)
  })

  it("Quelltext-Probe: die Tagesliste unter dem Raster (DayEntryRow) ist entfernt", () => {
    // Das alte Panel hing an internem State und war in SSR nie sichtbar — der
    // einzige belastbare Nachweis ist die Quelle: die Zeilen-Komponente ist weg.
    const src = readFileSync(join(__dirname, "../src/components/calendar/calendar-view.tsx"), "utf8")
    expect(src).not.toContain("DayEntryRow")
  })
})
