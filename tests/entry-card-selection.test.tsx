/**
 * Selected entry card must show brand-blue selection state (Audit 01)
 *
 * Verifies that EntryCard renders:
 *   - bg-primary/10 (not the old bg-accent/50) on the root button when isSelected=true
 *   - border-l-primary (3-px left accent bar) only when isSelected=true
 *   - text-primary on the title only when isSelected=true
 *   - none of the above when isSelected=false
 *
 * Synthetic entries only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { EntryCard } from "@/components/timeline/entry-card"
import type { TimelineEntry } from "@/types/journal"

const SYNTH_ENTRY: TimelineEntry = {
  id: "synth-id-ds02",
  journalId: "synth-journal",
  journalColor: "#007AFF",
  createdAt: "2024-06-01T09:00:00.000Z",
  title: "Synthetic entry",
  previewText: "Preview for selection test",
  photoCount: 0,
  hasAudio: false,
  hasVideo: false,
  starred: false,
  tags: [],
}

describe("EntryCard — brand-blue selection state", () => {
  it("[red] selected card renders bg-primary/10 background", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: true })
    )
    expect(html).toContain("bg-primary/10")
  })

  it("[red] selected card does NOT render old bg-accent/50", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: true })
    )
    expect(html).not.toContain("bg-accent/50")
  })

  it("[red] selected card renders border-l-primary accent bar", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: true })
    )
    expect(html).toContain("border-l-primary")
  })

  it("[red] non-selected card does NOT render bg-primary/10", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: false })
    )
    expect(html).not.toContain("bg-primary/10")
  })

  it("[red] non-selected card does NOT render border-l-primary", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: false })
    )
    expect(html).not.toContain("border-l-primary")
  })

  it("[red] selected card title renders text-primary", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: true })
    )
    // The title element must carry text-primary when selected
    expect(html).toContain("text-primary")
  })

  it("[red] non-selected card title does NOT render text-primary", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY, isSelected: false })
    )
    expect(html).not.toContain("text-primary")
  })
})
