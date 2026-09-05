/**
 * Video & Audio upload must stream to disk without buffering into heap.
 *
 * Red assertions (fail before the fix):
 *   1. saveFileToDisk exports from @/lib/upload-stream (module not found before fix)
 *   2. Data lands on disk at the expected path with correct size
 *   3. arrayBuffer() is NEVER called on the file-like object (streaming invariant)
 *   4. Heap growth during a 10 MB write stays below the file size
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { saveFileToDisk } from "../src/lib/upload-stream"

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a File-like object that streams data without offering arrayBuffer().
 * If saveFileToDisk calls arrayBuffer() it throws — proving buffering happened.
 */
function makeStreamOnlyFile(data: Uint8Array): {
  stream: () => ReadableStream<Uint8Array>
  arrayBuffer: () => Promise<ArrayBuffer>
} {
  return {
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit in 64 KB chunks to simulate real streaming
          const CHUNK = 64 * 1024
          let offset = 0
          while (offset < data.length) {
            controller.enqueue(data.subarray(offset, offset + CHUNK))
            offset += CHUNK
          }
          controller.close()
        },
      })
    },
    arrayBuffer(): Promise<ArrayBuffer> {
      throw new Error(
        "arrayBuffer() must NOT be called on video/audio files — use stream() instead"
      )
    },
  }
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

describe("saveFileToDisk", () => {
  it("writes file data to disk at the expected path", async () => {
    const data = new Uint8Array(256 * 1024).fill(0xab) // 256 KB synthetic
    const destPath = join(tmpRoot, "synth-video.mp4")
    const file = makeStreamOnlyFile(data)

    await saveFileToDisk(file, destPath)

    expect(existsSync(destPath)).toBe(true)
    expect(statSync(destPath).size).toBe(data.byteLength)
  })

  it("does not call arrayBuffer() — streams directly to disk", async () => {
    // makeStreamOnlyFile.arrayBuffer() throws if called — test passes only if streaming is used
    const data = new Uint8Array(1024).fill(0xcd)
    const destPath = join(tmpRoot, "no-buffer.mp3")
    const file = makeStreamOnlyFile(data)

    // Must not throw (arrayBuffer not called)
    await expect(saveFileToDisk(file, destPath)).resolves.toBeUndefined()
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
    const file = makeStreamOnlyFile(data)

    if (typeof global.gc === "function") global.gc()
    const memBefore = process.memoryUsage().heapUsed

    await saveFileToDisk(file, destPath)

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
