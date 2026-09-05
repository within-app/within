/**
 * Pure row builder for pending media.
 *
 * Pending photos must carry a downscaled preview as `thumbnailPath` so
 * the 220px/84px tiles never decode the full-res blob; the full-res object URL
 * stays reserved for the lightbox (`filePath`).
 *
 * Rows come out in attach order (`queuedAt`), not in the random-UUID
 * key order of the outbox store.
 *
 * Runs in vitest/node — browser capabilities are injected as fakes.
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi } from "vitest"
import {
  buildPendingMediaRows,
  makeDayPendingLoader,
  sortByQueuedAt,
  type PendingPreviewFactory,
} from "../src/lib/sync/pending-media-rows"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"

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

function makeFactory(over: Partial<PendingPreviewFactory> = {}): PendingPreviewFactory {
  let n = 0
  return {
    createUrl: () => `blob:full-${++n}`,
    createThumbUrl: async () => `blob:thumb-${n}`,
    ...over,
  }
}

describe("sortByQueuedAt", () => {
  it("orders by attach time, not by the random outbox id", () => {
    const items = [
      makeOutboxItem({ id: "aaa", queuedAt: "2026-07-27T10:00:02.000Z" }),
      makeOutboxItem({ id: "zzz", queuedAt: "2026-07-27T10:00:01.000Z" }),
    ]
    expect(sortByQueuedAt(items).map((i) => i.id)).toEqual(["zzz", "aaa"])
  })

  it("tie-breaks same-instant attachments by id for a stable order", () => {
    const items = [
      makeOutboxItem({ id: "bbb" }),
      makeOutboxItem({ id: "aaa" }),
    ]
    expect(sortByQueuedAt(items).map((i) => i.id)).toEqual(["aaa", "bbb"])
  })

  it("does not mutate the input", () => {
    const items = [
      makeOutboxItem({ id: "bbb" }),
      makeOutboxItem({ id: "aaa" }),
    ]
    sortByQueuedAt(items)
    expect(items.map((i) => i.id)).toEqual(["bbb", "aaa"])
  })
})

describe("buildPendingMediaRows", () => {
  it("gives a pending photo a downscaled thumbnailPath and keeps full-res only as filePath", async () => {
    const sink: string[] = []
    const rows = await buildPendingMediaRows([makeOutboxItem()], 0, sink, makeFactory())

    expect(rows).toHaveLength(1)
    expect(rows[0].filePath).toBe("blob:full-1")
    expect(rows[0].thumbnailPath).toBe("blob:thumb-1")
  })

  it("records BOTH created URLs in the sink — the caller revokes them", async () => {
    const sink: string[] = []
    await buildPendingMediaRows([makeOutboxItem()], 0, sink, makeFactory())
    expect(sink).toEqual(["blob:full-1", "blob:thumb-1"])
  })

  it("falls back to today's behavior when downscaling is unsupported (Safari)", async () => {
    const sink: string[] = []
    const rows = await buildPendingMediaRows(
      [makeOutboxItem()],
      0,
      sink,
      makeFactory({ createThumbUrl: async () => "" })
    )
    expect(rows[0].thumbnailPath).toBeUndefined()
    expect(rows[0].filePath).toBe("blob:full-1")
    expect(sink).toEqual(["blob:full-1"])
  })

  it("does not downscale audio or video — only photos hit the decode problem", async () => {
    const createThumbUrl = vi.fn(async () => "blob:thumb-x")
    const rows = await buildPendingMediaRows(
      [makeOutboxItem({ type: "audio" }), makeOutboxItem({ id: "outbox-2", type: "video" })],
      0,
      [],
      makeFactory({ createThumbUrl })
    )
    expect(createThumbUrl).not.toHaveBeenCalled()
    expect(rows.every((r) => r.thumbnailPath === undefined)).toBe(true)
  })

  it("skips the thumbnail when no preview URL could be created at all", async () => {
    const createThumbUrl = vi.fn(async () => "blob:thumb-x")
    const rows = await buildPendingMediaRows(
      [makeOutboxItem()],
      0,
      [],
      makeFactory({ createUrl: () => "", createThumbUrl })
    )
    expect(createThumbUrl).not.toHaveBeenCalled()
    expect(rows[0].filePath).toBe("")
  })

  it("emits rows in attach order with consecutive order values", async () => {
    const rows = await buildPendingMediaRows(
      [
        makeOutboxItem({ id: "zzz", queuedAt: "2026-07-27T10:00:01.000Z" }),
        makeOutboxItem({ id: "aaa", queuedAt: "2026-07-27T10:00:02.000Z" }),
      ],
      5,
      [],
      makeFactory()
    )
    expect(rows.map((r) => r.id)).toEqual(["pending:zzz", "pending:aaa"])
    expect(rows.map((r) => r.order)).toEqual([5, 6])
  })
})

/**
 * Der Lader der Tages-Vorschau.
 *
 * Sie fragt für JEDEN Eintrag des Tages nach wartenden Dateien. Naiv heißt das
 * eine Wartekorb-Lesung und ein Bild-Dekodierlauf PRO EINTRAG, alle gleichzeitig
 * (Promise.all über die Zeilen) — genau die Parallelität, gegen die sequentielles Dekodieren und ein
 * Cursor statt getAll gebaut wurden.
 * Auf dem Telefon sind vier gleichzeitige Vollbild-Dekodierungen der Tab-Tod.
 */
describe("makeDayPendingLoader (Tages-Vorschau)", () => {
  function outboxItem(id: string, entryId: string, queuedAt: string): OutboxMedia {
    return {
      id, entryId, blob: new Blob(["x"], { type: "image/jpeg" }),
      fileName: "synthetic.jpg", mimeType: "image/jpeg", type: "photo",
      size: 1, queuedAt, attempts: 0,
    }
  }

  it("liest den Wartekorb EINMAL, egal wie viele Einträge der Tag hat", async () => {
    const read = vi.fn(async () => [
      outboxItem("a", "e1", "2026-09-04T10:00:00.000Z"),
      outboxItem("b", "e2", "2026-09-04T10:00:01.000Z"),
    ])
    const load = makeDayPendingLoader(read, async (items, startOrder) =>
      items.map((i, n) => ({
        id: `pending:${i.id}`, entryId: i.entryId, type: "photo" as const,
        filePath: `blob:${i.id}`, order: startOrder + n, pending: true,
      }))
    )

    const rows = await Promise.all([load("e1", 0), load("e2", 3), load("e3", 0)])

    expect(read).toHaveBeenCalledTimes(1)
    expect(rows[0].map((r) => r.id)).toEqual(["pending:a"])
    expect(rows[1].map((r) => r.id)).toEqual(["pending:b"])
    expect(rows[1][0].order).toBe(3)
    expect(rows[2]).toEqual([])
  })

  it("dekodiert nacheinander, auch wenn alle Einträge gleichzeitig fragen", async () => {
    const read = vi.fn(async () => [
      outboxItem("a", "e1", "2026-09-04T10:00:00.000Z"),
      outboxItem("b", "e2", "2026-09-04T10:00:01.000Z"),
      outboxItem("c", "e3", "2026-09-04T10:00:02.000Z"),
    ])
    let live = 0
    let peak = 0
    const load = makeDayPendingLoader(read, async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      return []
    })

    await Promise.all([load("e1", 0), load("e2", 0), load("e3", 0)])

    expect(peak).toBe(1)
  })

  it("reicht einen Lesefehler als leere Liste durch, statt den Tag zu sprengen", async () => {
    const load = makeDayPendingLoader(
      async () => { throw new Error("IDB kaputt") },
      async () => [{ id: "x", entryId: "e1", type: "photo" as const, filePath: "blob:x", order: 0 }]
    )
    await expect(load("e1", 0)).resolves.toEqual([])
  })
})
