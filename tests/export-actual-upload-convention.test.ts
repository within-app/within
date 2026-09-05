/**
 * Definitive regression: export works for the ACTUAL upload-route convention.
 *
 * The upload route (/api/upload) has ALWAYS stored photos at:
 *   public/media/<uuid>/<uuid>-original.<ext>
 * with DB file_path = '/media/<uuid>/<uuid>-original.<ext>'
 *
 * A previous QA test seeded data with 'photos/<entryId>/photo_X.jpg' in the DB
 * and files at uploads/photos/<entryId>/ — a path convention that never existed in this
 * codebase (confirmed by git history back to the first commit, d69cbe5).
 * That seeding mismatch caused the false-negative: existsSync saw the wrong path and
 * logged "photo file missing on disk, skipping", producing an empty ZIP.
 *
 * This file proves the export IS correct for real user-uploaded photos.
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

// ── Synthetic data that mirrors the REAL upload-route convention ─────────────
//
// /api/upload stores:
//   on disk:  <cwd>/public/media/<uuid>/<uuid>-original.<ext>
//   in DB:    file_path = '/media/<uuid>/<uuid>-original.<ext>'   (leading slash)

const JOURNAL_ID  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ENTRY_ID    = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const MEDIA_UUID  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const REAL_FILE_PATH = `/media/${MEDIA_UUID}/${MEDIA_UUID}-original.jpg`

const SYNTH_ENTRY_ROW = {
  id: ENTRY_ID, journal_id: JOURNAL_ID, text: "Synthetic entry (real-convention test)",
  created_at: new Date("2024-07-01T10:00:00Z"),
  updated_at: new Date("2024-07-01T11:00:00Z"),
  starred: false,
  location_name: null, location_lat: null, location_lng: null,
  weather_description: null, weather_temp_celsius: null, weather_icon: null,
}

function minimalReadableStream(): ReadableStream {
  return new ReadableStream({ start(c) { c.close() } })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("export works for actual upload-route file_path convention", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(existsSync).mockReturnValue(true)
    vi.spyOn(exportStream, "createExportArchiveStream").mockReturnValue(minimalReadableStream())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it("bundles photo when file_path uses the real /media/<uuid>/<uuid>-original.jpg format", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "m-real", entry_id: ENTRY_ID, type: "photo",
          file_path: REAL_FILE_PATH, thumbnail_path: null, order_index: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:4000/api/export")))
    expect(res.status).toBe(200)

    const calls = vi.mocked(exportStream.createExportArchiveStream).mock.calls
    expect(calls).toHaveLength(1)
    const [, , mediaFiles] = calls[0]

    // The photo must be present in the ZIP
    expect(mediaFiles).toHaveLength(1)
    // zipName must be photos/<entryId>/<filename> for import round-trip
    expect(mediaFiles[0].zipName).toBe(`photos/${ENTRY_ID}/${MEDIA_UUID}-original.jpg`)
    // absPath must point to <cwd>/public/media/<uuid>/<filename> — i.e. inside public/
    expect(mediaFiles[0].absPath).toContain("public/media/")
    expect(mediaFiles[0].absPath).toContain(`${MEDIA_UUID}-original.jpg`)
  })

  it("silently skips photo when file is missing from disk (existsSync returns false)", async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "m-missing", entry_id: ENTRY_ID, type: "photo",
          file_path: REAL_FILE_PATH, thumbnail_path: null, order_index: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:4000/api/export")))
    // 200 still returned — missing photo is skipped gracefully, not a hard error
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    expect(mediaFiles).toHaveLength(0)
  })

  it("rejects path traversal even with leading /media/ prefix that looks legitimate", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ id: "m-traversal", entry_id: ENTRY_ID, type: "photo",
          file_path: "/media/../../../etc/passwd", thumbnail_path: null, order_index: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:4000/api/export")))
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    expect(mediaFiles).toHaveLength(0)
  })

  it("bundles multiple photos from different entries with correct zipName per entry", async () => {
    const ENTRY_ID_2   = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    const MEDIA_UUID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
    const FILE_PATH_2  = `/media/${MEDIA_UUID_2}/${MEDIA_UUID_2}-original.png`

    const SYNTH_ENTRY_2 = { ...SYNTH_ENTRY_ROW, id: ENTRY_ID_2, journal_id: JOURNAL_ID }

    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "Synth Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW, SYNTH_ENTRY_2] } as never)
      .mockResolvedValueOnce({ rows: [
          { id: "m1", entry_id: ENTRY_ID,   type: "photo", file_path: REAL_FILE_PATH, thumbnail_path: null, order_index: 0 },
          { id: "m2", entry_id: ENTRY_ID_2, type: "photo", file_path: FILE_PATH_2,    thumbnail_path: null, order_index: 0 },
      ] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:4000/api/export")))
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    expect(mediaFiles).toHaveLength(2)

    const zips = mediaFiles.map(f => f.zipName)
    expect(zips).toContain(`photos/${ENTRY_ID}/${MEDIA_UUID}-original.jpg`)
    expect(zips).toContain(`photos/${ENTRY_ID_2}/${MEDIA_UUID_2}-original.png`)

    // Each entry must appear in its own folder — not collapsed to photos/<filename>
    expect(zips[0]).toContain(ENTRY_ID)
    expect(zips[1]).toContain(ENTRY_ID_2)
  })
})
