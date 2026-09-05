/**
 * Regression test: EXIF orientation must be baked into thumbnails.
 *
 * A portrait iPhone photo has EXIF orientation 6 (90° CW). Without .rotate(),
 * sharp emits the raw (landscape) pixels and the thumbnail appears sideways.
 * With .rotate(), the output is portrait (height > width).
 *
 * The test deliberately runs the BROKEN pipeline first to prove it fails, then
 * the FIXED pipeline to prove it passes.
 */

import { describe, it, expect } from "vitest"
import sharp from "sharp"

// Build a synthetic 200×100 JPEG tagged as orientation 6 (90° CW / portrait iPhone).
// Raw pixels are landscape (200 wide, 100 tall).  After correct rotation the
// rendered image should be portrait (100 wide, 200 tall).
async function buildOrientedJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 100,
      channels: 3,
      background: { r: 128, g: 64, b: 32 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
}

describe("thumbnail EXIF orientation", () => {
  it("without .rotate() the output dimensions are WRONG (regression guard)", async () => {
    const input = await buildOrientedJpeg()

    // Broken pipeline — deliberately no .rotate()
    const outBuffer = await sharp(input)
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()

    const { width, height } = await sharp(outBuffer).metadata()

    // Without rotation the raw 200×100 landscape passes through as-is.
    // orientation 6 means the real scene is 100 wide × 200 tall, but the
    // broken pipeline gives us width > height (landscape, i.e. sideways).
    expect(width).toBeGreaterThan(height!)
  })

  it("with .rotate() the output dimensions are CORRECT (portrait)", async () => {
    const input = await buildOrientedJpeg()

    // Fixed pipeline — .rotate() reads and bakes EXIF orientation
    const outBuffer = await sharp(input)
      .rotate()
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()

    const { width, height } = await sharp(outBuffer).metadata()

    // After rotation a portrait image (taller than wide) must satisfy height > width.
    expect(height).toBeGreaterThan(width!)
  })
})
