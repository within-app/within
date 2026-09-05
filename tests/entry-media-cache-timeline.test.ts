/**
 * Offline-Timeline liest den Medien-Cache.
 *
 * Vorher: idb-to-timeline setzt photoCount 0 / keine Flags, nur die
 * Detailansicht las den entryMedia-Cache — Karte „1 Foto" (nur das wartende),
 * Detail „4 Fotos". Jetzt liefert applyCachedMediaToGroups die Basiszählung
 * aus demselben Cache; Pending-Zählungen addiert applyPendingMediaToGroups
 * getrennt obendrauf (gleiche Schichtung wie im Detail).
 *
 * In-Memory-MetaStore-Stub, synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import {
  applyCachedMediaToGroups,
  timelineInfoFromCachedMedia,
  cacheEntryMedia,
  type MetaStore,
} from "../src/lib/sync/entry-media-cache"
import type { DateGroup, Media, TimelineEntry } from "../src/types/journal"

const UPDATED_AT = "2026-07-27T10:00:00.000Z"

function makeStore(): MetaStore {
  const meta = new Map<string, string>()
  return {
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => { meta.set(k, v) },
    deleteMeta: async (k) => { meta.delete(k) },
  }
}

function makeMedia(over: Partial<Media> = {}): Media {
  return {
    id: "m-1",
    entryId: "entry-1",
    type: "photo",
    filePath: "/media/synth/a.jpg",
    thumbnailPath: "/media/synth/a-thumb.webp",
    order: 0,
    ...over,
  }
}

function makeEntry(id: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id,
    journalId: "journal-1",
    journalColor: "",
    createdAt: "2026-07-27T10:00:00.000Z",
    title: "Titel",
    previewText: "",
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
    ...over,
  }
}

function makeGroups(...entries: TimelineEntry[]): DateGroup[] {
  return [{ date: "2026-07-27", formattedDate: "2026-07-27", entries }]
}

describe("timelineInfoFromCachedMedia", () => {
  it("zählt Fotos und leitet Flags und Thumbnail ab", () => {
    const info = timelineInfoFromCachedMedia([
      makeMedia(),
      makeMedia({ id: "m-2", filePath: "/media/synth/b.jpg", thumbnailPath: undefined }),
      makeMedia({ id: "m-3", type: "audio", filePath: "/media/synth/a.mp3" }),
    ])
    expect(info).toEqual({
      photoCount: 2,
      hasAudio: true,
      hasVideo: false,
      thumbnail: "/media/synth/a-thumb.webp",
    })
  })

  it("fällt ohne Thumbnail auf den Foto-Pfad zurück", () => {
    const info = timelineInfoFromCachedMedia([makeMedia({ thumbnailPath: undefined })])
    expect(info.thumbnail).toBe("/media/synth/a.jpg")
  })

  it("liefert kein Thumbnail für reine Audio-/Video-Einträge", () => {
    const info = timelineInfoFromCachedMedia([makeMedia({ type: "video" })])
    expect(info.thumbnail).toBeUndefined()
    expect(info.hasVideo).toBe(true)
  })
})

describe("applyCachedMediaToGroups", () => {
  it("übernimmt die gecachte Server-Zählung in die Karte", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [
      makeMedia(),
      makeMedia({ id: "m-2", filePath: "/media/synth/b.jpg" }),
      makeMedia({ id: "m-3", type: "audio", filePath: "/media/synth/a.mp3" }),
    ], UPDATED_AT)

    const result = await applyCachedMediaToGroups(store, makeGroups(makeEntry("entry-1")))

    expect(result[0].entries[0]).toMatchObject({
      photoCount: 2,
      hasAudio: true,
      hasVideo: false,
      thumbnail: "/media/synth/a-thumb.webp",
    })
  })

  it("lässt Einträge ohne Cache unangetastet (akzeptierte Grenze: nie online besucht)", async () => {
    const store = makeStore()
    const groups = makeGroups(makeEntry("entry-unbesucht"))

    const result = await applyCachedMediaToGroups(store, groups)

    expect(result[0].entries[0]).toMatchObject({ photoCount: 0, hasAudio: false, hasVideo: false })
    expect(result[0].entries[0].thumbnail).toBeUndefined()
  })

  it("überschreibt ein vorhandenes Karten-Thumbnail nicht", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makeMedia()], UPDATED_AT)
    const groups = makeGroups(makeEntry("entry-1", { thumbnail: "/media/synth/existing.webp" }))

    const result = await applyCachedMediaToGroups(store, groups)

    expect(result[0].entries[0].thumbnail).toBe("/media/synth/existing.webp")
  })

  it("mutiert die Eingabe nicht", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makeMedia()], UPDATED_AT)
    const groups = makeGroups(makeEntry("entry-1"))

    await applyCachedMediaToGroups(store, groups)

    expect(groups[0].entries[0].photoCount).toBe(0)
  })
})
