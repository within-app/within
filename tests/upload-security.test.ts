/**
 * upload-security.ts: MIME allowlists, per-type size limits, extension mapping.
 * Extends existing safeExtFromFormat tests with the P1 additions:
 *   safeExtFromMime, detectMediaTypeFromMime, getMaxBytesForType, getMaxMBForType
 * Synthetic data only (Constraint D).
 */
import { describe, it, expect } from "vitest"
import {
  safeExtFromFormat,
  safeExtFromMime,
  detectMediaTypeFromMime,
  getMaxBytesForType,
  getMaxMBForType,
  isPdfHeader,
  safeOriginalName,
} from "../src/lib/upload-security"

describe("safeExtFromFormat", () => {
  it("returns the correct extension for allowed formats", () => {
    expect(safeExtFromFormat("jpeg")).toBe("jpg")
    expect(safeExtFromFormat("png")).toBe("png")
    expect(safeExtFromFormat("webp")).toBe("webp")
    expect(safeExtFromFormat("gif")).toBe("gif")
  })

  it("returns null for disallowed formats", () => {
    expect(safeExtFromFormat("svg")).toBeNull()
    expect(safeExtFromFormat("bmp")).toBeNull()
    expect(safeExtFromFormat("tiff")).toBeNull()
    expect(safeExtFromFormat("exe")).toBeNull()
  })

  it("returns null for undefined", () => {
    expect(safeExtFromFormat(undefined)).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(safeExtFromFormat("")).toBeNull()
  })
})

// ── safeExtFromMime (P1 addition) ──────────────────────────────────────────────

describe("safeExtFromMime", () => {
  it("maps each allowed video MIME to its extension", () => {
    expect(safeExtFromMime("video/mp4")).toBe("mp4")
    expect(safeExtFromMime("video/quicktime")).toBe("mov")
  })

  it("maps each allowed audio MIME to its extension", () => {
    expect(safeExtFromMime("audio/mpeg")).toBe("mp3")
    expect(safeExtFromMime("audio/mp4")).toBe("m4a")
    expect(safeExtFromMime("audio/aac")).toBe("aac")
  })

  it("returns null for non-allowlisted video types", () => {
    expect(safeExtFromMime("video/webm")).toBeNull()
    expect(safeExtFromMime("video/ogg")).toBeNull()
    expect(safeExtFromMime("video/avi")).toBeNull()
  })

  it("returns null for non-allowlisted audio types", () => {
    expect(safeExtFromMime("audio/ogg")).toBeNull()
    expect(safeExtFromMime("audio/wav")).toBeNull()
    expect(safeExtFromMime("audio/flac")).toBeNull()
  })

  it("returns null for image MIME types (those go through safeExtFromFormat)", () => {
    expect(safeExtFromMime("image/jpeg")).toBeNull()
    expect(safeExtFromMime("image/png")).toBeNull()
  })

  it("maps application/pdf to pdf", () => {
    expect(safeExtFromMime("application/pdf")).toBe("pdf")
  })

  it("returns null for unrelated MIME types", () => {
    expect(safeExtFromMime("application/zip")).toBeNull()
    expect(safeExtFromMime("text/html")).toBeNull()
    expect(safeExtFromMime("")).toBeNull()
  })
})

// ── detectMediaTypeFromMime (P1 addition) ─────────────────────────────────────

describe("detectMediaTypeFromMime", () => {
  it("classifies allowed video MIMEs as 'video'", () => {
    expect(detectMediaTypeFromMime("video/mp4")).toBe("video")
    expect(detectMediaTypeFromMime("video/quicktime")).toBe("video")
  })

  it("classifies allowed audio MIMEs as 'audio'", () => {
    expect(detectMediaTypeFromMime("audio/mpeg")).toBe("audio")
    expect(detectMediaTypeFromMime("audio/mp4")).toBe("audio")
    expect(detectMediaTypeFromMime("audio/aac")).toBe("audio")
  })

  it("classifies image/* MIMEs as 'photo' (passes through to sharp)", () => {
    expect(detectMediaTypeFromMime("image/jpeg")).toBe("photo")
    expect(detectMediaTypeFromMime("image/png")).toBe("photo")
    expect(detectMediaTypeFromMime("image/webp")).toBe("photo")
    expect(detectMediaTypeFromMime("image/gif")).toBe("photo")
  })

  it("returns null for non-allowlisted video types (no broad video/* wildcard)", () => {
    expect(detectMediaTypeFromMime("video/webm")).toBeNull()
    expect(detectMediaTypeFromMime("video/ogg")).toBeNull()
  })

  it("returns null for non-allowlisted audio types (no broad audio/* wildcard)", () => {
    expect(detectMediaTypeFromMime("audio/ogg")).toBeNull()
    expect(detectMediaTypeFromMime("audio/wav")).toBeNull()
    expect(detectMediaTypeFromMime("audio/flac")).toBeNull()
  })

  it("classifies application/pdf as 'pdf' (explicit allowlist, no application/* wildcard)", () => {
    expect(detectMediaTypeFromMime("application/pdf")).toBe("pdf")
    expect(detectMediaTypeFromMime("application/zip")).toBeNull()
    expect(detectMediaTypeFromMime("application/octet-stream")).toBeNull()
  })

  it("returns null for unrelated MIME types", () => {
    expect(detectMediaTypeFromMime("text/html")).toBeNull()
    expect(detectMediaTypeFromMime("text/plain")).toBeNull()
    expect(detectMediaTypeFromMime("")).toBeNull()
  })
})

// ── getMaxBytesForType / getMaxMBForType (P1 addition) ───────────────────────

describe("getMaxBytesForType + getMaxMBForType", () => {
  it("video limit defaults to 100 MB", () => {
    expect(getMaxMBForType("video")).toBe(100)
    expect(getMaxBytesForType("video")).toBe(100 * 1024 * 1024)
  })

  it("audio limit defaults to 50 MB", () => {
    expect(getMaxMBForType("audio")).toBe(50)
    expect(getMaxBytesForType("audio")).toBe(50 * 1024 * 1024)
  })

  it("photo limit defaults to 20 MB", () => {
    expect(getMaxMBForType("photo")).toBe(20)
    expect(getMaxBytesForType("photo")).toBe(20 * 1024 * 1024)
  })

  it("getMaxBytesForType(type) === getMaxMBForType(type) * 1024 * 1024", () => {
    for (const t of ["video", "audio", "photo"] as const) {
      expect(getMaxBytesForType(t)).toBe(getMaxMBForType(t) * 1024 * 1024)
    }
  })
})

// ── PDF (vierter Medientyp, 2026-10-30) ──────────────────────────────────────

describe("PDF — size limit", () => {
  it("pdf limit defaults to 50 MB", () => {
    expect(getMaxMBForType("pdf")).toBe(50)
    expect(getMaxBytesForType("pdf")).toBe(50 * 1024 * 1024)
  })
})

describe("isPdfHeader — content check on the stored bytes, not on the client MIME", () => {
  it("accepts a file that starts with %PDF-", () => {
    expect(isPdfHeader(new TextEncoder().encode("%PDF-1.7\n%\xe2\xe3"))).toBe(true)
    expect(isPdfHeader(new TextEncoder().encode("%PDF-1.4"))).toBe(true)
  })

  it("rejects anything else — HTML, JPEG magic, empty, too short", () => {
    expect(isPdfHeader(new TextEncoder().encode("<!doctype html>"))).toBe(false)
    expect(isPdfHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe(false)
    expect(isPdfHeader(new Uint8Array(0))).toBe(false)
    expect(isPdfHeader(new TextEncoder().encode("%PDF"))).toBe(false)
  })

  it("rejects a header preceded by junk bytes (no sniffing past offset 0)", () => {
    expect(isPdfHeader(new TextEncoder().encode("xx%PDF-1.7"))).toBe(false)
  })
})

describe("safeOriginalName — client file name for display only", () => {
  it("keeps an ordinary name", () => {
    expect(safeOriginalName("Rechnung 2024-03.pdf")).toBe("Rechnung 2024-03.pdf")
  })

  it("strips path components and control characters", () => {
    expect(safeOriginalName("../../etc/passwd")).toBe("passwd")
    expect(safeOriginalName("C:\\Users\\x\\notes.pdf")).toBe("notes.pdf")
    expect(safeOriginalName("a\u0000b\u001fc.pdf")).toBe("abc.pdf")
  })

  it("caps the length at 200 characters", () => {
    const long = "x".repeat(300) + ".pdf"
    expect(safeOriginalName(long)!.length).toBe(200)
  })

  it("returns null for null, empty or whitespace-only input", () => {
    expect(safeOriginalName(null)).toBeNull()
    expect(safeOriginalName("")).toBeNull()
    expect(safeOriginalName("   ")).toBeNull()
    expect(safeOriginalName("..")).toBeNull()
  })
})
