/**
 * Pending media (offline outbox) surfaced in the entry views.
 *
 * Tests the pure decision logic in src/lib/sync/pending-media.ts.
 * Runs in vitest/node — no IDB, no DOM, no object URLs.
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import {
  PENDING_MEDIA_ID_PREFIX,
  pendingMediaId,
  isPendingMediaId,
  toPendingMedia,
  mergePendingMedia,
  pendingMediaFlags,
  groupPendingByEntry,
  applyPendingMediaToGroups,
  foldPendingIntoRows,
} from "../src/lib/sync/pending-media"
import { MAX_UPLOAD_ATTEMPTS, type OutboxMedia } from "../src/lib/sync/media-outbox"
import type { DateGroup, Media, MediaType, TimelineEntry } from "../src/types/journal"

function makeOutboxItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
  return {
    id: "outbox-1",
    entryId: "entry-1",
    blob: new Blob(["x"], { type: "image/jpeg" }),
    fileName: "synthetic.jpg",
    mimeType: "image/jpeg",
    type: "photo",
    size: 1,
    queuedAt: "2026-07-27T10:00:00.000Z",
    attempts: 0,
    ...over,
  }
}

function makeServerMedia(id: string, order = 0, type: MediaType = "photo"): Media {
  return { id, entryId: "entry-1", type, filePath: `/api/media/${id}`, order }
}

function makeTimelineEntry(id: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id,
    journalId: "journal-1",
    journalColor: "",
    createdAt: "2026-07-27T10:00:00.000Z",
    title: "Titel",
    previewText: "Vorschau",
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
    ...over,
  }
}

describe("pending media ids", () => {
  it("prefixes the outbox id so it cannot collide with a DB id", () => {
    expect(pendingMediaId("abc")).toBe(`${PENDING_MEDIA_ID_PREFIX}abc`)
    expect(isPendingMediaId(pendingMediaId("abc"))).toBe(true)
  })

  it("does not classify a server media id as pending", () => {
    expect(isPendingMediaId("6f1c9e3a-0000-4000-8000-000000000000")).toBe(false)
  })
})

describe("toPendingMedia", () => {
  it("carries type, entry and preview URL, and is flagged pending", () => {
    const media = toPendingMedia(makeOutboxItem(), "blob:preview-1", 3)
    expect(media).toMatchObject({
      id: "pending:outbox-1",
      entryId: "entry-1",
      type: "photo",
      filePath: "blob:preview-1",
      order: 3,
      pending: true,
      // The raw outbox id doubles as the link to the server row that an
      // already-landed upload created (media.client_media_id).
      clientMediaId: "outbox-1",
    })
  })

  it("has no thumbnailPath — there is no server-side thumbnail yet", () => {
    expect(toPendingMedia(makeOutboxItem(), "blob:x", 0).thumbnailPath).toBeUndefined()
  })

  it("keeps video and audio types intact", () => {
    expect(toPendingMedia(makeOutboxItem({ type: "video" }), "blob:v", 0).type).toBe("video")
    expect(toPendingMedia(makeOutboxItem({ type: "audio" }), "blob:a", 0).type).toBe("audio")
  })

  it("flags an item that exhausted its retries as uploadStuck, with its cause", () => {
    // selectFlushable will never pick this item up again — a "waiting" badge
    // would promise an upload that never happens.
    const media = toPendingMedia(
      makeOutboxItem({ attempts: MAX_UPLOAD_ATTEMPTS, lastError: "Datei zu groß (synthetisch)" }),
      "blob:x",
      0
    )
    expect(media.uploadStuck).toBe(true)
    expect(media.uploadError).toBe("Datei zu groß (synthetisch)")
  })

  it("does not flag a normally waiting item as stuck", () => {
    const media = toPendingMedia(makeOutboxItem({ attempts: 1 }), "blob:x", 0)
    expect(media.uploadStuck).toBeUndefined()
    expect(media.uploadError).toBeUndefined()
  })
})

describe("mergePendingMedia", () => {
  it("returns the original array when nothing is pending", () => {
    const media = [makeServerMedia("a")]
    expect(mergePendingMedia(media, [])).toBe(media)
  })

  it("appends pending media after the server media — existing photos stay", () => {
    const server = [makeServerMedia("a", 0), makeServerMedia("b", 1)]
    const pending = [toPendingMedia(makeOutboxItem(), "blob:p", 2)]
    const merged = mergePendingMedia(server, pending)
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "pending:outbox-1"])
    expect(merged.filter((m) => m.pending)).toHaveLength(1)
  })

  it("shows pending media on an entry the server reports without any media", () => {
    const pending = [toPendingMedia(makeOutboxItem(), "blob:p", 0)]
    expect(mergePendingMedia([], pending).map((m) => m.id)).toEqual(["pending:outbox-1"])
  })

  it("does not duplicate a pending row that is already merged in", () => {
    const pending = toPendingMedia(makeOutboxItem(), "blob:p", 0)
    expect(mergePendingMedia([pending], [pending])).toHaveLength(1)
  })

  it("drops a pending row whose upload already landed — server row carries its outbox id", () => {
    // Crash window: upload confirmed, app died before deleteOutboxMedia — the
    // file exists as server row AND outbox record. Without the clientMediaId
    // guard the photo renders twice (one with a bogus "waiting" badge).
    const serverRow: Media = { ...makeServerMedia("a"), clientMediaId: "outbox-1" }
    const pending = [toPendingMedia(makeOutboxItem(), "blob:p", 1)]
    const merged = mergePendingMedia([serverRow], pending)
    expect(merged.map((m) => m.id)).toEqual(["a"])
  })

  it("keeps a pending row when server rows carry no clientMediaId (pre-idempotency uploads)", () => {
    const pending = [toPendingMedia(makeOutboxItem(), "blob:p", 1)]
    const merged = mergePendingMedia([makeServerMedia("a")], pending)
    expect(merged.map((m) => m.id)).toEqual(["a", "pending:outbox-1"])
  })

  it("only drops the pending row that actually matches", () => {
    const serverRow: Media = { ...makeServerMedia("a"), clientMediaId: "outbox-1" }
    const pending = [
      toPendingMedia(makeOutboxItem(), "blob:p", 1),
      toPendingMedia(makeOutboxItem({ id: "outbox-2" }), "blob:q", 2),
    ]
    const merged = mergePendingMedia([serverRow], pending)
    expect(merged.map((m) => m.id)).toEqual(["a", "pending:outbox-2"])
  })

  it("does not mutate the input array", () => {
    const server = [makeServerMedia("a")]
    mergePendingMedia(server, [toPendingMedia(makeOutboxItem(), "blob:p", 1)])
    expect(server).toHaveLength(1)
  })
})

describe("pendingMediaFlags", () => {
  it("counts photos and flags audio/video independently", () => {
    const items = [
      makeOutboxItem({ id: "1", type: "photo" }),
      makeOutboxItem({ id: "2", type: "photo" }),
      makeOutboxItem({ id: "3", type: "audio" }),
    ]
    expect(pendingMediaFlags(items)).toEqual({ photoCount: 2, hasAudio: true, hasVideo: false })
  })

  it("is all-zero for an empty outbox", () => {
    expect(pendingMediaFlags([])).toEqual({ photoCount: 0, hasAudio: false, hasVideo: false })
  })
})

describe("groupPendingByEntry", () => {
  it("buckets the outbox by entry id", () => {
    const grouped = groupPendingByEntry([
      makeOutboxItem({ id: "1", entryId: "entry-1" }),
      makeOutboxItem({ id: "2", entryId: "entry-2" }),
      makeOutboxItem({ id: "3", entryId: "entry-1" }),
    ])
    expect(grouped.get("entry-1")?.map((i) => i.id)).toEqual(["1", "3"])
    expect(grouped.get("entry-2")?.map((i) => i.id)).toEqual(["2"])
  })
})

describe("applyPendingMediaToGroups", () => {
  function groups(): DateGroup[] {
    return [
      {
        date: "2026-07-27",
        formattedDate: "2026-07-27",
        entries: [makeTimelineEntry("entry-1"), makeTimelineEntry("entry-2")],
      },
    ]
  }

  it("returns the input untouched when nothing is pending", () => {
    const input = groups()
    expect(applyPendingMediaToGroups(input, new Map())).toBe(input)
  })

  it("raises photoCount and sets a thumbnail for the entry with a pending photo", () => {
    const result = applyPendingMediaToGroups(
      groups(),
      new Map([["entry-1", { photoCount: 2, hasAudio: false, hasVideo: false, thumbnail: "blob:p" }]])
    )
    const [first, second] = result[0].entries
    expect(first).toMatchObject({ photoCount: 2, thumbnail: "blob:p" })
    expect(second.photoCount).toBe(0)
    expect(second.thumbnail).toBeUndefined()
  })

  it("adds to the server counts instead of replacing them", () => {
    const input = groups()
    input[0].entries[0] = makeTimelineEntry("entry-1", { photoCount: 3, thumbnail: "/api/media/a" })
    const result = applyPendingMediaToGroups(
      input,
      new Map([["entry-1", { photoCount: 1, hasAudio: false, hasVideo: false, thumbnail: "blob:p" }]])
    )
    expect(result[0].entries[0].photoCount).toBe(4)
  })

  it("keeps an existing server thumbnail — the uploaded photo stays the preview", () => {
    const input = groups()
    input[0].entries[0] = makeTimelineEntry("entry-1", { photoCount: 1, thumbnail: "/api/media/a" })
    const result = applyPendingMediaToGroups(
      input,
      new Map([["entry-1", { photoCount: 1, hasAudio: false, hasVideo: false, thumbnail: "blob:p" }]])
    )
    expect(result[0].entries[0].thumbnail).toBe("/api/media/a")
  })

  it("never clears audio/video flags the server already set", () => {
    const input = groups()
    input[0].entries[0] = makeTimelineEntry("entry-1", { hasAudio: true, hasVideo: true })
    const result = applyPendingMediaToGroups(
      input,
      new Map([["entry-1", { photoCount: 1, hasAudio: false, hasVideo: false }]])
    )
    expect(result[0].entries[0]).toMatchObject({ hasAudio: true, hasVideo: true })
  })

  it("does not mutate the input groups", () => {
    const input = groups()
    applyPendingMediaToGroups(
      input,
      new Map([["entry-1", { photoCount: 1, hasAudio: false, hasVideo: false, thumbnail: "blob:p" }]])
    )
    expect(input[0].entries[0].photoCount).toBe(0)
    expect(input[0].entries[0].thumbnail).toBeUndefined()
  })

  it("ignores pending media for entries not on screen — and keeps the input identity", () => {
    const input = groups()
    const result = applyPendingMediaToGroups(
      input,
      new Map([["entry-999", { photoCount: 1, hasAudio: false, hasVideo: false }]])
    )
    expect(result[0].entries.every((e) => e.photoCount === 0)).toBe(true)
    // Same reference, not just same value: a fresh array would make the
    // timeline re-render on every poll for no reason.
    expect(result).toBe(input)
  })
})

/**
 * Der Einschub für Lese-Ansichten.
 *
 * Tages-Vorschau und „An diesem Tag" bekommen beide eine Liste fertiger Zeilen
 * vom Server und müssen den Wartekorb pro Zeile einmischen. Die Regel steht
 * einmal hier statt zweimal in den Ansichten.
 */
describe("foldPendingIntoRows", () => {
  const row = (id: string, media: Media[] = []) => ({ id, media })
  const waiting = (id: string, order: number): Media => ({
    id: `pending:${id}`, entryId: "e", type: "photo", filePath: `blob:${id}`,
    order, pending: true, clientMediaId: id,
  })

  it("mischt pro Zeile ein und reiht hinter die vorhandenen Medien", async () => {
    const seen: Array<[string, number]> = []
    const rows = await foldPendingIntoRows(
      [
        row("a", [{ id: "m1", entryId: "a", type: "photo", filePath: "/media/a.jpg", order: 0 }]),
        row("b"),
      ],
      async (entryId, startOrder) => {
        seen.push([entryId, startOrder])
        return entryId === "a" ? [waiting("o1", startOrder)] : []
      }
    )
    expect(seen).toEqual([["a", 1], ["b", 0]])
    expect(rows[0].media.map((m) => m.id)).toEqual(["m1", "pending:o1"])
    expect(rows[1].media).toEqual([])
  })

  it("verwirft eine wartende Datei, deren Upload schon gelandet ist", async () => {
    const rows = await foldPendingIntoRows(
      [row("a", [{ id: "m1", entryId: "a", type: "photo", filePath: "/media/a.jpg", order: 0, clientMediaId: "o1" }])],
      async () => [waiting("o1", 1)]
    )
    expect(rows[0].media.map((m) => m.id)).toEqual(["m1"])
  })

  it("lässt eine Zeile unangetastet, wenn die Wartekorb-Lesung wirft", async () => {
    const rows = await foldPendingIntoRows([row("a")], async () => {
      throw new Error("IDB kaputt")
    })
    expect(rows[0].media).toEqual([])
  })

  it("gibt unveränderte Zeilen identisch zurück (kein Neuaufbau)", async () => {
    const input = [row("a")]
    const rows = await foldPendingIntoRows(input, async () => [])
    expect(rows[0]).toBe(input[0])
  })
})
