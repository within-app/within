/**
 * Favourite must render as red heart (--heart token), not yellow star.
 *
 * Tests the pure class helpers exported from entry-card.tsx and entry-detail.tsx
 * so this runs in the existing vitest/node environment without a DOM renderer.
 *
 * Synthetic entries only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { entryCardFavouriteClasses } from "@/components/timeline/entry-card"
import { entryDetailFavouriteClasses } from "@/components/detail/entry-detail"

describe("favourite heart icon", () => {
  describe("entry-card (list view — static indicator)", () => {
    it("uses fill-heart (not fill-star)", () => {
      expect(entryCardFavouriteClasses()).toContain("fill-heart")
      expect(entryCardFavouriteClasses()).not.toContain("fill-star")
    })

    it("uses text-heart (not text-star)", () => {
      expect(entryCardFavouriteClasses()).toContain("text-heart")
      expect(entryCardFavouriteClasses()).not.toContain("text-star")
    })
  })

  describe("entry-detail (detail view — toggle button)", () => {
    it("starred=true: uses fill-heart and text-heart", () => {
      const cls = entryDetailFavouriteClasses(true)
      expect(cls).toContain("fill-heart")
      expect(cls).toContain("text-heart")
    })

    it("starred=true: does NOT use fill-star or text-star", () => {
      const cls = entryDetailFavouriteClasses(true)
      expect(cls).not.toContain("fill-star")
      expect(cls).not.toContain("text-star")
    })

    it("starred=false: uses text-muted-foreground, not fill-heart", () => {
      const cls = entryDetailFavouriteClasses(false)
      expect(cls).toContain("text-muted-foreground")
      expect(cls).not.toContain("fill-heart")
    })

    it("starred=false: does NOT use fill-star or text-star", () => {
      const cls = entryDetailFavouriteClasses(false)
      expect(cls).not.toContain("fill-star")
      expect(cls).not.toContain("text-star")
    })
  })
})
