/**
 * formatBytes — Dateigröße für die PDF-Kachel (2026-10-30).
 *
 * Binäre Einheiten wie die Upload-Limits (MAX_*_SIZE_MB rechnet mit 1024²),
 * damit „50 MB" im Hinweis und „49,9 MB" auf der Kachel zusammenpassen.
 * Synthetic data only.
 */
import { describe, it, expect } from "vitest"
import { formatBytes } from "@/lib/format"

describe("formatBytes", () => {
  it("bytes below 1 KB stay bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1)).toBe("1 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("kilobytes are rounded to whole numbers", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(4096)).toBe("4 KB")
    expect(formatBytes(819175)).toBe("800 KB")
  })

  it("megabytes keep one decimal and drop a trailing .0", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB")
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB")
    expect(formatBytes(52_428_800)).toBe("50 MB")
    expect(formatBytes(52_323_942)).toBe("49.9 MB")
  })

  it("uses the locale's decimal separator when given one", () => {
    expect(formatBytes(1.5 * 1024 * 1024, "de")).toBe("1,5 MB")
    expect(formatBytes(1.5 * 1024 * 1024, "fr")).toBe("1,5 MB")
    expect(formatBytes(1.5 * 1024 * 1024, "en")).toBe("1.5 MB")
  })

  it("tolerates null/undefined/negative input with an empty string", () => {
    expect(formatBytes(null)).toBe("")
    expect(formatBytes(undefined)).toBe("")
    expect(formatBytes(-5)).toBe("")
  })
})
