/**
 * Export photo bundling: safeMediaPath guard + zipName format
 *
 * Assertions:
 *   1. media/<uuid>/<file> is accepted by safeMediaPath and included in ZIP
 *      (the canonical guard uses base=public/media/ which accepts these real upload paths)
 *   2. export/[id] produces zipName "photos/<entryId>/<filename>", not "photos/<filename>"
 *      (entry id required for import round-trip)
 *
 * Security regression (always passes):
 *   3. path traversal (../etc/passwd) is rejected — file not included in ZIP
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import * as exportStream from "../src/lib/export-stream"
import { existsSync } from "fs"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}))

// ── Synthetic test data ────────────────────────────────────────────────────

const JOURNAL_ID = "11111111-1111-4111-8111-111111111111"
const ENTRY_ID   = "22222222-2222-4222-8222-222222222222"
const PHOTO_UUID = "33333333-3333-4333-8333-333333333333"
const PHOTO_FILE = `${PHOTO_UUID}-original.jpg`
const FILE_PATH  = `/media/${PHOTO_UUID}/${PHOTO_FILE}`

const SYNTH_ENTRY_ROW = {
  id: ENTRY_ID, journal_id: JOURNAL_ID, text: "Synthetic entry",
  created_at: new Date("2024-06-01T08:00:00Z"),
  updated_at: new Date("2024-06-01T09:00:00Z"),
  starred: false,
  location_name: null, location_lat: null, location_lng: null,
  weather_description: null, weather_temp_celsius: null, weather_icon: null,
}

function minimalReadableStream(): ReadableStream {
  return new ReadableStream({ start(c) { c.close() } })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("export photo bundling", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(existsSync).mockReturnValue(true)
    vi.spyOn(exportStream, "createExportArchiveStream").mockReturnValue(minimalReadableStream())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  // ── Test 1: safeMediaPath accepts media/<uuid>/<file> (real upload path) ──
  // Real upload route stores files as /media/<uuid>/<uuid>-original.<ext>
  // Canonical safeMediaPath (base=public/media/) accepts these paths.

  it("includes upload photo in ZIP — media/<uuid>/<file> accepted by safeMediaPath", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      // journals query
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }] } as never)
      // entries query
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      // media query
      .mockResolvedValueOnce({ rows: [{ id: "m1", entry_id: ENTRY_ID, type: "photo",
          file_path: FILE_PATH, thumbnail_path: null, order_index: 0 }] } as never)
      // tags query
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:3000/api/export")))
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    // Upload path must be included — safeMediaPath must not throw for uploads/photos/<id>/<file>
    expect(mediaFiles).toHaveLength(1)
    expect(mediaFiles[0].zipName).toBe(`photos/${ENTRY_ID}/${PHOTO_FILE}`)
  })

  // ── Test 2: export/[id] zipName includes entry ID ─────────────────────────
  // Red: old code produced "photos/<filename>" (no entry id) → assertion fails
  // Green: new code produces "photos/<entryId>/<filename>"

  it("export/[id] zipName is photos/<entryId>/<filename>, not photos/<filename>", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      // entry+journal join query
      .mockResolvedValueOnce({ rows: [{ ...SYNTH_ENTRY_ROW,
          journal_name: "Synth Journal", journal_color: "#FF0000" }] } as never)
      // media query
      .mockResolvedValueOnce({ rows: [{ type: "photo", file_path: FILE_PATH, order_index: 0 }] } as never)
      // tags query
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/[id]/route")
    const res = await GET(
      new NextRequest(new URL(`http://localhost:3000/api/export/${ENTRY_ID}`)),
      { params: Promise.resolve({ id: ENTRY_ID }) }
    )
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    expect(mediaFiles).toHaveLength(1)
    // Must be photos/<entryId>/<filename>, NOT photos/<filename>
    expect(mediaFiles[0].zipName).toBe(`photos/${ENTRY_ID}/${PHOTO_FILE}`)
  })

  // ── Test 3: path traversal rejected (security regression) ─────────────────
  // Passes with or without fix — validates the guard is preserved after the base change.

  it("path traversal (../etc/passwd) is rejected — not included in ZIP", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#FF0000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "m2", entry_id: ENTRY_ID, type: "photo",
          file_path: "../etc/passwd", thumbnail_path: null, order_index: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:3000/api/export")))
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    expect(mediaFiles).toHaveLength(0)
  })
})
