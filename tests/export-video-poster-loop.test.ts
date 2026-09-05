/**
 * Export includes video poster (thumbnail_path) and loop (preview_path)
 *
 * Red assertions (fail before implementation):
 *   1. Export JSON manifest includes thumbnailFilename for videos with thumbnail_path
 *   2. Export JSON manifest includes previewFilename for videos with preview_path
 *   3. ZIP mediaFiles list includes video-thumbnails/<entryId>/<name> path
 *   4. ZIP mediaFiles list includes video-previews/<entryId>/<name> path
 *   5. thumbnailFilename/previewFilename are null when paths are null
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

// ── Synthetic identifiers ────────────────────────────────────────────────────

const JOURNAL_ID    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ENTRY_ID      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const VIDEO_UUID    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const THUMB_UUID    = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const PREVIEW_UUID  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

const VIDEO_FILE_PATH    = `/media/${VIDEO_UUID}/${VIDEO_UUID}-original.mp4`
const THUMB_PATH         = `/media/${VIDEO_UUID}/${THUMB_UUID}-thumb.webp`
const PREVIEW_PATH       = `/media/${VIDEO_UUID}/${PREVIEW_UUID}-preview.webp`

const SYNTH_ENTRY_ROW = {
  id: ENTRY_ID, journal_id: JOURNAL_ID, text: "Synthetic video entry",
  created_at: new Date("2024-09-01T10:00:00Z"),
  updated_at: new Date("2024-09-01T11:00:00Z"),
  starred: false,
  location_name: null, location_lat: null, location_lng: null,
  weather_description: null, weather_temp_celsius: null, weather_icon: null,
}

function minimalReadableStream(): ReadableStream {
  return new ReadableStream({ start(c) { c.close() } })
}

function makeExportRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/export"))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("export includes video poster + loop (thumbnail_path + preview_path)", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(existsSync).mockReturnValue(true)
    vi.spyOn(exportStream, "createExportArchiveStream").mockReturnValue(minimalReadableStream())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it("export JSON includes thumbnailFilename for videos with thumbnail_path", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-1", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: THUMB_PATH,
        preview_path: null,
        order_index: 0,
        duration_seconds: 30,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const calls = vi.mocked(exportStream.createExportArchiveStream).mock.calls
    expect(calls).toHaveLength(1)

    const [jsonFilename, jsonBody] = calls[0]
    expect(jsonFilename).toBe("export.json")
    const manifest = JSON.parse(jsonBody) as {
      entries: Array<{
        videos?: Array<{ filename: string; thumbnailFilename?: string | null; previewFilename?: string | null }>
      }>
    }
    expect(manifest.entries).toHaveLength(1)
    const vid = manifest.entries[0].videos?.[0]
    expect(vid).toBeDefined()
    expect(vid!.filename).toBe(`${VIDEO_UUID}-original.mp4`)
    // KEY ASSERTION: thumbnailFilename must be set
    expect(vid!.thumbnailFilename).toBe(`${THUMB_UUID}-thumb.webp`)
    // preview is null
    expect(vid!.previewFilename).toBeNull()
  })

  it("export JSON includes previewFilename for videos with preview_path", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-2", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: THUMB_PATH,
        preview_path: PREVIEW_PATH,
        order_index: 0,
        duration_seconds: 30,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const [, jsonBody] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    const manifest = JSON.parse(jsonBody) as {
      entries: Array<{
        videos?: Array<{ thumbnailFilename?: string | null; previewFilename?: string | null }>
      }>
    }
    const vid = manifest.entries[0].videos?.[0]
    expect(vid!.previewFilename).toBe(`${PREVIEW_UUID}-preview.webp`)
    expect(vid!.thumbnailFilename).toBe(`${THUMB_UUID}-thumb.webp`)
  })

  it("ZIP mediaFiles includes video-thumbnails/<entryId>/<thumbName>", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-3", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: THUMB_PATH,
        preview_path: null,
        order_index: 0,
        duration_seconds: null,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]

    // The original video must be in the ZIP
    const videoEntry = mediaFiles.find(f => f.zipName.startsWith("videos/"))
    expect(videoEntry).toBeDefined()
    expect(videoEntry!.zipName).toBe(`videos/${ENTRY_ID}/${VIDEO_UUID}-original.mp4`)

    // The poster/thumbnail must ALSO be in the ZIP
    const thumbEntry = mediaFiles.find(f => f.zipName.startsWith("video-thumbnails/"))
    expect(thumbEntry).toBeDefined()
    expect(thumbEntry!.zipName).toBe(`video-thumbnails/${ENTRY_ID}/${THUMB_UUID}-thumb.webp`)
    expect(thumbEntry!.absPath).toContain("public/media/")
    expect(thumbEntry!.absPath).toContain(`${THUMB_UUID}-thumb.webp`)
  })

  it("ZIP mediaFiles includes video-previews/<entryId>/<previewName>", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-4", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: THUMB_PATH,
        preview_path: PREVIEW_PATH,
        order_index: 0,
        duration_seconds: 30,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]

    const previewEntry = mediaFiles.find(f => f.zipName.startsWith("video-previews/"))
    expect(previewEntry).toBeDefined()
    expect(previewEntry!.zipName).toBe(`video-previews/${ENTRY_ID}/${PREVIEW_UUID}-preview.webp`)
    expect(previewEntry!.absPath).toContain("public/media/")
    expect(previewEntry!.absPath).toContain(`${PREVIEW_UUID}-preview.webp`)
  })

  it("thumbnailFilename and previewFilename are null when paths are null", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-5", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: null,
        preview_path: null,
        order_index: 0,
        duration_seconds: null,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const [, jsonBody, mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    const manifest = JSON.parse(jsonBody) as {
      entries: Array<{
        videos?: Array<{ thumbnailFilename?: string | null; previewFilename?: string | null }>
      }>
    }
    const vid = manifest.entries[0].videos?.[0]
    expect(vid!.thumbnailFilename).toBeNull()
    expect(vid!.previewFilename).toBeNull()

    // No thumbnail/preview entries in ZIP
    expect(mediaFiles.find(f => f.zipName.startsWith("video-thumbnails/"))).toBeUndefined()
    expect(mediaFiles.find(f => f.zipName.startsWith("video-previews/"))).toBeUndefined()
  })

  it("poster missing from disk is skipped (no ZIP entry, no crash)", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: "m-vid-6", entry_id: ENTRY_ID, type: "video",
        file_path: VIDEO_FILE_PATH,
        thumbnail_path: THUMB_PATH,
        preview_path: null,
        order_index: 0,
        duration_seconds: null,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    // Video original exists, but thumbnail does NOT
    vi.mocked(existsSync).mockImplementation((p) => {
      return !(String(p).includes("thumb"))
    })

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(makeExportRequest())
    expect(res.status).toBe(200)

    const [, , mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    // Original video in ZIP
    expect(mediaFiles.find(f => f.zipName.startsWith("videos/"))).toBeDefined()
    // Thumbnail skipped (file missing)
    expect(mediaFiles.find(f => f.zipName.startsWith("video-thumbnails/"))).toBeUndefined()
  })
})
