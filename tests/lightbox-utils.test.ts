/**
 * Lightbox keyboard/touch/preload utils
 * TDD red — tests for pure navigation logic extracted from photo-gallery.tsx
 * Runs in node environment (no DOM needed).
 */

import { describe, it, expect } from "vitest"
import {
  nextIndex,
  prevIndex,
  swipeDirection,
  preloadUrls,
  lightboxPhoto,
} from "../src/lib/lightbox-utils"

describe("nextIndex", () => {
  it("advances to the next photo", () => {
    expect(nextIndex(0, 3)).toBe(1)
    expect(nextIndex(1, 3)).toBe(2)
  })

  it("wraps from last to first", () => {
    expect(nextIndex(2, 3)).toBe(0)
  })

  it("handles single-photo edge case (stays at 0)", () => {
    expect(nextIndex(0, 1)).toBe(0)
  })
})

describe("prevIndex", () => {
  it("goes to the previous photo", () => {
    expect(prevIndex(2, 3)).toBe(1)
    expect(prevIndex(1, 3)).toBe(0)
  })

  it("wraps from first to last", () => {
    expect(prevIndex(0, 3)).toBe(2)
  })

  it("handles single-photo edge case (stays at 0)", () => {
    expect(prevIndex(0, 1)).toBe(0)
  })
})

describe("swipeDirection", () => {
  const THRESHOLD = 50

  it("returns 'next' for a left swipe beyond the threshold", () => {
    expect(swipeDirection(200, 100, THRESHOLD)).toBe("next")
  })

  it("returns 'prev' for a right swipe beyond the threshold", () => {
    expect(swipeDirection(100, 200, THRESHOLD)).toBe("prev")
  })

  it("returns null when swipe is within threshold", () => {
    expect(swipeDirection(100, 130, THRESHOLD)).toBeNull()
    expect(swipeDirection(130, 100, THRESHOLD)).toBeNull()
    expect(swipeDirection(100, 100, THRESHOLD)).toBeNull()
  })

  it("returns null for swipe exactly at threshold (not strictly greater)", () => {
    expect(swipeDirection(100, 150, THRESHOLD)).toBeNull()
    expect(swipeDirection(150, 100, THRESHOLD)).toBeNull()
  })

  it("returns 'prev' for right swipe just over threshold", () => {
    expect(swipeDirection(100, 151, THRESHOLD)).toBe("prev")
  })

  it("returns 'next' for left swipe just over threshold", () => {
    expect(swipeDirection(151, 100, THRESHOLD)).toBe("next")
  })
})

describe("preloadUrls", () => {
  const photos = [
    { filePath: "/media/a.jpg", thumbnailPath: "/media/a_thumb.jpg" },
    { filePath: "/media/b.jpg", thumbnailPath: "/media/b_thumb.jpg" },
    { filePath: "/media/c.jpg", thumbnailPath: null },
  ]

  it("returns [prevUrl, nextUrl] — thumbnails when available, filePath as fallback", () => {
    const [prev, next] = preloadUrls(1, photos)
    expect(prev).toBe("/media/a_thumb.jpg") // index 0 thumbnail
    expect(next).toBe("/media/c.jpg")        // index 2 has no thumbnail → filePath
  })

  it("wraps around for first photo", () => {
    const [prev, next] = preloadUrls(0, photos)
    expect(prev).toBe("/media/c.jpg")        // index 2 (last), no thumbnail → filePath
    expect(next).toBe("/media/b_thumb.jpg")  // index 1 thumbnail
  })

  it("wraps around for last photo", () => {
    const [prev, next] = preloadUrls(2, photos)
    expect(prev).toBe("/media/b_thumb.jpg")  // index 1 thumbnail
    expect(next).toBe("/media/a_thumb.jpg")  // index 0 thumbnail
  })

  it("returns empty array for single photo (nothing to preload)", () => {
    const single = [{ filePath: "/media/x.jpg", thumbnailPath: "/media/x_thumb.jpg" }]
    expect(preloadUrls(0, single)).toEqual([])
  })

  it("dedupes a 2-photo gallery — prev and next are the same photo", () => {
    // Duplicate URLs became duplicate React keys in the hidden preload list.
    const two = [
      { filePath: "/media/a.jpg", thumbnailPath: "/media/a_thumb.jpg" },
      { filePath: "/media/b.jpg", thumbnailPath: "/media/b_thumb.jpg" },
    ]
    expect(preloadUrls(0, two)).toEqual(["/media/b_thumb.jpg"])
    expect(preloadUrls(1, two)).toEqual(["/media/a_thumb.jpg"])
  })
})

describe("lightboxPhoto (die Medienliste kann schrumpfen, während die Lightbox offen ist)", () => {
  // Seit die Einzelansicht die Liste filtert statt den ganzen Block zu
  // verstecken, überlebt die Galerie den Wechsel online → offline. Der offene
  // Index zeigt dann u.U. hinter das Ende — vorher hat der Block-Gate die
  // Galerie ausgehängt und den Index mit entsorgt.
  const photos = [{ id: "a" }, { id: "b" }, { id: "c" }]

  it("liefert null, wenn die Lightbox zu ist", () => {
    expect(lightboxPhoto(photos, null)).toBeNull()
  })

  it("liefert das Foto am Index", () => {
    expect(lightboxPhoto(photos, 1)).toEqual({ id: "b" })
  })

  it("liefert null, wenn der Index hinter das Ende zeigt — statt undefined zurückzugeben", () => {
    // Netz weg oder Entpinnen: aus drei Fotos wird eines, Index 2 existiert nicht mehr.
    expect(lightboxPhoto([{ id: "a" }], 2)).toBeNull()
    expect(lightboxPhoto([], 0)).toBeNull()
  })
})
