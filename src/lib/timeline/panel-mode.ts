/**
 * Which panel the root page renders next to the timeline.
 *
 * Kept pure and separate so the offline-edit contract is testable: editing an
 * entry must NOT be a route navigation. `/entry/<id>/edit` is a dynamic route
 * and therefore never precached (public/sw.js `NAV_PRECACHE = ['/', '/login']`).
 * Offline the service worker answers that URL with the cached '/' shell, Next.js
 * hydrates the timeline instead of the editor, and the user is bounced back to
 * the overview. Rendering the editor inline — the same way `showNewEntry` already
 * works — keeps online and offline on one code path.
 */

import type { TimelineEntry } from "@/types/journal"
import type { TimelineTarget } from "@/lib/timeline-virtual-items"

export type PanelMode = "edit" | "detail" | "day" | "new" | "empty"

export interface PanelState {
  selectedEntryId: string | null
  /** Set while an existing entry is being edited inline. */
  editingEntryId: string | null
  showNewEntry: boolean
  /** Tages-Vorschau: UTC-Tagesschlüssel der gewählten Tages-Karte. */
  selectedDate: string | null
}

/**
 * Editing wins over the detail view: the entry stays selected while its editor
 * is open so closing the editor returns to the entry instead of the empty state.
 * The detail view wins over the day preview for the same reason: „Öffnen" from
 * the preview keeps the day selected, so going back lands in the preview again.
 */
export function resolvePanelMode(state: PanelState): PanelMode {
  if (state.editingEntryId) return "edit"
  if (state.selectedEntryId) return "detail"
  if (state.selectedDate) return "day"
  if (state.showNewEntry) return "new"
  return "empty"
}

/** True while the right-hand panel occupies the screen on narrow viewports. */
export function panelTakesOverMobile(state: PanelState): boolean {
  return resolvePanelMode(state) !== "empty"
}

/**
 * Gewählter Tag der Tages-Vorschau mit Herkunft. Aus
 * der Timeline gehören die Einträge der Tages-Karte (navTargets) — sie folgen
 * Bearbeiten, Löschen, Filtern. Aus dem Kalender gibt es keine Karte: die
 * Auswahl trägt die vom Kalender geladenen Einträge selbst und steht nie in
 * den Timeline-Zielen.
 */
export type DaySelection =
  | { source: "timeline"; date: string }
  | { source: "calendar"; date: string; entries: TimelineEntry[] }
export type CalendarDaySelection = Extract<DaySelection, { source: "calendar" }>

/**
 * Kalender-Tipp: genau ein Eintrag → Einzelansicht (Auto-Öffnen bleibt), 2+ →
 * Tages-Vorschau mit genau diesen Einträgen (aufsteigend wie die Tages-Karte,
 * buildFlatItems), keiner → nichts.
 */
export function calendarDayTarget(
  date: string,
  entries: TimelineEntry[]
): { kind: "entry"; id: string } | { kind: "day"; selection: CalendarDaySelection } | null {
  if (entries.length === 0) return null
  if (entries.length === 1) return { kind: "entry", id: entries[0].id }
  const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { kind: "day", selection: { source: "calendar", date, entries: sorted } }
}

/** Gleiche Einträge in gleicher Reihenfolge — hält die Identität der Auswahl beim Nachladen. */
export function sameEntryIds(a: TimelineEntry[], b: TimelineEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i].id)
}

/** Nur eine Timeline-Auswahl ist verwaist, wenn ihre Tages-Karte fehlt (gelöscht, verschoben, gefiltert). */
export function daySelectionOrphaned(selection: DaySelection | null, targets: TimelineTarget[]): boolean {
  return selection?.source === "timeline" && !targets.some((t) => t.kind === "day" && t.date === selection.date)
}

/** Die Einträge der Tages-Vorschau: aus der Tages-Karte oder aus der Kalender-Auswahl selbst. */
export function selectedDayEntries(selection: DaySelection | null, targets: TimelineTarget[]): TimelineEntry[] {
  if (!selection) return []
  if (selection.source === "calendar") return selection.entries
  const day = targets.find((t) => t.kind === "day" && t.date === selection.date)
  return day?.kind === "day" ? day.entries : []
}
