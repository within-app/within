/**
 * Sidebar Schnellzugriffe: deterministic tag color utility
 *
 * tagColor(name) maps a tag name to one of 10 palette colors consistently.
 * No real journal data — synthetic tag names only.
 */

import { describe, it, expect } from "vitest"
import { tagColor, TAG_PALETTE } from "../src/lib/tag-color"

describe("TAG_PALETTE", () => {
  it("contains at least 8 distinct hex colors", () => {
    expect(TAG_PALETTE.length).toBeGreaterThanOrEqual(8)
    const unique = new Set(TAG_PALETTE)
    expect(unique.size).toBe(TAG_PALETTE.length)
    for (const c of TAG_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})

describe("tagColor", () => {
  it("returns a string from the palette for any input", () => {
    expect(TAG_PALETTE).toContain(tagColor("Reise"))
    expect(TAG_PALETTE).toContain(tagColor("Familie"))
    expect(TAG_PALETTE).toContain(tagColor("Natur"))
  })

  it("is deterministic — same name always yields same color", () => {
    const name = "Fotografie"
    expect(tagColor(name)).toBe(tagColor(name))
    expect(tagColor(name)).toBe(tagColor(name))
  })

  it("distributes different names across the palette", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
    const colors = new Set(names.map(tagColor))
    // with 12 diverse names we should hit at least 4 distinct palette slots
    expect(colors.size).toBeGreaterThanOrEqual(4)
  })

  it("handles empty string without throwing", () => {
    expect(() => tagColor("")).not.toThrow()
    expect(TAG_PALETTE).toContain(tagColor(""))
  })

  it("handles unicode names without throwing", () => {
    expect(() => tagColor("Ñoño 🎉")).not.toThrow()
    expect(TAG_PALETTE).toContain(tagColor("Ñoño 🎉"))
  })
})
