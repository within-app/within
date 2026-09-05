import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { resolveRange, createMediaStream } from "../src/lib/media-stream"

// ── helpers ────────────────────────────────────────────────────────────────

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

// ── synthetic test data ────────────────────────────────────────────────────

let tmpDir: string
let testFile: string  // 1000-byte file: byte[i] = i % 256
let largeFile: string // 20 MB file filled with 0xAB

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wit29-media-"))

  const small = Buffer.allocUnsafe(1000)
  for (let i = 0; i < 1000; i++) small[i] = i % 256
  testFile = join(tmpDir, "small.bin")
  writeFileSync(testFile, small)

  const large = Buffer.alloc(20 * 1024 * 1024, 0xab)
  largeFile = join(tmpDir, "large.bin")
  writeFileSync(largeFile, large)
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── resolveRange ───────────────────────────────────────────────────────────

describe("resolveRange", () => {
  it("returns isRange=false with no range header", () => {
    const r = resolveRange(null, 1000, true)
    expect(r.isRange).toBe(false)
    expect(r.start).toBe(0)
    expect(r.end).toBe(999)
  })

  it("parses a half-open Range header (bytes=100-199)", () => {
    const r = resolveRange("bytes=100-199", 1000, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(100)
    expect(r.end).toBe(199)
  })

  it("handles open-ended range (bytes=500-)", () => {
    const r = resolveRange("bytes=500-", 1000, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(500)
    expect(r.end).toBe(999) // fileSize - 1
  })

  it("returns isRange=false when supportsRanges=false even with Range header", () => {
    const r = resolveRange("bytes=0-100", 1000, false)
    expect(r.isRange).toBe(false)
  })

  it("full-file range (bytes=0-) covers the entire file", () => {
    const r = resolveRange("bytes=0-", 500, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(0)
    expect(r.end).toBe(499)
  })

  // Suffix-range (bytes=-N) must not produce NaN start
  it("parses suffix-range (bytes=-500) — last 500 bytes of 1000-byte file", () => {
    const r = resolveRange("bytes=-500", 1000, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(500)
    expect(r.end).toBe(999)
  })

  it("suffix-range larger than file clamps start to 0 (bytes=-2000 on 1000-byte file)", () => {
    const r = resolveRange("bytes=-2000", 1000, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(0)
    expect(r.end).toBe(999)
  })

  // End exceeding fileSize must be capped to fileSize - 1
  it("caps end to fileSize - 1 when client sends over-large end (bytes=0-999999999)", () => {
    const r = resolveRange("bytes=0-999999999", 1000, true)
    expect(r.isRange).toBe(true)
    expect(r.start).toBe(0)
    expect(r.end).toBe(999)
  })
})

// ── createMediaStream ──────────────────────────────────────────────────────

describe("createMediaStream", () => {
  it("returns the correct bytes for a sub-range", async () => {
    // Request bytes 100-199 (inclusive) = 100 bytes
    const stream = createMediaStream(testFile, 100, 199)
    const buf = await streamToBuffer(stream)

    expect(buf.length).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(buf[i]).toBe((100 + i) % 256)
    }
  })

  it("streams the full file when start=0, end=fileSize-1", async () => {
    const stream = createMediaStream(testFile, 0, 999)
    const buf = await streamToBuffer(stream)

    expect(buf.length).toBe(1000)
    for (let i = 0; i < 1000; i++) {
      expect(buf[i]).toBe(i % 256)
    }
  })

  it("a 1 KB range of a 20 MB file keeps heap growth under 5 MB", async () => {
    // Force GC so we start from a clean baseline
    if (global.gc) global.gc()

    const memBefore = process.memoryUsage().heapUsed

    // Only request the first 1 KB of a 20 MB file
    const stream = createMediaStream(largeFile, 0, 1023)
    const buf = await streamToBuffer(stream)

    if (global.gc) global.gc()
    const memAfter = process.memoryUsage().heapUsed

    expect(buf.length).toBe(1024)
    expect(buf[0]).toBe(0xab)
    expect(buf[1023]).toBe(0xab)

    // Heap must not grow by 20 MB — allow 5 MB for test/VM overhead
    const growthBytes = memAfter - memBefore
    expect(growthBytes).toBeLessThan(5 * 1024 * 1024)
  })
})
