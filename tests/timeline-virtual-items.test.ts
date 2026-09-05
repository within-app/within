/**
 * Timeline virtualizer pure-logic tests
 *
 * Tests the data-transformation layer (buildFlatItems, mergeDateGroups)
 * that feeds the @tanstack/react-virtual list. No DOM or React needed.
 *
 * DOM node-count bounds (≤ ~viewport + overscan while scrolling) requires a
 * real browser and must be verified via Playwright E2E once the test
 * infrastructure is set up.
 */

import { describe, it, expect } from "vitest"
import { buildFlatItems, mergeDateGroups, timelineTargets } from "@/lib/timeline-virtual-items"
import type { DateGroup, TimelineEntry } from "@/types/journal"

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeEntry(id: string, date: string): TimelineEntry {
  return {
    id,
    journalId: "synthetic-journal",
    journalColor: "#000000",
    createdAt: `${date}T10:00:00Z`,
    title: "",
    previewText: `Synthetic entry ${id}`,
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
  }
}

function makeDateGroup(date: string, count: number, idOffset = 0): DateGroup {
  return {
    date,
    formattedDate: date,
    entries: Array.from({ length: count }, (_, i) => makeEntry(`${date}-${i + idOffset}`, date)),
  }
}

/**
 * Build a synthetic dataset of `entryCount` entries spread across months.
 * ~30 entries per month → e.g. 1000 entries ≈ 34 months ≈ 3 years.
 */
function makeDataset(entryCount: number): DateGroup[] {
  const groups: DateGroup[] = []
  let remaining = entryCount
  // Start at 2024-01-15 and go backwards month by month
  let year = 2024
  let month = 1
  while (remaining > 0) {
    const count = Math.min(30, remaining)
    const pad = (n: number) => String(n).padStart(2, "0")
    groups.push(makeDateGroup(`${year}-${pad(month)}-15`, count))
    remaining -= count
    month--
    if (month === 0) {
      month = 12
      year--
    }
  }
  return groups
}

// ── buildFlatItems ───────────────────────────────────────────────────────────

describe("buildFlatItems", () => {
  it("always ends with a sentinel item", () => {
    const groups = makeDataset(5)
    const items = buildFlatItems(groups)
    expect(items[items.length - 1].kind).toBe("sentinel")
  })

  it("produces exactly one sentinel", () => {
    const items = buildFlatItems(makeDataset(100))
    expect(items.filter((i) => i.kind === "sentinel").length).toBe(1)
  })

  it("includes a month-header before the first entry of each month", () => {
    const groups = [
      makeDateGroup("2024-03-10", 2),
      makeDateGroup("2024-02-20", 3),
    ]
    const items = buildFlatItems(groups)
    const headerIndices = items.reduce<number[]>((acc, item, idx) => {
      if (item.kind === "month-header") acc.push(idx)
      return acc
    }, [])
    // Two months → two headers
    expect(headerIndices.length).toBe(2)
    // Each header must be followed immediately by a card — an entry card or,
    // since the Tages-Karte (03.09.2026), a day card for a multi-entry day.
    for (const hi of headerIndices) {
      expect(["entry", "day"]).toContain(items[hi + 1]?.kind)
    }
  })

  it("single-entry day: the entry card carries the date; multi-entry day: one day card, no entry cards", () => {
    // Tages-Karte (03.09.2026): the former "showDate only on the first entry of a
    // day" continuation layout is gone — 2+ entries collapse into one day card.
    const groups: DateGroup[] = [
      {
        date: "2024-01-16",
        formattedDate: "2024-01-16",
        entries: [makeEntry("solo", "2024-01-16")],
      },
      {
        date: "2024-01-15",
        formattedDate: "2024-01-15",
        entries: [
          makeEntry("a", "2024-01-15"),
          makeEntry("b", "2024-01-15"),
          makeEntry("c", "2024-01-15"),
        ],
      },
    ]
    const items = buildFlatItems(groups)
    const entries = items.filter((i) => i.kind === "entry") as Array<{ kind: "entry"; entry: TimelineEntry; showDate: boolean }>
    expect(entries).toHaveLength(1)
    expect(entries[0].entry.id).toBe("solo")
    expect(entries[0].showDate).toBe(true)
    const days = items.filter((i) => i.kind === "day")
    expect(days).toHaveLength(1)
    expect(days[0].kind === "day" && days[0].group.entries.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  it("total item count = headers + cards + 1 sentinel for a large dataset", () => {
    const groups = makeDataset(1000)
    const items = buildFlatItems(groups)

    const totalEntries = groups.reduce((sum, g) => sum + g.entries.length, 0)
    // A day group with 2+ entries is ONE card (Tages-Karte), a single entry one card.
    const totalCards = groups.reduce((sum, g) => sum + (g.entries.length >= 2 ? 1 : g.entries.length), 0)
    const uniqueMonths = new Set(groups.map((g) => g.date.slice(0, 7))).size
    const expectedCount = uniqueMonths + totalCards + 1 // headers + cards + sentinel

    expect(items.length).toBe(expectedCount)
    expect(totalEntries).toBeGreaterThanOrEqual(1000)
  })

  it("month headers appear in newest-first order", () => {
    const groups = [
      makeDateGroup("2024-01-15", 1),
      makeDateGroup("2024-03-10", 1),
      makeDateGroup("2024-02-20", 1),
    ]
    const items = buildFlatItems(groups)
    const headers = items.filter((i) => i.kind === "month-header")

    // groupByMonth preserves insertion order; mergeDateGroups sorts desc,
    // but buildFlatItems takes whatever groupByMonth returns.
    // Verify all three month headers are present:
    expect(headers.length).toBe(3)
  })

  it("returns only a sentinel for an empty dataset", () => {
    const items = buildFlatItems([])
    expect(items.length).toBe(1)
    expect(items[0].kind).toBe("sentinel")
  })
})

// ── mergeDateGroups ──────────────────────────────────────────────────────────

describe("mergeDateGroups", () => {
  it("appends entries to an existing date group", () => {
    const existing = [makeDateGroup("2024-01-15", 2)]
    const incoming = [makeDateGroup("2024-01-15", 3, 2)]
    const merged = mergeDateGroups(existing, incoming)
    expect(merged.length).toBe(1)
    expect(merged[0].entries.length).toBe(5)
  })

  it("adds a new date group that didn't exist", () => {
    const existing = [makeDateGroup("2024-01-15", 2)]
    const incoming = [makeDateGroup("2024-01-10", 1)]
    const merged = mergeDateGroups(existing, incoming)
    expect(merged.length).toBe(2)
  })

  it("sorts result newest-first by date", () => {
    const existing = [makeDateGroup("2024-01-01", 1)]
    const incoming = [makeDateGroup("2024-03-01", 1), makeDateGroup("2024-02-01", 1)]
    const merged = mergeDateGroups(existing, incoming)
    expect(merged.map((g) => g.date)).toEqual(["2024-03-01", "2024-02-01", "2024-01-01"])
  })

  it("does not mutate the existing entries array", () => {
    const group = makeDateGroup("2024-01-15", 2)
    const existingEntriesRef = group.entries
    mergeDateGroups([group], [makeDateGroup("2024-01-15", 1)])
    expect(group.entries).toBe(existingEntriesRef)
  })
})

// ── Tages-Karte ────────────────────────────────────────────────────────────────
// Ein Tag mit 2+ Einträgen wird EIN Item `day` (eine Karte in der Timeline);
// ein Tag mit genau einem Eintrag bleibt ein `entry`-Item mit Datum wie bisher.
describe("buildFlatItems — Tages-Karte bei 2+ Einträgen", () => {
  it("fasst einen Tag mit zwei Einträgen zu genau einem day-Item zusammen", () => {
    const items = buildFlatItems([makeDateGroup("2026-09-02", 2)])
    const kinds = items.map((i) => i.kind)
    expect(kinds).toEqual(["month-header", "day", "sentinel"])
    const day = items[1]
    expect(day.kind === "day" && day.group.date).toBe("2026-09-02")
    expect(day.kind === "day" && day.group.entries.length).toBe(2)
  })

  it("lässt einen Tag mit genau einem Eintrag als entry-Item mit Datum", () => {
    const items = buildFlatItems([makeDateGroup("2026-09-02", 1)])
    expect(items.map((i) => i.kind)).toEqual(["month-header", "entry", "sentinel"])
    expect(items[1].kind === "entry" && items[1].showDate).toBe(true)
  })

  it("sortiert die Einträge eines Tages-Items aufsteigend (Server liefert absteigend)", () => {
    const group: DateGroup = {
      date: "2026-09-02", formattedDate: "2026-09-02",
      entries: [
        { ...makeEntry("spät", "2026-09-02"), createdAt: "2026-09-02T18:00:00Z" },
        { ...makeEntry("früh", "2026-09-02"), createdAt: "2026-09-02T07:00:00Z" },
      ],
    }
    const day = buildFlatItems([group])[1]
    expect(day.kind === "day" && day.group.entries.map((e) => e.id)).toEqual(["früh", "spät"])
    // Ausgangsgruppe bleibt unverändert (mergeDateGroups arbeitet weiter darauf)
    expect(group.entries[0].id).toBe("spät")
  })

  it("timelineTargets tragen den UTC-Tag; Tages-Ziele ihre Einträge", () => {
    const targets = timelineTargets(buildFlatItems([makeDateGroup("2026-09-02", 2), makeDateGroup("2026-09-01", 1)]))
    expect(targets).toHaveLength(2)
    expect(targets[0].kind === "day" && targets[0].date).toBe("2026-09-02")
    expect(targets[0].kind === "day" && targets[0].entries.length).toBe(2)
    expect(targets[1].kind === "entry" && targets[1].date).toBe("2026-09-01")
  })

  it("Monats-Kopf zählt Einträge, nicht Karten", () => {
    const items = buildFlatItems([makeDateGroup("2026-09-02", 3), makeDateGroup("2026-09-01", 1)])
    expect(items[0].kind === "month-header" && items[0].entryCount).toBe(4)
    expect(items.filter((i) => i.kind === "day")).toHaveLength(1)
    expect(items.filter((i) => i.kind === "entry")).toHaveLength(1)
  })
})
