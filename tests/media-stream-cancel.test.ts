/**
 * A client that drops the connection mid-range (video players do this on
 * every seek) makes Next cancel the response body stream. Readable.toWeb
 * keeps feeding the fs stream's already-buffered chunk into the cancelled
 * controller from a 'data' listener — a synchronous throw inside an event
 * handler, i.e. an uncaughtException on the Pi:
 *   TypeError: Invalid state: Controller is already closed (ERR_INVALID_STATE)
 *   at ReadableStreamDefaultController.enqueue
 *   at ReadStream.onData (node:internal/webstreams/adapters)
 * The sequence below hits that window deterministically. The export archive
 * stream is built the same way and shares the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createMediaStream } from "../src/lib/media-stream"

let tmpDir: string
let file: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "media-cancel-"))
  file = join(tmpDir, "video.bin")
  // > 3 fs chunks (64 KiB each): one read, one queued, one still buffered in the fs stream
  writeFileSync(file, Buffer.alloc(300 * 1024, 0xab))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Runs fn with the process-level uncaughtException listeners swapped out; returns what escaped. */
async function collectUncaught(fn: () => Promise<void>): Promise<unknown[]> {
  const previous = process.rawListeners("uncaughtException")
  const seen: unknown[] = []
  process.removeAllListeners("uncaughtException")
  process.on("uncaughtException", (err) => { seen.push(err) })
  try {
    await fn()
  } finally {
    process.removeAllListeners("uncaughtException")
    for (const listener of previous) process.on("uncaughtException", listener as NodeJS.UncaughtExceptionListener)
  }
  return seen
}

describe("createMediaStream — cancel while the fs stream still holds a chunk", () => {
  it("does not throw ERR_INVALID_STATE out of a stream event handler", async () => {
    const escaped = await collectUncaught(async () => {
      const reader = createMediaStream(file, 0, 300 * 1024 - 1).getReader()
      await reader.read()                                  // chunk 1 — the fs stream starts flowing
      await new Promise((r) => setTimeout(r, 30))          // chunk 2 queued, chunk 3 buffered inside the fs stream
      await reader.read()                                  // dequeues chunk 2 → pull → resume() scheduled on nextTick
      await reader.cancel()                                // client gone: stream closed, fs stream destroyed
      await new Promise((r) => setTimeout(r, 30))          // nextTick resume_ → flow → buffered chunk 3 → enqueue on a closed controller
    })
    expect(escaped).toEqual([])
  })
})
