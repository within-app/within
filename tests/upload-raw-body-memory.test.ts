/**
 * POST /api/upload streams the raw body to disk — no formData(), no
 * arrayBuffer(): a 30 MB body must not grow heap + arrayBuffers by anything
 * near its own size (the old multipart path buffered the whole body twice).
 *
 * Real fs (tmp dir as cwd), real sharp for the photo path; ffprobe/ffmpeg
 * are mocked. Synthetic data only — no real journal content.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { mkdtempSync, rmSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// Session + rate limit are proven in tests/api-guard-bypass-proxy.test.ts.
vi.mock("@/lib/request-guard", () => ({ guardApiRequest: async () => null }))
vi.mock("@/lib/video-thumbnail", () => ({
  extractPoster: vi.fn().mockResolvedValue(null),
  generateLoopClip: vi.fn(),
  probeDuration: vi.fn().mockResolvedValue(null),
  probeMediaStreams: vi.fn().mockResolvedValue("valid"),
}))
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

// No DATABASE_URL: the route answers 201 without a media row — the disk path
// is what this test is about.
delete process.env.DATABASE_URL

const { POST } = await import("@/app/api/upload/route")

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

let tmpRoot: string
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "upload-raw-body-"))
  vi.spyOn(process, "cwd").mockReturnValue(tmpRoot)
})
afterAll(() => {
  vi.restoreAllMocks()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function memNow() {
  const m = process.memoryUsage()
  return m.heapUsed + m.arrayBuffers
}

/**
 * Lazily generated body — the source never holds the whole payload. Samples
 * memory on every pull: a buffering implementation shows its peak WHILE the
 * body flows, which a before/after snapshot (GC in between) would miss.
 * One shared chunk buffer on purpose: fresh per-chunk allocations pile up as
 * uncollected garbage and would blur the sample; a copying implementation
 * (multipart File, Buffer.concat) still has to grow by the whole body.
 * Halfway through it also records how many bytes already sit on disk: a
 * collect-views-then-concat implementation keeps the memory sample flat but
 * cannot have written anything while the body is still flowing.
 */
function makeBody(totalBytes: number, chunkBytes = 64 * 1024) {
  let sent = 0
  const chunk = new Uint8Array(chunkBytes).fill(0xab)
  const sample = { peak: 0, onDiskAtHalf: -1 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sample.peak = Math.max(sample.peak, memNow())
      if (sample.onDiskAtHalf < 0 && sent >= totalBytes / 2) sample.onDiskAtHalf = largestMediaFile()
      if (sent >= totalBytes) return controller.close()
      const n = Math.min(chunkBytes, totalBytes - sent)
      controller.enqueue(chunk.subarray(0, n))
      sent += n
    },
  })
  return { stream, sample }
}

function rawRequest(contentType: string, body: ReadableStream<Uint8Array> | Buffer, length: number) {
  return new NextRequest("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": contentType, "content-length": String(length) },
    body,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1])
}

function mediaFiles(): string[] {
  const root = join(tmpRoot, "public", "media")
  return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).map((f) => join(root, d, f)))
}

function largestMediaFile(): number {
  try {
    return Math.max(0, ...mediaFiles().map((f) => statSync(f).size))
  } catch {
    return 0
  }
}

describe("POST /api/upload — raw body streams to disk", () => {
  it("30 MB audio body: peak heap + arrayBuffers while streaming stays far below the body", async () => {
    const BODY_BYTES = 30 * 1024 * 1024
    if (typeof global.gc === "function") global.gc()
    const before = memNow()
    const { stream, sample } = makeBody(BODY_BYTES)

    const res = await POST(rawRequest("audio/mpeg", stream, BODY_BYTES))

    const peakGrowth = sample.peak - before
    console.info(`[upload-raw-body] 30 MB body → peak heap+arrayBuffers growth ${(peakGrowth / 1024 / 1024).toFixed(1)} MB, on disk at half: ${(sample.onDiskAtHalf / 1024 / 1024).toFixed(1)} MB`)
    expect(res.status).toBe(201)
    // Bytes reach the disk while the body is still flowing — no buffering variant can do that.
    expect(sample.onDiskAtHalf).toBeGreaterThan(0)
    const written = mediaFiles().find((f) => f.endsWith("-original.mp3"))
    expect(written).toBeDefined()
    expect(statSync(written!).size).toBe(BODY_BYTES) // real-size verify
    // Multipart buffered the body at least once (~30 MB); streaming keeps a
    // handful of 64 KB chunks alive. Half the body is a generous ceiling.
    expect(peakGrowth).toBeLessThan(BODY_BYTES / 2)
  })

  it("photo body: sharp validates from disk, file gets its real extension and a thumbnail", async () => {
    const res = await POST(rawRequest("image/png", PNG_1PX, PNG_1PX.byteLength))

    expect(res.status).toBe(201)
    const body = await res.json() as { filePath: string; thumbnailPath: string }
    expect(body.filePath).toMatch(/-original\.png$/)
    expect(body.thumbnailPath).toMatch(/-thumb\.webp$/)
    // Only the two final files in the upload dir — no temp leftover.
    const [, , uuid] = body.filePath.split("/")
    expect(readdirSync(join(tmpRoot, "public", "media", uuid)).sort()).toEqual(
      [body.filePath.split("/").pop(), body.thumbnailPath.split("/").pop()].sort()
    )
  })

  it("photo body that is not an image: 400 invalid_image and the upload dir is gone", async () => {
    const junk = Buffer.alloc(2048, 0x42)
    const dirsBefore = readdirSync(join(tmpRoot, "public", "media")).length

    const res = await POST(rawRequest("image/png", junk, junk.byteLength))

    expect(res.status).toBe(400)
    expect((await res.json() as { code: string }).code).toBe("invalid_image")
    expect(readdirSync(join(tmpRoot, "public", "media")).length).toBe(dirsBefore)
  })
})
