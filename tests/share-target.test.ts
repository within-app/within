/**
 * Android share-to-within — share text builder tests.
 * Tests the pure function that combines Web Share Target params
 * (title, text, url) into a pre-filled journal entry draft.
 * Synthetic data only (Constraint D).
 */
import { describe, it, expect } from "vitest"
import { buildShareDraft } from "../src/lib/share/build-share-draft"

describe("buildShareDraft", () => {
  it("returns text only when just text is provided", () => {
    const result = buildShareDraft({ text: "A note from the web" })
    expect(result).toBe("A note from the web")
  })

  it("returns title + text separated by newline when both are present", () => {
    const result = buildShareDraft({ title: "Interesting article", text: "Check this out" })
    expect(result).toBe("Interesting article\n\nCheck this out")
  })

  it("appends url on its own line when url is provided with text", () => {
    const result = buildShareDraft({ text: "Great page", url: "https://example.com" })
    expect(result).toBe("Great page\n\nhttps://example.com")
  })

  it("combines title, text, and url together", () => {
    const result = buildShareDraft({
      title: "Cool thing",
      text: "Look at this",
      url: "https://example.com/cool",
    })
    expect(result).toBe("Cool thing\n\nLook at this\n\nhttps://example.com/cool")
  })

  it("returns empty string when all params are absent", () => {
    const result = buildShareDraft({})
    expect(result).toBe("")
  })

  it("uses only title when only title is provided", () => {
    const result = buildShareDraft({ title: "Just a title" })
    expect(result).toBe("Just a title")
  })

  it("uses only url when only url is provided", () => {
    const result = buildShareDraft({ url: "https://example.com" })
    expect(result).toBe("https://example.com")
  })

  it("trims whitespace from each part", () => {
    const result = buildShareDraft({ title: "  Title  ", text: "  Body  " })
    expect(result).toBe("Title\n\nBody")
  })

  it("omits empty parts (does not produce double blank lines)", () => {
    const result = buildShareDraft({ title: "Title", text: "", url: "https://example.com" })
    expect(result).toBe("Title\n\nhttps://example.com")
  })
})
