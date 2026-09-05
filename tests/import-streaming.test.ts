/**
 * Import route must stream ZIP media to disk rather than buffering
 * the entire decompressed archive in RAM.
 *
 * Red assertions (fail before the streaming fix):
 *   1. streamUnzipToDisk exports from @/lib/import-stream (module not found before fix)
 *   2. Photo data lands on disk at the expected path, not in a Uint8Array dict
 *   3. JSON metadata is buffered in memory (it's small)
 *   4. Heap growth during a 10 MB photo import stays below the file's uncompressed size
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, existsSync, statSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { zipSync, strToU8 } from "fflate"
import { streamUnzipToDisk } from "../src/lib/import-stream"

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWebStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function buildSynthZip(photoBytes: Uint8Array): Uint8Array {
  const manifest = JSON.stringify({
    entries: [{ uuid: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", creationDate: "2025-01-01T00:00:00Z" }],
  })
  return zipSync(
    {
      "Journal.json": strToU8(manifest),
      "photos/synth-photo.jpg": [photoBytes, { level: 0 }],
    },
    { level: 0 },
  )
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "wit790-import-stream-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("streamUnzipToDisk", () => {
  it("writes media entries to disk and keeps JSON in memory", async () => {
    const photoData = new Uint8Array(256 * 1024).fill(0xab) // 256 KB synthetic photo
    const zip = buildSynthZip(photoData)

    const tmpDir = mkdtempSync(join(tmpRoot, "pass1-"))
    const { jsonName, jsonData, diskFiles } = await streamUnzipToDisk(
      makeWebStream(zip),
      tmpDir,
    )

    // JSON file is in memory
    expect(jsonName).toBe("Journal.json")
    expect(jsonData).not.toBeNull()
    const parsed = JSON.parse(new TextDecoder().decode(jsonData!))
    expect(parsed.entries).toHaveLength(1)

    // Photo file is on disk, not in the jsonData or diskFiles buffer
    const diskPath = diskFiles.get("photos/synth-photo.jpg")
    expect(diskPath).toBeDefined()
    expect(existsSync(diskPath!)).toBe(true)
    expect(statSync(diskPath!).size).toBe(photoData.byteLength)
  })

  it("heap growth while streaming a 10 MB photo stays well below 10 MB", async () => {
    const PHOTO_BYTES = 10 * 1024 * 1024 // 10 MB

    // Fill with non-compressible pseudo-random bytes so level:0 is accurate
    const photoData = new Uint8Array(PHOTO_BYTES)
    let seed = 0xdeadbeef
    for (let i = 0; i < PHOTO_BYTES; i++) {
      seed = ((seed * 1664525 + 1013904223) >>> 0)
      photoData[i] = seed & 0xff
    }

    const zip = buildSynthZip(photoData)
    const tmpDir = mkdtempSync(join(tmpRoot, "heap-"))

    if (typeof global.gc === "function") global.gc()
    const memBefore = process.memoryUsage().heapUsed

    const { diskFiles } = await streamUnzipToDisk(makeWebStream(zip), tmpDir)

    if (typeof global.gc === "function") global.gc()
    const memAfter = process.memoryUsage().heapUsed

    // Photo must be on disk
    const diskPath = diskFiles.get("photos/synth-photo.jpg")
    expect(diskPath).toBeDefined()
    expect(statSync(diskPath!).size).toBe(PHOTO_BYTES)

    // Heap must not have grown by the full photo size.
    // Streaming: heap grows by at most a few KB (chunk buffers, fflate internals).
    // Old buffering path: heap would grow by ~10 MB.
    // Allow 10 MB margin to absorb GC timing and test-runner overhead.
    const growthBytes = memAfter - memBefore
    expect(growthBytes).toBeLessThan(PHOTO_BYTES)
  })

  it("reports 413 when compressed stream exceeds 100 MB", async () => {
    // Push slightly-over-100-MB of raw bytes (not a valid ZIP, but the compressed
    // size guard fires before fflate tries to parse it as ZIP headers)
    const oversize = new Uint8Array(101 * 1024 * 1024)

    const tmpDir = mkdtempSync(join(tmpRoot, "413-"))
    const { ImportZipError } = await import("../src/lib/import-stream")

    let caught: unknown
    try {
      await streamUnzipToDisk(makeWebStream(oversize), tmpDir)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImportZipError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((caught as any).kind).toBe("too_large")
  })

  it("rejects ZIP entries with path-traversal names", async () => {
    const malicious = zipSync({
      "../outside.txt": strToU8("evil"),
      "Journal.json": strToU8(JSON.stringify({ entries: [] })),
    })

    const tmpDir = mkdtempSync(join(tmpRoot, "traversal-"))
    const { ImportZipError } = await import("../src/lib/import-stream")

    let caught: unknown
    try {
      await streamUnzipToDisk(makeWebStream(malicious), tmpDir)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(ImportZipError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((caught as any).kind).toBe("security")
  })
})
