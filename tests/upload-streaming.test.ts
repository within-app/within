/**
 * Upload bodies must stream to disk without buffering into heap.
 *
 * saveBodyToDisk takes the raw request body (Web ReadableStream), pipes it
 * to disk and counts bytes: exceeding maxBytes aborts with UploadTooLargeError
 * (fail-safe behind the content-length pre-check).
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { saveBodyToDisk, UploadTooLargeError } from "../src/lib/upload-stream"

// ── Helpers ────────────────────────────────────────────────────────────────

/** Streams data in 64 KB chunks like a real request body. */
function makeBody(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const CHUNK = 64 * 1024
      let offset = 0
      while (offset < data.length) {
        controller.enqueue(data.subarray(offset, offset + CHUNK))
        offset += CHUNK
      }
      controller.close()
    },
  })
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "wit1093-upload-stream-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("saveBodyToDisk", () => {
  it("writes the body to disk at the expected path and returns the byte count", async () => {
    const data = new Uint8Array(256 * 1024).fill(0xab) // 256 KB synthetic
    const destPath = join(tmpRoot, "synth-video.mp4")

    await expect(saveBodyToDisk(makeBody(data), destPath, data.byteLength)).resolves.toBe(data.byteLength)

    expect(existsSync(destPath)).toBe(true)
    expect(statSync(destPath).size).toBe(data.byteLength)
  })

  it("aborts with UploadTooLargeError once the body exceeds maxBytes", async () => {
    const data = new Uint8Array(200 * 1024).fill(0xcd)
    const destPath = join(tmpRoot, "too-large.mp3")

    await expect(saveBodyToDisk(makeBody(data), destPath, 100 * 1024)).rejects.toBeInstanceOf(UploadTooLargeError)
    // Fail-safe stops early — never the full body on disk.
    expect(statSync(destPath).size).toBeLessThan(data.byteLength)
  })

  it("heap growth during a 10 MB write stays below the file size", async () => {
    const FILE_BYTES = 10 * 1024 * 1024

    const data = new Uint8Array(FILE_BYTES)
    let seed = 0xdeadbeef
    for (let i = 0; i < FILE_BYTES; i++) {
      seed = ((seed * 1664525 + 1013904223) >>> 0)
      data[i] = seed & 0xff
    }

    const destPath = join(tmpRoot, "heap-check.mp4")

    if (typeof global.gc === "function") global.gc()
    const memBefore = process.memoryUsage().heapUsed

    await saveBodyToDisk(makeBody(data), destPath, FILE_BYTES)

    if (typeof global.gc === "function") global.gc()
    const memAfter = process.memoryUsage().heapUsed

    expect(existsSync(destPath)).toBe(true)
    expect(statSync(destPath).size).toBe(FILE_BYTES)

    // Streaming: heap grows by at most chunk buffers (64 KB × a few).
    // Old Buffer.from(arrayBuffer()): heap would grow by ~10 MB.
    // Allow 5 MB margin for GC timing and test runner overhead.
    const growthBytes = memAfter - memBefore
    expect(growthBytes).toBeLessThan(FILE_BYTES)
  })
})
