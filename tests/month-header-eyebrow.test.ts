/**
 * Unit tests for month-header eyebrow fields.
 * Verifies that buildFlatItems emits `month`, `year`, and `entryCount`
 * on month-header items — the three-part eyebrow replacing the plain bold label.
 */

import { describe, it, expect } from "vitest"
import { buildFlatItems } from "../src/lib/timeline-virtual-items"
import type { DateGroup, TimelineEntry } from "../src/types/journal"

function makeEntry(id: string, date: string): TimelineEntry {
  return {
    id,
    journalId: "synthetic-journal",
    journalColor: "#000000",
    createdAt: `${date}T10:00:00.000Z`,
    title: "",
    previewText: `Synthetic entry ${id}`,
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
  }
}

function makeGroup(date: string, entries: TimelineEntry[]): DateGroup {
  return { date, formattedDate: date, entries }
}

describe("buildFlatItems — month-header eyebrow fields", () => {
  it("emits month as uppercase German month name", () => {
    const groups = [makeGroup("2026-07-15", [makeEntry("e1", "2026-07-15")])]
    const items = buildFlatItems(groups)
    const header = items.find((i) => i.kind === "month-header")
    expect(header).toBeDefined()
    if (header?.kind !== "month-header") throw new Error("unreachable")
    expect(header.month).toBe("JULI")
  })

  it("emits year as four-digit string", () => {
    const groups = [makeGroup("2026-07-15", [makeEntry("e1", "2026-07-15")])]
    const items = buildFlatItems(groups)
    const header = items.find((i) => i.kind === "month-header")
    if (header?.kind !== "month-header") throw new Error("unreachable")
    expect(header.year).toBe("2026")
  })

  it("emits correct entryCount for a single group", () => {
    const groups = [
      makeGroup("2026-07-15", [makeEntry("e1", "2026-07-15"), makeEntry("e2", "2026-07-15")]),
    ]
    const items = buildFlatItems(groups)
    const header = items.find((i) => i.kind === "month-header")
    if (header?.kind !== "month-header") throw new Error("unreachable")
    expect(header.entryCount).toBe(2)
  })

  it("sums entryCount across multiple date groups in the same month", () => {
    const groups = [
      makeGroup("2026-07-15", [makeEntry("e1", "2026-07-15"), makeEntry("e2", "2026-07-15")]),
      makeGroup("2026-07-10", [makeEntry("e3", "2026-07-10")]),
    ]
    const items = buildFlatItems(groups)
    const header = items.find((i) => i.kind === "month-header")
    if (header?.kind !== "month-header") throw new Error("unreachable")
    expect(header.entryCount).toBe(3)
  })

  it("emits separate headers for different months with correct counts", () => {
    const groups = [
      makeGroup("2026-07-15", [makeEntry("e1", "2026-07-15")]),
      makeGroup("2026-06-20", [makeEntry("e2", "2026-06-20"), makeEntry("e3", "2026-06-20")]),
    ]
    const items = buildFlatItems(groups)
    const headers = items.filter((i) => i.kind === "month-header")
    expect(headers).toHaveLength(2)
    if (headers[0].kind !== "month-header" || headers[1].kind !== "month-header")
      throw new Error("unreachable")
    expect(headers[0].month).toBe("JULI")
    expect(headers[0].entryCount).toBe(1)
    expect(headers[1].month).toBe("JUNI")
    expect(headers[1].entryCount).toBe(2)
  })
})
