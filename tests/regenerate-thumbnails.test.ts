/**
 * Backfill: regenerate broken thumbnails
 *
 * Tests the core thumbnail regeneration logic used by
 * scripts/regenerate-thumbnails.mjs on synthetic disk fixtures.
 *
 * Proves, without touching a real DB or real media:
 *   1. An EXIF-oriented original is regenerated into an upright WebP thumbnail.
 *   2. The original file bytes are NOT modified.
 *   3. The output is a valid WebP, width ≤ 400 px.
 *
 * No real journal content is used (Constraint D).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"
import { mkdir, rm, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import sharp from "sharp"

// Import the exported regenerateThumb function from the script.
// The cast avoids TypeScript resolving the .mjs module types.
let regenerateThumb: (originalPath: string, thumbPath: string) => Promise<void>

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("../scripts/regenerate-thumbnails.mjs")) as any
  regenerateThumb = mod.regenerateThumb
})

// Build a synthetic JPEG tagged as EXIF orientation 6 (portrait iPhone, 90° CW).
// Raw pixel grid is 200 × 100 (landscape); correct baking makes visual portrait (100 × 200).
async function buildOrientedJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 100,
      channels: 3,
      background: { r: 100, g: 80, b: 60 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
}

describe("regenerateThumb()", () => {
  let tmpDir: string
  let originalPath: string
  let thumbPath: string
  let originalBytes: Buffer

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wit570-test-${Date.now()}-${process.pid}`)
    await mkdir(tmpDir, { recursive: true })
    originalPath = join(tmpDir, "photo-original.jpg")
    thumbPath = join(tmpDir, "photo-thumb.webp")
    originalBytes = await buildOrientedJpeg()
    await writeFile(originalPath, originalBytes)
    // Simulate a stale/wrong thumbnail already on disk
    await writeFile(thumbPath, Buffer.from("stale placeholder bytes"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("overwrites the thumbnail with an upright portrait image", async () => {
    await regenerateThumb(originalPath, thumbPath)

    const { width, height } = await sharp(thumbPath).metadata()
    // EXIF orientation 6 → visual portrait (taller than wide). After .rotate() baking:
    // width ≈ 100 (limited by resize), height ≈ 200.
    expect(height).toBeGreaterThan(width!)
  })

  it("does NOT modify the original file", async () => {
    await regenerateThumb(originalPath, thumbPath)

    const afterBytes = await readFile(originalPath)
    expect(Buffer.compare(afterBytes, originalBytes)).toBe(0)
  })

  it("produces a valid WebP file ≤ 400 px wide", async () => {
    await regenerateThumb(originalPath, thumbPath)

    const { format, width } = await sharp(thumbPath).metadata()
    expect(format).toBe("webp")
    expect(width).toBeLessThanOrEqual(400)
  })
})
