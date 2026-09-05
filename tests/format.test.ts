import { describe, it, expect, afterEach } from "vitest"
import {
  extractTitle,
  stripMarkdown,
  truncateText,
  formatDuration,
  formatEntryTime,
} from "../src/lib/format"
import { dateKey, setAppTimeZone, DEFAULT_TIME_ZONE } from "../src/lib/timezone"

describe("extractTitle", () => {
  it("returns empty title and body for empty string", () => {
    expect(extractTitle("")).toEqual({ title: "", body: "" })
  })

  it("returns empty title and body for whitespace-only string", () => {
    expect(extractTitle("   ")).toEqual({ title: "", body: "" })
  })

  it("extracts h1 heading as title, remainder as body", () => {
    expect(extractTitle("# Heading\nBody text")).toEqual({
      title: "Heading",
      body: "Body text",
    })
  })

  it("extracts h2 heading as title, remainder as body", () => {
    expect(extractTitle("## Second\nRest of entry")).toEqual({
      title: "Second",
      body: "Rest of entry",
    })
  })

  it("does not treat h3 as a heading — falls back to first-line rule", () => {
    const input = "### Not a title\nBody"
    expect(extractTitle(input)).toEqual({
      title: "### Not a title",
      body: "Body",
    })
  })

  it("falls back to first line as title when no h1/h2 heading", () => {
    expect(extractTitle("plain first line\nrest of entry")).toEqual({
      title: "plain first line",
      body: "rest of entry",
    })
  })

  it("returns full text as title when there is no newline", () => {
    expect(extractTitle("single line entry")).toEqual({
      title: "single line entry",
      body: "",
    })
  })

  it("trims surrounding whitespace from heading title", () => {
    expect(extractTitle("#  Spaced heading  \nBody")).toEqual({
      title: "Spaced heading",
      body: "Body",
    })
  })
})

describe("stripMarkdown", () => {
  it("removes bold markers", () => {
    expect(stripMarkdown("**bold**")).toBe("bold")
  })

  it("removes italic markers", () => {
    expect(stripMarkdown("*italic*")).toBe("italic")
  })

  it("removes inline links and keeps link text", () => {
    expect(stripMarkdown("[visit](https://example.com)")).toBe("visit")
  })

  it("removes inline code backticks and keeps content", () => {
    expect(stripMarkdown("`some code`")).toBe("some code")
  })

  it("removes heading hash prefix", () => {
    expect(stripMarkdown("# Title")).toBe("Title")
  })

  it("converts newlines to spaces", () => {
    expect(stripMarkdown("line one\nline two")).toBe("line one line two")
  })

  it("handles a mixed-markup string without leftover markers", () => {
    const input = "# Heading\n**bold** and *italic* with `code` and [link](https://x.com)"
    const result = stripMarkdown(input)
    expect(result).toBe("Heading bold and italic with code and link")
  })

  it("returns empty string for empty input", () => {
    expect(stripMarkdown("")).toBe("")
  })
})

describe("truncateText", () => {
  it("returns the original string when it is shorter than maxLength", () => {
    expect(truncateText("short", 10)).toBe("short")
  })

  it("returns the original string when it is exactly maxLength", () => {
    expect(truncateText("exactly10!", 10)).toBe("exactly10!")
  })

  it("truncates and appends ellipsis when text exceeds maxLength", () => {
    const result = truncateText("hello world", 5)
    expect(result).toBe("hello…")
  })

  it("does not append ellipsis when no truncation occurs", () => {
    const result = truncateText("hi", 100)
    expect(result).not.toContain("…")
  })

  it("uses default maxLength of 120", () => {
    const long = "a".repeat(121)
    const result = truncateText(long)
    expect(result.endsWith("…")).toBe(true)
    expect(result.length).toBeLessThanOrEqual(121)
  })
})

describe("dateKey (timezone.ts) — Vertrag, den format.ts vor der P2-Umstellung selbst hielt", () => {
  it("returns UTC date string (yyyy-MM-dd) for a UTC midnight Date", () => {
    const utcMidnight = new Date("2026-07-17T00:00:00Z")
    expect(dateKey(utcMidnight, "UTC")).toBe("2026-07-17")
  })

  it("returns the UTC date, not the local date, for a CET midnight Date", () => {
    // 2026-07-17T00:00:00+02:00 is 2026-07-16T22:00:00Z → UTC date is July 16
    const cetMidnight = new Date("2026-07-17T00:00:00+02:00")
    expect(dateKey(cetMidnight, "UTC")).toBe("2026-07-16")
  })

  it("returns the UTC date for a mid-day timestamp", () => {
    const ts = new Date("2026-07-17T14:30:00+02:00") // 12:30 UTC → July 17
    expect(dateKey(ts, "UTC")).toBe("2026-07-17")
  })
})

describe("formatEntryTime — Uhrzeit in der App-Zone (Zeitzone P2)", () => {
  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("Rechenbeispiel: 20:00 Ortszeit in UTC−5 (gespeichert 2026-09-05T01:00Z), 01:00 in UTC", () => {
    setAppTimeZone("Etc/GMT+5")
    expect(formatEntryTime("2026-09-05T01:00:00.000Z")).toBe("20:00")
    setAppTimeZone("UTC")
    expect(formatEntryTime("2026-09-05T01:00:00.000Z")).toBe("01:00")
  })
})

describe("formatDuration", () => {
  it("formats seconds into m:ss", () => {
    expect(formatDuration(65)).toBe("1:05")
  })

  it("pads single-digit seconds with a leading zero", () => {
    expect(formatDuration(61)).toBe("1:01")
  })

  it("formats exactly 0 seconds", () => {
    expect(formatDuration(0)).toBe("0:00")
  })

  it("formats exactly 60 seconds as 1:00", () => {
    expect(formatDuration(60)).toBe("1:00")
  })

  it("formats longer durations correctly", () => {
    expect(formatDuration(3661)).toBe("61:01")
  })
})
