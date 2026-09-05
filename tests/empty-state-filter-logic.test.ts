/**
 * Empty-state filter-active detection
 *
 * Tests the pure helper that determines whether any search/filter is active,
 * which controls whether the timeline empty state shows a "no results + reset"
 * state or a "first entry" CTA state.
 */

import { describe, it, expect } from "vitest"
import { isFilterActive } from "@/lib/timeline/filter-utils"
import { DEFAULT_FILTERS } from "@/types/journal"
import type { ActiveFilters } from "@/types/journal"

const blank: ActiveFilters = { ...DEFAULT_FILTERS }

describe("isFilterActive", () => {
  it("returns false for default filters and empty search", () => {
    expect(isFilterActive(blank, "")).toBe(false)
  })

  it("returns true when searchQuery is non-empty", () => {
    expect(isFilterActive(blank, "urlaub")).toBe(true)
  })

  it("returns true when starred filter is set", () => {
    expect(isFilterActive({ ...blank, starred: true }, "")).toBe(true)
  })

  it("returns true when tags filter is non-empty", () => {
    expect(isFilterActive({ ...blank, tags: ["work"] }, "")).toBe(true)
  })

  it("returns true when mediaType filter is set", () => {
    expect(isFilterActive({ ...blank, mediaType: "photo" }, "")).toBe(true)
  })

  it("returns true when before filter is set", () => {
    expect(isFilterActive({ ...blank, before: "2025-06" }, "")).toBe(true)
  })

  it("returns false when search is whitespace-only", () => {
    expect(isFilterActive(blank, "   ")).toBe(false)
  })
})
