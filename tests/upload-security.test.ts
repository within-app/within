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

  it("returns null for unrelated MIME types", () => {
    expect(safeExtFromMime("application/pdf")).toBeNull()
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

  it("returns null for unrelated MIME types", () => {
    expect(detectMediaTypeFromMime("application/pdf")).toBeNull()
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
