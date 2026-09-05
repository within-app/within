/**
 * Unit tests for cleanText()
 *
 * Verifies the full DayOne backslash-escape set and case-insensitive
 * dayone-moment strip. Synthetic strings only (Constraint D).
 */

import { describe, it, expect } from "vitest"
import { cleanText } from "../src/lib/clean-text"

describe("cleanText", () => {
  // ── dayone-moment strip ──────────────────────────────────────────────────

  it("strips an uppercase dayone-moment image ref", () => {
    expect(cleanText("before ![](dayone-moment://AABBCC001122334455) after")).toBe("before  after")
  })

  it("strips a lowercase dayone-moment image ref (case-insensitive)", () => {
    expect(cleanText("photo: ![](dayone-moment://aabbcc001122334455)")).toBe("photo:")
  })

  it("strips multiple dayone-moment refs", () => {
    expect(
      cleanText("A ![](dayone-moment://AAA111) B ![](dayone-moment://BBB222) C")
    ).toBe("A  B  C")
  })

  // ── backslash-escape unescaping ──────────────────────────────────────────

  it("unescapes \\. to .", () => {
    expect(cleanText("Hello\\. World\\.")).toBe("Hello. World.")
  })

  it("unescapes \\( to (", () => {
    expect(cleanText("func\\(arg\\)")).toBe("func(arg)")
  })

  it("unescapes \\) to )", () => {
    expect(cleanText("close \\)")).toBe("close )")
  })

  it("unescapes \\[ and \\]", () => {
    expect(cleanText("array\\[0\\]")).toBe("array[0]")
  })

  it("unescapes \\* (bold marker)", () => {
    expect(cleanText("\\*not bold\\*")).toBe("*not bold*")
  })

  it("unescapes \\\\ (literal backslash)", () => {
    expect(cleanText("path\\\\file")).toBe("path\\file")
  })

  it("unescapes \\_ (emphasis marker)", () => {
    expect(cleanText("\\_italic\\_")).toBe("_italic_")
  })

  it("unescapes \\# (heading marker)", () => {
    expect(cleanText("\\# Not a heading")).toBe("# Not a heading")
  })

  it("unescapes \\- (list marker)", () => {
    expect(cleanText("\\- item")).toBe("- item")
  })

  it("unescapes \\! (image marker prefix)", () => {
    expect(cleanText("\\!")).toBe("!")
  })

  // ── mixed content ────────────────────────────────────────────────────────

  it("strips dayone-moment refs and unescapes backslashes in the same string", () => {
    const raw =
      "Went hiking\\. ![](dayone-moment://CAFEBABE12345678) Great view\\!"
    expect(cleanText(raw)).toBe("Went hiking.  Great view!")
  })

  it("trims leading and trailing whitespace after cleaning", () => {
    expect(cleanText("  Hello\\. World\\.  ")).toBe("Hello. World.")
  })

  it("returns empty string for an empty input", () => {
    expect(cleanText("")).toBe("")
  })

  it("leaves ordinary text unchanged", () => {
    expect(cleanText("Just plain text.")).toBe("Just plain text.")
  })
})
