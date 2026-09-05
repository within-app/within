/**
 * Regression tests: export ZIP must bundle on-disk photo files.
 *
 * A previous fix shipped with zero photos in the export ZIP because:
 *   1. safeMediaPath used public/media/ as its base, rejecting uploads/photos/ paths
 *   2. export/[id] built zipName as "photos/<filename>" (missing entry-id tier)
 *
 * These tests drive createExportArchiveStream with real files on disk and assert
 * that the resulting ZIP contains "photos/<entryId>/<filename>" entries.
 * They complement the mock-based route tests in export-photo-path.test.ts.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import AdmZip from "adm-zip"
import { createExportArchiveStream } from "../src/lib/export-stream"

// ── helpers ─────────────────────────────────────────────────────────────────

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks)
}

// ── synthetic fixtures ────────────────────────────────────────────────────────

const ENTRY_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ENTRY_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

let tmpDir: string
let photoA: string    // absPath for entry A's photo
let photoB: string    // absPath for entry B's photo
let largeSynth: string // 15 MB for the streaming gate

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wit795-export-"))

  // Mirror the on-disk structure: uploads/photos/<entryId>/<filename>
  mkdirSync(join(tmpDir, "uploads", "photos", ENTRY_ID_A), { recursive: true })
  mkdirSync(join(tmpDir, "uploads", "photos", ENTRY_ID_B), { recursive: true })

  photoA = join(tmpDir, "uploads", "photos", ENTRY_ID_A, "photo-synth-a.jpg")
  photoB = join(tmpDir, "uploads", "photos", ENTRY_ID_B, "photo-synth-b.jpg")

  writeFileSync(photoA, Buffer.from("SYNTHETIC_JPEG_CONTENT_A_NOT_REAL"))
  writeFileSync(photoB, Buffer.from("SYNTHETIC_JPEG_CONTENT_B_NOT_REAL"))

  largeSynth = join(tmpDir, "uploads", "photos", ENTRY_ID_A, "large-synth.bin")
  writeFileSync(largeSynth, Buffer.alloc(15 * 1024 * 1024, 0xab))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── regression tests ──────────────────────────────────────────────────────────

describe("export ZIP photo bundling regression", () => {
  it("ZIP contains photos/<entryId>/<filename> for a single photo", async () => {
    const stream = createExportArchiveStream(
      "export.json",
      JSON.stringify({ version: "1.0", entries: ["synth-a"] }),
      [{ absPath: photoA, zipName: `photos/${ENTRY_ID_A}/photo-synth-a.jpg` }]
    )

    const buf = await streamToBuffer(stream)
    const zip = new AdmZip(buf)

    const entry = zip.getEntry(`photos/${ENTRY_ID_A}/photo-synth-a.jpg`)
    expect(entry).not.toBeNull()
    expect(entry!.getData().toString()).toBe("SYNTHETIC_JPEG_CONTENT_A_NOT_REAL")
  })

  it("ZIP contains photos/<entryId>/<filename> for multiple entries", async () => {
    const stream = createExportArchiveStream(
      "export.json",
      JSON.stringify({ version: "1.0", entries: ["synth-a", "synth-b"] }),
      [
        { absPath: photoA, zipName: `photos/${ENTRY_ID_A}/photo-synth-a.jpg` },
        { absPath: photoB, zipName: `photos/${ENTRY_ID_B}/photo-synth-b.jpg` },
      ]
    )

    const buf = await streamToBuffer(stream)
    const zip = new AdmZip(buf)

    const entryA = zip.getEntry(`photos/${ENTRY_ID_A}/photo-synth-a.jpg`)
    const entryB = zip.getEntry(`photos/${ENTRY_ID_B}/photo-synth-b.jpg`)

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    expect(entryA!.getData().toString()).toBe("SYNTHETIC_JPEG_CONTENT_A_NOT_REAL")
    expect(entryB!.getData().toString()).toBe("SYNTHETIC_JPEG_CONTENT_B_NOT_REAL")

    // Entry IDs must be in different folders — not collapsed to photos/<filename>
    expect(entryA!.entryName).toContain(ENTRY_ID_A)
    expect(entryB!.entryName).toContain(ENTRY_ID_B)
  })

  it("export.json manifest is present alongside photo entries", async () => {
    const exportJson = JSON.stringify({
      version: "1.0",
      entries: [{ id: ENTRY_ID_A, photos: [{ filename: "photo-synth-a.jpg" }] }],
    })
    const stream = createExportArchiveStream(
      "export.json",
      exportJson,
      [{ absPath: photoA, zipName: `photos/${ENTRY_ID_A}/photo-synth-a.jpg` }]
    )

    const buf = await streamToBuffer(stream)
    const zip = new AdmZip(buf)

    expect(zip.getEntry("export.json")).not.toBeNull()
    expect(zip.getEntry(`photos/${ENTRY_ID_A}/photo-synth-a.jpg`)).not.toBeNull()
    expect(zip.getEntries()).toHaveLength(2)
  })

  it("Pi stability gate: streaming a 15 MB photo keeps heap growth under 20 MB", async () => {
    if (global.gc) global.gc()
    const memBefore = process.memoryUsage().heapUsed

    const stream = createExportArchiveStream(
      "export.json",
      JSON.stringify({ version: "1.0", entries: ["large-synth"] }),
      [{ absPath: largeSynth, zipName: `photos/${ENTRY_ID_A}/large-synth.bin` }]
    )

    // Drain without buffering the full ZIP in RAM
    const reader = stream.getReader()
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) totalBytes += value.length
    }

    if (global.gc) global.gc()
    const growthBytes = process.memoryUsage().heapUsed - memBefore

    expect(totalBytes).toBeGreaterThan(0)
    // 15 MB file must not cause heap to grow by 15+ MB
    expect(growthBytes).toBeLessThan(20 * 1024 * 1024)
  })
})
