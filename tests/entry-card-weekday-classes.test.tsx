/**
 * Karten-Metadaten strukturieren + Wochentagskürzel lesbar
 *
 * Weekday abbreviation must be readable (≥10px, ≥60% opacity, AA-safe).
 * Meta items (time/location/weather) in icon row; tags as pills.
 *
 * Synthetic entries only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { EntryCard, entryCardWeekdayClasses } from "@/components/timeline/entry-card"
import type { TimelineEntry } from "@/types/journal"

const SYNTH_BASE: TimelineEntry = {
  id: "synth-ds05-base",
  journalId: "synth-j",
  journalColor: "#007AFF",
  createdAt: "2024-06-01T09:30:00.000Z",
  title: "Synthetic entry",
  previewText: "",
  photoCount: 0,
  hasAudio: false,
  hasVideo: false,
  starred: false,
  tags: [],
}

// ── Audit 05: weekday abbreviation contrast ───────────────────────────────────

describe("entryCardWeekdayClasses — readability", () => {
  it("does not contain the old 8.5px size", () => {
    expect(entryCardWeekdayClasses()).not.toContain("text-[8.5px]")
  })

  it("uses a font size of at least 10px", () => {
    // Must match text-[10px], text-[11px], text-xs (12px), etc.
    const cls = entryCardWeekdayClasses()
    const hasPx = /text-\[(1[0-9]|[2-9]\d)px\]/.test(cls)
    const hasTailwind = /text-(xs|sm|base|lg|xl)/.test(cls)
    expect(hasPx || hasTailwind).toBe(true)
  })

  it("does not use the old 40% opacity", () => {
    expect(entryCardWeekdayClasses()).not.toContain("/40")
  })

  it("uses at least 60% opacity (AA improvement over old /40)", () => {
    const cls = entryCardWeekdayClasses()
    const m = cls.match(/\/(\d+)/)
    if (m) {
      expect(parseInt(m[1])).toBeGreaterThanOrEqual(60)
    }
    // No opacity modifier = full opacity → always passes
  })
})

// ── Audit 04: context meta with icon row ─────────────────────────────────────

describe("EntryCard — Audit 04 context meta row", () => {
  const entryWithMeta: TimelineEntry = {
    ...SYNTH_BASE,
    id: "synth-ds05-meta",
    location: "Zürich",
    weather: { temperatureCelsius: 18, description: "Bewölkt", icon: "" },
  }

  it("renders location text", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithMeta })
    )
    expect(html).toContain("Zürich")
  })

  it("renders weather description", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithMeta })
    )
    expect(html).toContain("Bewölkt")
  })

  it("does not render location and weather as a flat comma-joined string", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithMeta })
    )
    // Old code produced "Zürich,  18°C Bewölkt" in a single span — this must be gone
    expect(html).not.toMatch(/Zürich,\s+18/)
  })
})

// ── Audit 04: tags as pills ───────────────────────────────────────────────────

describe("EntryCard — Audit 04 tag pills", () => {
  const entryWithTags: TimelineEntry = {
    ...SYNTH_BASE,
    id: "synth-ds05-tags",
    tags: ["Reise", "Natur"],
  }

  it("renders all tag names", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithTags })
    )
    expect(html).toContain("Reise")
    expect(html).toContain("Natur")
  })

  it("renders tags inside pill-shaped elements (rounded-full)", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithTags })
    )
    expect(html).toContain("rounded-full")
  })

  it("does NOT render tags as bare comma-separated inline text", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: entryWithTags })
    )
    // Old code: "Reise, Natur" — must be absent
    expect(html).not.toMatch(/Reise,\s*[^<]*Natur/)
  })
})

// ── Regression: existing selection/favourite selectors still work ───────────────────────

describe("EntryCard — selection/favourite regression guard", () => {
  const selected: TimelineEntry = { ...SYNTH_BASE, id: "synth-ds05-sel" }

  it("selected card still renders bg-primary/10", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: selected, isSelected: true })
    )
    expect(html).toContain("bg-primary/10")
  })

  it("starred entry still renders Heart icon classes", () => {
    const starred: TimelineEntry = { ...SYNTH_BASE, id: "synth-ds05-star", starred: true }
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: starred })
    )
    expect(html).toContain("text-heart")
  })
})
