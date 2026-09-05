/**
 * All media below the entry text; no hero image above it.
 *
 * Replaces the prior hero-image tests (tests/entry-detail-ds09.test.ts): the
 * hero was a deliberate design decision and is now
 * deliberately reversed, so its helper and its test go away together.
 *
 * Tests the pure helper exported from entry-detail.tsx — vitest/node, no DOM
 * renderer. Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import * as entryDetail from "@/components/detail/entry-detail"
import { orderDetailMedia } from "@/components/detail/entry-detail"
import type { Media, MediaType } from "@/types/journal"

function makeMedia(id: string, type: MediaType, order: number): Media {
  return { id, entryId: "entry-1", type, filePath: `/api/media/${id}`, order }
}

describe("orderDetailMedia", () => {
  it("empty media → three empty buckets", () => {
    expect(orderDetailMedia([])).toEqual({ photos: [], videos: [], audio: [] })
  })

  it("keeps every photo in the gallery — the first one is not split off as a hero", () => {
    const photos = [
      makeMedia("a", "photo", 0),
      makeMedia("b", "photo", 1),
      makeMedia("c", "photo", 2),
    ]
    expect(orderDetailMedia(photos).photos.map((p) => p.id)).toEqual(["a", "b", "c"])
  })

  it("a single photo goes to the gallery, not above the text", () => {
    const result = orderDetailMedia([makeMedia("a", "photo", 0)])
    expect(result.photos).toHaveLength(1)
  })

  it("separates the three media types", () => {
    const media = [
      makeMedia("p1", "photo", 0),
      makeMedia("v1", "video", 1),
      makeMedia("a1", "audio", 2),
      makeMedia("p2", "photo", 3),
    ]
    const { photos, videos, audio } = orderDetailMedia(media)
    expect(photos.map((m) => m.id)).toEqual(["p1", "p2"])
    expect(videos.map((m) => m.id)).toEqual(["v1"])
    expect(audio.map((m) => m.id)).toEqual(["a1"])
  })

  it("preserves the incoming order within each type", () => {
    const media = [makeMedia("b", "photo", 1), makeMedia("a", "photo", 0)]
    expect(orderDetailMedia(media).photos.map((m) => m.id)).toEqual(["b", "a"])
  })

  it("keeps pending media in the gallery alongside uploaded ones", () => {
    const media: Media[] = [
      makeMedia("a", "photo", 0),
      { ...makeMedia("pending:x", "photo", 1), filePath: "blob:x", pending: true },
    ]
    const { photos } = orderDetailMedia(media)
    expect(photos.map((m) => m.id)).toEqual(["a", "pending:x"])
  })

  it("does not mutate the input array", () => {
    const media = [makeMedia("a", "photo", 0)]
    orderDetailMedia(media)
    expect(media).toHaveLength(1)
  })
})

describe("hero image removal", () => {
  it("entry-detail no longer exports splitPhotos — nothing is held back from the gallery", () => {
    expect("splitPhotos" in entryDetail).toBe(false)
  })
})
