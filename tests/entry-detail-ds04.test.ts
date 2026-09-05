/**
 * Title as hero, date+time as eyebrow.
 *
 * Tests pure class helpers exported from entry-detail.tsx.
 * Runs in vitest/node — no DOM renderer needed.
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import {
  entryDetailEyebrowClasses,
  entryDetailTitleClasses,
} from "@/components/detail/entry-detail"

describe("title as hero, eyebrow for date+time", () => {
  describe("eyebrow (date + time line)", () => {
    it("is uppercase", () => {
      expect(entryDetailEyebrowClasses()).toMatch(/\buppercase\b/)
    })

    it("has letter-spacing", () => {
      expect(entryDetailEyebrowClasses()).toMatch(/\btracking-/)
    })

    it("uses muted color", () => {
      expect(entryDetailEyebrowClasses()).toMatch(/\btext-muted-foreground\b/)
    })

    it("does NOT use text-3xl (dominant time abolished)", () => {
      expect(entryDetailEyebrowClasses()).not.toMatch(/\btext-3xl\b/)
    })

    it("uses small font size (text-xs or text-sm)", () => {
      expect(entryDetailEyebrowClasses()).toMatch(/\btext-xs\b|\btext-sm\b/)
    })
  })

  describe("title hero", () => {
    it("is at least 30px (text-[30px] or text-[31px] or text-[32px])", () => {
      expect(entryDetailTitleClasses()).toMatch(/text-\[3[012]px\]/)
    })

    it("uses Lora (font-reading)", () => {
      expect(entryDetailTitleClasses()).toMatch(/\bfont-reading\b/)
    })

    it("does NOT use text-[22px] or text-[26px] (old subordinate size)", () => {
      expect(entryDetailTitleClasses()).not.toMatch(/text-\[2[26]px\]/)
    })
  })
})
