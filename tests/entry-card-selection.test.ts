/**
 * Selection state must use brand-blue tokens, not gray.
 *
 * Tests the pure class-building helpers exported from entry-card.tsx so this
 * runs in the existing vitest/node environment without a DOM renderer.
 */

import { describe, it, expect } from "vitest"
import { entryCardButtonClasses, entryCardTitleClasses } from "@/components/timeline/entry-card"

describe("entryCardButtonClasses — selected state", () => {
  it("selected: bg-primary/10 (not bg-accent)", () => {
    const cls = entryCardButtonClasses(true, true)
    expect(cls).toContain("bg-primary/10")
    expect(cls).not.toContain("bg-accent")
  })

  it("selected: border-l-primary for 3-px accent bar", () => {
    expect(entryCardButtonClasses(true, true)).toContain("border-l-primary")
  })

  it("unselected: no primary background", () => {
    expect(entryCardButtonClasses(false, true)).not.toContain("bg-primary")
  })

  it("unselected: border-l-transparent (no accent bar)", () => {
    expect(entryCardButtonClasses(false, true)).toContain("border-l-transparent")
  })

  it("hover:bg-accent/30 present on unselected, absent on selected", () => {
    expect(entryCardButtonClasses(false, true)).toContain("hover:bg-accent/30")
    expect(entryCardButtonClasses(true, true)).not.toContain("hover:bg-accent/30")
  })
})

describe("entryCardTitleClasses — selected state", () => {
  it("selected + has title: text-primary", () => {
    expect(entryCardTitleClasses(true, true)).toContain("text-primary")
  })

  it("unselected + has title: text-foreground, not text-primary", () => {
    const cls = entryCardTitleClasses(false, true)
    expect(cls).toContain("text-foreground")
    expect(cls).not.toContain("text-primary")
  })

  it("selected + no title (placeholder): italic preserved, not text-primary", () => {
    // Untitled placeholder keeps its muted italic style even when selected
    const cls = entryCardTitleClasses(true, false)
    expect(cls).toContain("italic")
    expect(cls).not.toContain("text-primary")
  })
})
