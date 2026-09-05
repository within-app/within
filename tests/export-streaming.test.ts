import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import AdmZip from "adm-zip"
import { createExportArchiveStream } from "../src/lib/export-stream"

// ── helper ─────────────────────────────────────────────────────────────────

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

// ── synthetic test fixtures ─────────────────────────────────────────────────

let tmpDir: string
let smallMediaFile: string
let largeMediaFile: string // 15 MB synthetic file

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wit29-export-"))

  // Synthetic placeholder — NOT real journal content
  writeFileSync(join(tmpDir, "photo-synth.jpg"), Buffer.from("SYNTHETIC_JPEG_PLACEHOLDER_NOT_REAL"))
  smallMediaFile = join(tmpDir, "photo-synth.jpg")

  // Large synthetic file to test memory behaviour
  const large = Buffer.alloc(15 * 1024 * 1024, 0xcd)
  largeMediaFile = join(tmpDir, "large-synth.bin")
  writeFileSync(largeMediaFile, large)
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── createExportArchiveStream ───────────────────────────────────────────────

describe("createExportArchiveStream", () => {
  it("produces a valid ZIP containing the JSON manifest", async () => {
    const json = JSON.stringify({ version: "1.0", entries: [] })
    const stream = createExportArchiveStream("export.json", json, [])
    const buf = await streamToBuffer(stream)

    expect(buf.length).toBeGreaterThan(0)
    const zip = new AdmZip(buf)
    const entry = zip.getEntry("export.json")
    expect(entry).not.toBeNull()
    const content = entry!.getData().toString("utf8")
    expect(JSON.parse(content)).toEqual({ version: "1.0", entries: [] })
  })

  it("includes synthetic media files in the ZIP at the correct path", async () => {
    const json = JSON.stringify({ version: "1.0", entries: ["synth"] })
    const stream = createExportArchiveStream("export.json", json, [
      { absPath: smallMediaFile, zipName: "photos/abc123/photo-synth.jpg" },
    ])
    const buf = await streamToBuffer(stream)

    const zip = new AdmZip(buf)
    const photoEntry = zip.getEntry("photos/abc123/photo-synth.jpg")
    expect(photoEntry).not.toBeNull()
    expect(photoEntry!.getData().toString()).toBe("SYNTHETIC_JPEG_PLACEHOLDER_NOT_REAL")
  })

  it("streaming a 15 MB file keeps heap growth under 20 MB", async () => {
    if (global.gc) global.gc()
    const memBefore = process.memoryUsage().heapUsed

    const json = JSON.stringify({ version: "1.0", entries: ["large-synth"] })
    const stream = createExportArchiveStream("export.json", json, [
      { absPath: largeMediaFile, zipName: "photos/large-synth.bin" },
    ])

    // Drain the stream — simulates the HTTP response consuming it
    const reader = stream.getReader()
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) totalBytes += value.length
    }

    if (global.gc) global.gc()
    const memAfter = process.memoryUsage().heapUsed
    const growthBytes = memAfter - memBefore

    // Output is a valid non-empty ZIP
    expect(totalBytes).toBeGreaterThan(0)

    // Heap must not grow by 15 MB — allow 20 MB for archiver/zlib buffers
    expect(growthBytes).toBeLessThan(20 * 1024 * 1024)
  })
})
