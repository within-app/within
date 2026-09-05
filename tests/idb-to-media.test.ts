/**
 * Offline-Medien-Grid (Option „Gepinnte + Thumbnails"): Offline zeigt das
 * Grid pro Eintrag das Timeline-Thumbnail
 * aus der IDB (data:-URL, liegt bereits lokal — null zusätzlicher Speicher)
 * und für gepinnte Einträge mit bekannter Medien-Liste die echten
 * Foto-Kacheln (Bytes kommen offline aus dem verschlüsselten Pin-Cache).
 * Video/Audio bleiben offline draußen — es gibt lokal keine abspielbaren
 * Bytes (Pins pinnen nur Fotos).
 *
 * Synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { idbToMediaItems } from "@/lib/sync/idb-to-media"
import type { SyncEntry } from "@/lib/sync/types"
import type { Media } from "@/types/journal"

function makeEntry(overrides: Partial<SyncEntry> & { id: string }): SyncEntry {
  return {
    id: overrides.id,
    journalId: overrides.journalId ?? "journal-1",
    text: overrides.text ?? "Synthetic test entry",
    createdAt: overrides.createdAt ?? "2026-08-20T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-20T10:00:00.000Z",
    revisionId: overrides.revisionId ?? "rev-" + overrides.id,
    starred: overrides.starred ?? false,
    tags: overrides.tags ?? [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    deletedAt: overrides.deletedAt ?? null,
    thumbnailDataUrl: overrides.thumbnailDataUrl ?? null,
  }
}

function makePhoto(id: string, entryId: string): Media {
  return {
    id,
    entryId,
    type: "photo",
    filePath: `/media/${id}/${id}.jpg`,
    thumbnailPath: `/media/${id}/${id}-thumb.webp`,
    order: 0,
  }
}

const THUMB = "data:image/webp;base64,c3ludGg="

describe("idbToMediaItems", () => {
  it("eine Foto-Kachel pro Eintrag aus dem Timeline-Thumbnail; Einträge ohne Thumbnail bleiben draußen", () => {
    const items = idbToMediaItems(
      [
        makeEntry({ id: "a", thumbnailDataUrl: THUMB }),
        makeEntry({ id: "textonly" }),
      ],
      new Map()
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      entryId: "a",
      type: "photo",
      filePath: THUMB,
      thumbnailPath: THUMB,
    })
  })

  it("Tombstones und fremde Journals bleiben draußen", () => {
    const items = idbToMediaItems(
      [
        makeEntry({ id: "dead", thumbnailDataUrl: THUMB, deletedAt: "2026-08-21T00:00:00.000Z" }),
        makeEntry({ id: "other", thumbnailDataUrl: THUMB, journalId: "journal-2" }),
        makeEntry({ id: "keep", thumbnailDataUrl: THUMB }),
      ],
      new Map(),
      "journal-1"
    )
    expect(items.map((i) => i.entryId)).toEqual(["keep"])
  })

  it("gepinnter Eintrag mit bekannter Medien-Liste: echte Foto-Kacheln statt der Thumbnail-Kachel (keine Dublette)", () => {
    const pinned = makeEntry({ id: "pinned", thumbnailDataUrl: THUMB })
    const items = idbToMediaItems(
      [pinned],
      new Map([["pinned", [makePhoto("p1", "pinned"), makePhoto("p2", "pinned")]]])
    )
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.filePath)).toEqual(["/media/p1/p1.jpg", "/media/p2/p2.jpg"])
  })

  it("gepinnter Eintrag mit UNBEKANNTER Liste fällt auf die Thumbnail-Kachel zurück", () => {
    const items = idbToMediaItems([makeEntry({ id: "pinned", thumbnailDataUrl: THUMB })], new Map())
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toBe(THUMB)
  })

  it("Video/Audio-Zeilen gepinnter Einträge bleiben draußen — offline gibt es keine abspielbaren Bytes", () => {
    const media: Media[] = [
      makePhoto("p1", "e"),
      { ...makePhoto("v1", "e"), type: "video" },
      { ...makePhoto("a1", "e"), type: "audio" },
    ]
    const items = idbToMediaItems([makeEntry({ id: "e", thumbnailDataUrl: THUMB })], new Map([["e", media]]))
    expect(items.map((i) => i.type)).toEqual(["photo"])
  })

  it("sortiert neueste zuerst", () => {
    const items = idbToMediaItems(
      [
        makeEntry({ id: "old", thumbnailDataUrl: THUMB, createdAt: "2026-08-01T10:00:00.000Z" }),
        makeEntry({ id: "new", thumbnailDataUrl: THUMB, createdAt: "2026-08-22T10:00:00.000Z" }),
      ],
      new Map()
    )
    expect(items.map((i) => i.entryId)).toEqual(["new", "old"])
  })
})

// ── Zeitraum-Spiegel aktiv ────────────────────────────────────────────────────
// Der Zeitraum REGELT die Menge: Fotos im Zeitraum als echte Kacheln (Bytes
// liefert der SW aus dem verschlüsselten Spiegel-Cache), außerhalb KEINE
// Kachel — außer der Eintrag ist gepinnt (Pins zeigen weiter alles).

function mirrorItem(mediaId: string, entryId: string, createdAt: string) {
  return {
    mediaId,
    entryId,
    thumbUrl: `/media/${mediaId}/${mediaId}-thumb.webp`,
    createdAt,
  }
}

const SINCE = "2026-06-01T00:00:00.000Z"

describe("idbToMediaItems mit aktivem Zeitraum-Spiegel", () => {
  it("Fotos im Zeitraum rendern als echte Kacheln (eine pro Foto, Thumb-URL)", () => {
    const entry = makeEntry({ id: "e1", thumbnailDataUrl: THUMB, createdAt: "2026-08-20T10:00:00.000Z" })
    const items = idbToMediaItems([entry], new Map(), null, {
      since: SINCE,
      items: [
        mirrorItem("m1", "e1", "2026-08-20T10:00:00.000Z"),
        mirrorItem("m2", "e1", "2026-08-20T10:00:00.000Z"),
      ],
    })
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.thumbnailPath)).toEqual([
      "/media/m1/m1-thumb.webp",
      "/media/m2/m2-thumb.webp",
    ])
    // Keine zusätzliche Timeline-Thumbnail-Kachel für denselben Eintrag
    expect(items.some((i) => i.filePath === THUMB)).toBe(false)
  })

  it("ungepinnter Eintrag AUSSERHALB des Zeitraums bekommt KEINE Kachel", () => {
    const outside = makeEntry({ id: "old", thumbnailDataUrl: THUMB, createdAt: "2026-01-05T10:00:00.000Z" })
    const items = idbToMediaItems([outside], new Map(), null, { since: SINCE, items: [] })
    expect(items).toHaveLength(0)
  })

  it("gepinnter Eintrag außerhalb des Zeitraums zeigt weiter alles (unverändert)", () => {
    const outside = makeEntry({ id: "pinned-old", thumbnailDataUrl: THUMB, createdAt: "2026-01-05T10:00:00.000Z" })
    const items = idbToMediaItems(
      [outside],
      new Map([["pinned-old", [makePhoto("p1", "pinned-old")]]]),
      null,
      { since: SINCE, items: [] }
    )
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toBe("/media/p1/p1.jpg")
  })

  it("gepinnter Eintrag mit UNBEKANNTER Liste außerhalb des Zeitraums fällt auf die Thumbnail-Kachel zurück", () => {
    const outside = makeEntry({ id: "pinned-old", thumbnailDataUrl: THUMB, createdAt: "2026-01-05T10:00:00.000Z" })
    const items = idbToMediaItems([outside], new Map(), null, {
      since: SINCE,
      items: [],
      pinnedEntryIds: new Set(["pinned-old"]),
    })
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toBe(THUMB)
  })

  it("Pin-Kacheln gewinnen gegen Spiegel-Kacheln desselben Eintrags (keine Dublette)", () => {
    const entry = makeEntry({ id: "e1", createdAt: "2026-08-20T10:00:00.000Z" })
    const items = idbToMediaItems(
      [entry],
      new Map([["e1", [makePhoto("m1", "e1")]]]),
      null,
      { since: SINCE, items: [mirrorItem("m1", "e1", "2026-08-20T10:00:00.000Z")] }
    )
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toBe("/media/m1/m1.jpg")
  })

  it("Eintrag im Zeitraum OHNE Spiegel-Fotos (z.B. offline erstellt) fällt auf die Thumbnail-Kachel zurück", () => {
    const fresh = makeEntry({ id: "fresh", thumbnailDataUrl: THUMB, createdAt: "2026-08-23T10:00:00.000Z" })
    const items = idbToMediaItems([fresh], new Map(), null, { since: SINCE, items: [] })
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toBe(THUMB)
  })

  it("since null ('Alles'): alle Spiegel-Fotos rendern, Fallback-Kachel für Einträge ohne Spiegel-Fotos", () => {
    const withMirror = makeEntry({ id: "e1", createdAt: "2026-01-05T10:00:00.000Z" })
    const withoutMirror = makeEntry({ id: "e2", thumbnailDataUrl: THUMB, createdAt: "2025-05-05T10:00:00.000Z" })
    const items = idbToMediaItems([withMirror, withoutMirror], new Map(), null, {
      since: null,
      items: [mirrorItem("m1", "e1", "2026-01-05T10:00:00.000Z")],
    })
    expect(items).toHaveLength(2)
  })

  it("Spiegel-Kacheln respektieren Journal-Filter und Tombstones über den IDB-Eintrag", () => {
    const foreign = makeEntry({ id: "e1", journalId: "journal-2", createdAt: "2026-08-20T10:00:00.000Z" })
    const dead = makeEntry({ id: "e2", createdAt: "2026-08-20T10:00:00.000Z", deletedAt: "2026-08-21T00:00:00.000Z" })
    const items = idbToMediaItems([foreign, dead], new Map(), "journal-1", {
      since: SINCE,
      items: [
        mirrorItem("m1", "e1", "2026-08-20T10:00:00.000Z"),
        mirrorItem("m2", "e2", "2026-08-20T10:00:00.000Z"),
        // Waise: Eintrag liegt nicht (mehr) in der IDB — keine Kachel
        mirrorItem("m3", "e-unknown", "2026-08-20T10:00:00.000Z"),
      ],
    })
    expect(items).toHaveLength(0)
  })

  it("reicht clientMediaId aus dem Pin-Cache durch", () => {
    // Offline ist der Pin-Cache die einzige Quelle, die den Schlüssel kennt —
    // ohne ihn kann unmergedPending eine wartende Kachel nicht gegen ihre
    // schon hochgeladene Server-Zeile abgleichen, und das Foto steht doppelt
    // im Raster (eines davon fälschlich mit „Wartet").
    const entry = makeEntry({ id: "e1", thumbnailDataUrl: THUMB })
    const cached: Media[] = [{ ...makePhoto("m1", "e1"), clientMediaId: "outbox-42" }]
    const items = idbToMediaItems([entry], new Map([["e1", cached]]))
    expect(items).toHaveLength(1)
    expect(items[0].clientMediaId).toBe("outbox-42")
  })
})
