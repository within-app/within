/**
 * Wartende Fotos in der Medien-Übersicht.
 *
 * Die Übersicht las den Wartekorb bisher nie: ein offline angehängtes Foto war
 * in der Einzelansicht sichtbar, im Medien-Tab aber erst nach dem
 * Sync. Getestet wird die reine Entscheidungslogik — eine Kachel PRO wartendem
 * Foto, dieselben zwei Dubletten-Wächter wie `mergePendingMedia`, und die
 * URL-Cache-Pflege (Reuse je Outbox-Id, Revoke verwaister Ids).
 *
 * Läuft in vitest/node: keine IDB, kein DOM, keine echten Object-URLs.
 * Synthetische Daten.
 */

import { describe, it, expect, vi } from "vitest"
import {
  toPendingMediaItem,
  unmergedPending,
  withPendingTiles,
  isPendingMediaId,
} from "../src/lib/sync/pending-media"
import { syncPendingMediaTiles } from "../src/lib/sync/pending-preview-cache"
import { MAX_UPLOAD_ATTEMPTS, type OutboxMedia } from "../src/lib/sync/media-outbox"
import type { MediaItem } from "../src/types/journal"

function makeItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
  return {
    id: "outbox-1",
    entryId: "entry-1",
    blob: new Blob(["x"], { type: "image/jpeg" }),
    fileName: "synthetic.jpg",
    mimeType: "image/jpeg",
    type: "photo",
    size: 1,
    queuedAt: "2026-09-04T10:00:00.000Z",
    attempts: 0,
    ...over,
  }
}

function serverItem(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "srv-1",
    entryId: "entry-1",
    type: "photo",
    filePath: "/media/j/srv-1.jpg",
    createdAt: "2026-09-01T08:00:00.000Z",
    journalColor: "#007AFF",
    ...over,
  }
}

function makeOps(createResult = "blob:new") {
  return { create: vi.fn(async () => createResult), revoke: vi.fn() }
}

describe("toPendingMediaItem", () => {
  it("baut eine Kachel mit Warte-Kennzeichen, Präfix-Id und lokaler URL", () => {
    const tile = toPendingMediaItem(makeItem(), "blob:local-1")

    expect(isPendingMediaId(tile.id)).toBe(true)
    expect(tile.pending).toBe(true)
    expect(tile.filePath).toBe("blob:local-1")
    expect(tile.entryId).toBe("entry-1")
    // Der Link in beide Welten: die Outbox-Id ist die clientMediaId, unter der
    // der Upload landet — damit greift der Dubletten-Wächter nach dem Sync.
    expect(tile.clientMediaId).toBe("outbox-1")
    expect(tile.uploadStuck).toBeUndefined()
  })

  it("nimmt das Datum des Eintrags, wenn er lokal bekannt ist", () => {
    const tile = toPendingMediaItem(makeItem(), "blob:local-1", {
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    expect(tile.createdAt).toBe("2026-08-30T12:00:00.000Z")
  })

  it("fällt ohne bekannten Eintrag auf den Anhänge-Zeitpunkt zurück", () => {
    // Offline neu angelegter Eintrag, der noch in keiner IDB-Lesung auftaucht:
    // queuedAt ist das einzige Datum, das es gibt — besser als gar keine Kachel.
    expect(toPendingMediaItem(makeItem(), "blob:x").createdAt).toBe("2026-09-04T10:00:00.000Z")
  })

  it("markiert eine ausgereizte Datei als fehlgeschlagen statt als wartend", () => {
    // selectFlushable nimmt sie nie wieder mit — „Wartet" wäre gelogen.
    const tile = toPendingMediaItem(
      makeItem({ attempts: MAX_UPLOAD_ATTEMPTS, lastError: "415 unsupported" }),
      "blob:x"
    )
    expect(tile.uploadStuck).toBe(true)
    expect(tile.uploadError).toBe("415 unsupported")
  })
})

describe("unmergedPending — die zwei Dubletten-Wächter auf Übersichts-Kacheln", () => {
  it("lässt eine wartende Kachel durch, die der Server nicht kennt", () => {
    const pending = [toPendingMediaItem(makeItem(), "blob:x")]
    expect(unmergedPending([serverItem()], pending)).toEqual(pending)
  })

  it("verwirft eine wartende Kachel, deren Upload schon gelandet ist", () => {
    // Upload bestätigt, Outbox-Eintrag noch da (App gestorben,
    // deleteOutboxMedia geworfen). Ohne diesen Wächter zeigt die Übersicht das
    // Foto zweimal — genau die Dublette, die der Gerätetest ausschließt.
    const pending = [toPendingMediaItem(makeItem(), "blob:x")]
    const server = [serverItem({ clientMediaId: "outbox-1" })]
    expect(unmergedPending(server, pending)).toEqual([])
  })

  it("verwirft eine Kachel, deren Id die Liste schon enthält (Doppel-Merge)", () => {
    const pending = [toPendingMediaItem(makeItem(), "blob:x")]
    expect(unmergedPending(pending, pending)).toEqual([])
  })

  it("gibt bei leerem Wartekorb dieselbe Liste zurück (Identität)", () => {
    const server = [serverItem()]
    expect(unmergedPending(server, [])).toEqual([])
  })
})

describe("withPendingTiles — Platzierung im Raster", () => {
  it("sortiert wartende Kacheln nach Datum ein, statt sie pauschal voranzustellen", () => {
    // Die Kachel trägt das Datum ihres Eintrags. Ein offline an einen alten
    // Eintrag gehängtes Foto gehört deshalb an seinen Platz, nicht auf Position 1
    // eines absteigend sortierten Rasters.
    const server = [
      serverItem({ id: "s-heute", createdAt: "2026-09-04T08:00:00.000Z" }),
      serverItem({ id: "s-alt", createdAt: "2024-01-01T08:00:00.000Z" }),
    ]
    const pending = [
      toPendingMediaItem(makeItem({ id: "p1" }), "blob:p1", {
        createdAt: "2024-05-01T00:00:00.000Z",
      }),
    ]
    expect(withPendingTiles(server, pending).map((t) => t.id)).toEqual([
      "s-heute",
      "pending:p1",
      "s-alt",
    ])
  })

  it("stellt eine heute angehängte Kachel nach vorn", () => {
    const server = [serverItem({ id: "s1", createdAt: "2026-09-03T08:00:00.000Z" })]
    const pending = [
      toPendingMediaItem(makeItem({ id: "p1" }), "blob:p1", {
        createdAt: "2026-09-04T12:00:00.000Z",
      }),
    ]
    expect(withPendingTiles(server, pending).map((t) => t.id)).toEqual(["pending:p1", "s1"])
  })

  it("hält die Server-Reihenfolge bei gleichem Datum stabil (order_index)", () => {
    const server = [
      serverItem({ id: "s1", createdAt: "2026-09-04T08:00:00.000Z" }),
      serverItem({ id: "s2", createdAt: "2026-09-04T08:00:00.000Z" }),
      serverItem({ id: "s3", createdAt: "2026-09-04T08:00:00.000Z" }),
    ]
    expect(withPendingTiles(server, []).map((t) => t.id)).toEqual(["s1", "s2", "s3"])
  })

  it("gibt ohne wartende Kacheln dieselbe Liste zurück (Identität)", () => {
    const server = [serverItem()]
    expect(withPendingTiles(server, [])).toBe(server)
  })
})

describe("syncPendingMediaTiles", () => {
  it("erzeugt eine Kachel PRO wartendem Foto, nicht eine pro Eintrag", async () => {
    const items = [
      makeItem({ id: "a", entryId: "e1", queuedAt: "2026-09-04T10:00:00.000Z" }),
      makeItem({ id: "b", entryId: "e1", queuedAt: "2026-09-04T10:00:01.000Z" }),
      makeItem({ id: "c", entryId: "e2", queuedAt: "2026-09-04T10:00:02.000Z" }),
    ]
    const ops = { create: vi.fn(async (i: OutboxMedia) => `blob:${i.id}`), revoke: vi.fn() }

    const tiles = await syncPendingMediaTiles(items, new Map(), ops, new Map())

    expect(tiles).toHaveLength(3)
    // Die Anhänge-Reihenfolge bestimmt die Dekodier-Reihenfolge, die
    // Ausgabe steht danach neueste zuerst wie das übrige Raster.
    expect(tiles.map((t) => t.filePath)).toEqual(["blob:c", "blob:b", "blob:a"])
  })

  it("lässt Video und Audio draußen — die Übersicht zeigt wartende Fotos", async () => {
    const items = [makeItem({ id: "v", type: "video" }), makeItem({ id: "p", type: "photo" })]
    const ops = makeOps()
    const tiles = await syncPendingMediaTiles(items, new Map(), ops, new Map())
    expect(tiles.map((t) => t.entryId)).toEqual(["entry-1"])
    expect(ops.create).toHaveBeenCalledTimes(1)
  })

  it("nutzt eine bereits vergebene URL wieder, statt sie neu zu erzeugen", async () => {
    const cache = new Map([["outbox-1", "blob:alt"]])
    const ops = makeOps()
    const tiles = await syncPendingMediaTiles([makeItem()], cache, ops, new Map())
    expect(ops.create).not.toHaveBeenCalled()
    expect(tiles[0].filePath).toBe("blob:alt")
  })

  it("gibt URLs frei, deren Datei den Wartekorb verlassen hat", async () => {
    const cache = new Map([["weg", "blob:weg"]])
    const ops = makeOps()
    await syncPendingMediaTiles([makeItem()], cache, ops, new Map())
    expect(ops.revoke).toHaveBeenCalledWith("blob:weg")
    expect(cache.has("weg")).toBe(false)
  })

  it("erzeugt keine Kachel und keinen Cache-Eintrag, wenn die URL scheitert", async () => {
    // Eine leere src wäre ein kaputtes Bild — schlechter als keine Kachel.
    const cache = new Map<string, string>()
    const tiles = await syncPendingMediaTiles([makeItem()], cache, makeOps(""), new Map())
    expect(tiles).toEqual([])
    expect(cache.size).toBe(0)
  })

  it("filtert nach Journal, wenn der Eintrag lokal bekannt ist", async () => {
    const items = [
      makeItem({ id: "a", entryId: "e1" }),
      makeItem({ id: "b", entryId: "e2" }),
    ]
    const meta = new Map([
      ["e1", { journalId: "j1", createdAt: "2026-09-01T00:00:00.000Z" }],
      ["e2", { journalId: "j2", createdAt: "2026-09-01T00:00:00.000Z" }],
    ])
    const tiles = await syncPendingMediaTiles(items, new Map(), makeOps(), meta, "j1")
    expect(tiles.map((t) => t.entryId)).toEqual(["e1"])
  })

  it("zeigt eine Kachel, deren Journal unbekannt ist (unbekannt ≠ fremd)", async () => {
    // Gleiche Konvention wie updatedAt null im Medien-Cache: was das Gerät nicht
    // weiß, wird nicht weggefiltert — sonst verschwindet ein offline neu
    // angelegter Eintrag aus der Übersicht, obwohl die Datei hier liegt.
    const tiles = await syncPendingMediaTiles([makeItem()], new Map(), makeOps(), new Map(), "j1")
    expect(tiles).toHaveLength(1)
  })

  it("sortiert die Kacheln neueste zuerst, wie das übrige Raster", async () => {
    // Das Raster ist durchgehend absteigend (ORDER BY e.created_at DESC). Eine
    // wartende Kachel trägt jetzt das Datum ihres Eintrags — in Anhänge-
    // reihenfolge vorangestellt stünde ein Foto von 2024 vor einem von heute.
    const items = [
      makeItem({ id: "alt", entryId: "e-alt", queuedAt: "2026-09-04T10:00:00.000Z" }),
      makeItem({ id: "neu", entryId: "e-neu", queuedAt: "2026-09-04T10:00:01.000Z" }),
    ]
    const meta = new Map([
      ["e-alt", { createdAt: "2024-05-01T00:00:00.000Z" }],
      ["e-neu", { createdAt: "2026-09-04T09:00:00.000Z" }],
    ])
    const ops = { create: vi.fn(async (i: OutboxMedia) => `blob:${i.id}`), revoke: vi.fn() }
    const tiles = await syncPendingMediaTiles(items, new Map(), ops, meta)
    expect(tiles.map((t) => t.entryId)).toEqual(["e-neu", "e-alt"])
  })

  it("behält die URL einer Datei, die nur der Journal-Filter ausblendet", async () => {
    // Rule 2 gilt für Dateien, die den Wartekorb VERLASSEN haben. Eine
    // weggefilterte liegt weiter da — ihre URL zu revoken hieße, beim nächsten
    // Filterwechsel das Vollbild erneut zu dekodieren.
    const cache = new Map([["b", "blob:b"]])
    const ops = makeOps()
    const meta = new Map([
      ["e1", { journalId: "j1" }],
      ["e2", { journalId: "j2" }],
    ])
    const tiles = await syncPendingMediaTiles(
      [makeItem({ id: "b", entryId: "e2" })],
      cache,
      ops,
      meta,
      "j1"
    )
    expect(tiles).toEqual([])
    expect(ops.revoke).not.toHaveBeenCalled()
    expect(cache.get("b")).toBe("blob:b")
  })

  it("behält die URL eines wartenden Videos, obwohl es keine Kachel bekommt", async () => {
    const cache = new Map([["v", "blob:v"]])
    const ops = makeOps()
    await syncPendingMediaTiles([makeItem({ id: "v", type: "video" })], cache, ops, new Map())
    expect(ops.revoke).not.toHaveBeenCalled()
    expect(cache.get("v")).toBe("blob:v")
  })

  it("liefert bei leerem Wartekorb eine leere Liste und rührt den Cache nicht an", async () => {
    const cache = new Map<string, string>()
    const ops = makeOps()
    expect(await syncPendingMediaTiles([], cache, ops, new Map())).toEqual([])
    expect(ops.create).not.toHaveBeenCalled()
    expect(ops.revoke).not.toHaveBeenCalled()
  })
})
