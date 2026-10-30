/**
 * Export nimmt PDF-Anhänge mit (2026-10-30).
 *
 * Red assertions (fail before implementation):
 *   1. Manifest `entries[].pdfs` mit filename, orderIndex, originalName, sizeBytes
 *   2. ZIP-Dateiliste führt das PDF unter pdfs/<entryId>/<filename>
 *   3. Dasselbe für den Einzel-Export /api/export/[id]
 *   4. Ein PDF landet nie im photos/-Ordner (vorheriger Fallback „alles,
 *      was nicht video ist, ist audio" hätte es unter audios/ abgelegt)
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

const JOURNAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ENTRY_ID   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PDF_UUID   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const PDF_FILE_PATH = `/media/${PDF_UUID}/${PDF_UUID}-original.pdf`

const SYNTH_ENTRY_ROW = {
  id: ENTRY_ID, journal_id: JOURNAL_ID, text: "Synthetic pdf entry",
  created_at: new Date("2024-09-01T10:00:00Z"),
  updated_at: new Date("2024-09-01T11:00:00Z"),
  starred: false,
  location_name: null, location_lat: null, location_lng: null,
  weather_description: null, weather_temp_celsius: null, weather_icon: null,
}

const SYNTH_PDF_ROW = {
  id: "m-pdf-1", entry_id: ENTRY_ID, type: "pdf",
  file_path: PDF_FILE_PATH,
  thumbnail_path: null,
  preview_path: null,
  order_index: 2,
  duration_seconds: null,
  original_name: "Synth Vertrag.pdf",
  size_bytes: 4096,
}

type PdfManifest = { filename: string; orderIndex: number; originalName: string | null; sizeBytes: number | null }
type Manifest = { entries: Array<{ pdfs?: PdfManifest[]; audios?: unknown[]; photos?: unknown[] }> }
type MediaFile = { absPath: string; zipName: string }

function minimalReadableStream(): ReadableStream {
  return new ReadableStream({ start(c) { c.close() } })
}

describe("Export: PDF-Anhänge im Manifest und in der ZIP-Dateiliste", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(existsSync).mockReturnValue(true)
    vi.spyOn(exportStream, "createExportArchiveStream").mockReturnValue(minimalReadableStream())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it("Gesamt-Export: entries[].pdfs trägt filename, orderIndex, originalName, sizeBytes; ZIP-Pfad pdfs/<entryId>/<filename>", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_PDF_ROW] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    const res = await GET(new NextRequest(new URL("http://localhost:3000/api/export")))
    expect(res.status).toBe(200)

    const calls = vi.mocked(exportStream.createExportArchiveStream).mock.calls
    expect(calls).toHaveLength(1)
    const [, jsonBody, mediaFiles] = calls[0] as unknown as [string, string, MediaFile[]]
    const manifest = JSON.parse(jsonBody) as Manifest
    expect(manifest.entries[0].pdfs).toEqual([
      { filename: `${PDF_UUID}-original.pdf`, orderIndex: 2, originalName: "Synth Vertrag.pdf", sizeBytes: 4096 },
    ])
    expect(manifest.entries[0].audios).toEqual([])
    expect(manifest.entries[0].photos).toEqual([])

    expect(mediaFiles.map((f) => f.zipName)).toEqual([`pdfs/${ENTRY_ID}/${PDF_UUID}-original.pdf`])
  })

  it("Einzel-Export /api/export/[id]: gleiche Manifest-Form und gleicher ZIP-Pfad", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query).mockImplementation(async (sql: string) => {
      const s = sql.trim()
      if (s.includes("FROM entries")) return { rows: [{ ...SYNTH_ENTRY_ROW, journal_name: "S Journal", journal_color: "#000000" }] } as never
      if (s.includes("FROM media")) return { rows: [SYNTH_PDF_ROW] } as never
      if (s.includes("FROM journals")) return { rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never
      return { rows: [] } as never
    })

    const { GET } = await import("../src/app/api/export/[id]/route")
    const res = await GET(
      new NextRequest(new URL(`http://localhost:3000/api/export/${ENTRY_ID}`)),
      { params: Promise.resolve({ id: ENTRY_ID }) }
    )
    expect(res.status).toBe(200)

    const [, jsonBody, mediaFiles] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0] as unknown as [string, string, MediaFile[]]
    const manifest = JSON.parse(jsonBody) as Manifest
    expect(manifest.entries[0].pdfs).toEqual([
      { filename: `${PDF_UUID}-original.pdf`, orderIndex: 2, originalName: "Synth Vertrag.pdf", sizeBytes: 4096 },
    ])
    expect(mediaFiles.map((f) => f.zipName)).toEqual([`pdfs/${ENTRY_ID}/${PDF_UUID}-original.pdf`])
  })

  it("originalName/sizeBytes fehlen in der DB → null im Manifest, kein erfundener Wert", async () => {
    const { db } = await import("@/lib/db")
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ id: JOURNAL_ID, name: "S Journal", color: "#000000" }] } as never)
      .mockResolvedValueOnce({ rows: [SYNTH_ENTRY_ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ ...SYNTH_PDF_ROW, original_name: null, size_bytes: null }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const { GET } = await import("../src/app/api/export/route")
    await GET(new NextRequest(new URL("http://localhost:3000/api/export")))
    const [, jsonBody] = vi.mocked(exportStream.createExportArchiveStream).mock.calls[0]
    const manifest = JSON.parse(jsonBody) as Manifest
    expect(manifest.entries[0].pdfs![0].originalName).toBeNull()
    expect(manifest.entries[0].pdfs![0].sizeBytes).toBeNull()
  })
})
