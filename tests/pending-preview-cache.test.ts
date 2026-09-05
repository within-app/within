/**
 * Cache-Pflege der Timeline-Preview-URLs
 * (pending-preview-cache.ts, pure mit injizierten Callbacks).
 *
 * Der Vertrag, den keine Testebene bisher erzwang: URL-Reuse je Outbox-Id
 * (Virtualisierer-Remount darf keine tote URL bekommen), Revoke verwaister Ids,
 * kein Cache-Eintrag für fehlgeschlagene Erzeugung. Eine Regression „URL pro
 * Ladelauf neu erzeugen und alte sofort revoken" ließ vorher alle Tests grün.
 *
 * Synthetische Daten, keine Browser-APIs.
 */

import { describe, it, expect, vi } from "vitest"
import { syncPendingTimelineMedia } from "../src/lib/sync/pending-preview-cache"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"

function makeItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
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

function makeOps(createResult = "blob:new") {
  return {
    create: vi.fn(async () => createResult),
    revoke: vi.fn(),
  }
}

describe("syncPendingTimelineMedia", () => {
  it("erzeugt eine URL pro Entry (erstes Foto) und liefert die Flags", async () => {
    const cache = new Map<string, string>()
    const ops = makeOps()
    const result = await syncPendingTimelineMedia(
      [makeItem(), makeItem({ id: "outbox-2", type: "audio" })],
      cache,
      ops
    )
    expect(result.get("entry-1")).toEqual({
      photoCount: 1,
      hasAudio: true,
      hasVideo: false,
      thumbnail: "blob:new",
    })
    expect(cache.get("outbox-1")).toBe("blob:new")
  })

  it("verwendet die gecachte URL wieder, statt eine neue zu erzeugen (Remount-Vertrag)", async () => {
    const cache = new Map([["outbox-1", "blob:cached"]])
    const ops = makeOps()
    const result = await syncPendingTimelineMedia([makeItem()], cache, ops)
    expect(ops.create).not.toHaveBeenCalled()
    expect(ops.revoke).not.toHaveBeenCalled()
    expect(result.get("entry-1")?.thumbnail).toBe("blob:cached")
    expect(cache.get("outbox-1")).toBe("blob:cached")
  })

  it("revoked und entfernt URLs von Ids, die die Outbox verlassen haben", async () => {
    const cache = new Map([
      ["outbox-1", "blob:live"],
      ["outbox-uploaded", "blob:stale"],
    ])
    const ops = makeOps()
    await syncPendingTimelineMedia([makeItem()], cache, ops)
    expect(ops.revoke).toHaveBeenCalledExactlyOnceWith("blob:stale")
    expect(cache.has("outbox-uploaded")).toBe(false)
    expect(cache.get("outbox-1")).toBe("blob:live")
  })

  it("cached KEINEN leeren Eintrag, wenn die URL-Erzeugung scheitert", async () => {
    const cache = new Map<string, string>()
    const result = await syncPendingTimelineMedia([makeItem()], cache, makeOps(""))
    expect(cache.has("outbox-1")).toBe(false)
    expect(result.get("entry-1")?.thumbnail).toBeUndefined()
    // Flags bleiben korrekt — das Foto zählt auch ohne Vorschau.
    expect(result.get("entry-1")?.photoCount).toBe(1)
  })

  it("leert einen komplett abgearbeiteten Wartekorb aus dem Cache", async () => {
    const cache = new Map([["outbox-1", "blob:done"]])
    const ops = makeOps()
    const result = await syncPendingTimelineMedia([], cache, ops)
    expect(result.size).toBe(0)
    expect(cache.size).toBe(0)
    expect(ops.revoke).toHaveBeenCalledExactlyOnceWith("blob:done")
  })

  it("nimmt das zuerst angehängte Foto als Karten-Vorschau", async () => {
    const cache = new Map<string, string>()
    const ops = {
      create: vi.fn(async (item: OutboxMedia) => `blob:${item.id}`),
      revoke: vi.fn(),
    }
    const result = await syncPendingTimelineMedia(
      [
        makeItem({ id: "zzz-later", queuedAt: "2026-07-27T10:00:02.000Z" }),
        makeItem({ id: "aaa-first", queuedAt: "2026-07-27T10:00:01.000Z" }),
      ],
      cache,
      ops
    )
    expect(result.get("entry-1")?.thumbnail).toBe("blob:aaa-first")
  })
})
