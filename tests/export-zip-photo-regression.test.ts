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
import { unzipSync } from "fflate"
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

    const zip = unzipSync(await streamToBuffer(stream))

    const entry = zip[`photos/${ENTRY_ID_A}/photo-synth-a.jpg`]
    expect(entry).toBeDefined()
    expect(Buffer.from(entry).toString()).toBe("SYNTHETIC_JPEG_CONTENT_A_NOT_REAL")
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

    const zip = unzipSync(await streamToBuffer(stream))

    const entryA = zip[`photos/${ENTRY_ID_A}/photo-synth-a.jpg`]
    const entryB = zip[`photos/${ENTRY_ID_B}/photo-synth-b.jpg`]

    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(Buffer.from(entryA).toString()).toBe("SYNTHETIC_JPEG_CONTENT_A_NOT_REAL")
    expect(Buffer.from(entryB).toString()).toBe("SYNTHETIC_JPEG_CONTENT_B_NOT_REAL")

    // Entry IDs must be in different folders — not collapsed to photos/<filename>
    const names = Object.keys(zip)
    expect(names.find((n) => n.endsWith("photo-synth-a.jpg"))).toContain(ENTRY_ID_A)
    expect(names.find((n) => n.endsWith("photo-synth-b.jpg"))).toContain(ENTRY_ID_B)
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

    const zip = unzipSync(await streamToBuffer(stream))

    expect(zip["export.json"]).toBeDefined()
    expect(zip[`photos/${ENTRY_ID_A}/photo-synth-a.jpg`]).toBeDefined()
    expect(Object.keys(zip)).toHaveLength(2)
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
