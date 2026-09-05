/**
 * EmptyState CTA variants
 *
 * Verifies that EmptyState renders the correct call-to-action depending on
 * whether a search/filter is active (isFiltered prop).
 *
 * - isFiltered=false + onNewEntry → "Ersten Eintrag schreiben" button
 * - isFiltered=true + onClearFilters → "Keine Treffer" + "Filter zurücksetzen"
 * - isFiltered=true must NOT show the first-entry CTA
 * - isFiltered=false must NOT show the filter-reset text
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { EmptyState } from "@/components/timeline/empty-state"

describe("EmptyState — CTA variants", () => {
  it("renders first-entry CTA when not filtered", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { isFiltered: false, onNewEntry: () => {} })
    )
    expect(html).toContain("Ersten Eintrag schreiben")
  })

  it("renders Keine Treffer heading when filtered", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { isFiltered: true, onClearFilters: () => {} })
    )
    expect(html).toContain("Keine Treffer")
  })

  it("renders filter-reset action when filtered", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { isFiltered: true, onClearFilters: () => {} })
    )
    expect(html).toContain("Filter zur\u00fccksetzen")
  })

  it("does NOT show first-entry CTA when filtered", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { isFiltered: true, onClearFilters: () => {} })
    )
    expect(html).not.toContain("Ersten Eintrag schreiben")
  })

  it("does NOT show filter-reset text when not filtered", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { isFiltered: false, onNewEntry: () => {} })
    )
    expect(html).not.toContain("Keine Treffer")
  })
})
