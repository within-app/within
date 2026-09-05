/**
 * Pending-Merge auf Timeline-Seiten > 1.
 *
 * Die Verdrahtung in timeline-view.tsx wendet applyPendingMediaToGroups auf die
 * NEUE Seite an, BEVOR mergeDateGroups läuft. Dieser Test dokumentiert, warum
 * die Reihenfolge tragend ist: mergeDateGroups behält bei einem
 * Paginierungs-Shift den vorhandenen (bereits gepatchten) Eintrag — das
 * Patchen des Merge-Ergebnisses würde Seite-1-Einträge doppelt zählen.
 *
 * Synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { mergeDateGroups } from "../src/lib/timeline-virtual-items"
import { applyPendingMediaToGroups } from "../src/lib/sync/pending-media"
import type { DateGroup, TimelineEntry } from "../src/types/journal"

function makeEntry(id: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id,
    journalId: "journal-1",
    journalColor: "",
    createdAt: "2026-07-27T10:00:00.000Z",
    title: "Titel",
    previewText: "",
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
    ...over,
  }
}

function makeGroups(...entries: TimelineEntry[]): DateGroup[] {
  return [{ date: "2026-07-27", formattedDate: "2026-07-27", entries }]
}

const PENDING = new Map([
  ["entry-old", { photoCount: 1, hasAudio: false, hasVideo: false, thumbnail: "blob:p" }],
])

describe("Seiten-Append mit Pending-Medien", () => {
  it("eine nachgeladene Seite bekommt die wartenden Medien eingemischt", () => {
    const page1 = applyPendingMediaToGroups(makeGroups(makeEntry("entry-new")), PENDING)
    const page2 = applyPendingMediaToGroups(makeGroups(makeEntry("entry-old")), PENDING)

    const merged = mergeDateGroups(page1, page2)
    const old = merged[0].entries.find((e) => e.id === "entry-old")!
    expect(old.photoCount).toBe(1)
    expect(old.thumbnail).toBe("blob:p")
  })

  it("Paginierungs-Shift: ein bereits gepatchter Seite-1-Eintrag wird nicht doppelt gezählt", () => {
    // entry-old wurde auf Seite 1 schon gepatcht (photoCount 1) und taucht durch
    // einen Shift erneut auf Seite 2 auf. Patch-vor-Merge hält die Zählung bei 1 …
    const page1 = applyPendingMediaToGroups(makeGroups(makeEntry("entry-old")), PENDING)
    const page2 = applyPendingMediaToGroups(makeGroups(makeEntry("entry-old")), PENDING)
    const merged = mergeDateGroups(page1, page2)
    expect(merged[0].entries).toHaveLength(1)
    expect(merged[0].entries[0].photoCount).toBe(1)

    // … während Patch-NACH-Merge doppelt zählen würde (das dokumentierte Gegenteil).
    const wrongOrder = applyPendingMediaToGroups(
      applyPendingMediaToGroups(mergeDateGroups(makeGroups(makeEntry("entry-old")), makeGroups()), PENDING),
      PENDING
    )
    expect(wrongOrder[0].entries[0].photoCount).toBe(2)
  })
})
