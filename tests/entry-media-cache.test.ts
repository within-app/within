/**
 * Cache of an entry's server-side media, so an offline attachment
 * does not make the already-uploaded photos disappear.
 *
 * The value is stamped with the entry's `updatedAt` (provenance); the
 * staleness invalidation itself lives in the sync pull (engine.ts) — a
 * read-time stamp check wrongly treated a local offline edit as staleness.
 * Values are validated hard before they become `img src`/pin fetch
 * targets. Quota failures surface as a window event.
 *
 * Round-trips through a plain in-memory meta store — no IDB, no DOM.
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  ENTRY_MEDIA_META_PREFIX,
  STORAGE_ERROR_EVENT,
  entryMediaMetaKey,
  serializeEntryMedia,
  parseEntryMedia,
  cacheEntryMedia,
  readCachedEntryMedia,
  readCachedEntryMediaBox,
  deleteCachedEntryMedia,
  isQuotaError,
  type MetaStore,
} from "../src/lib/sync/entry-media-cache"
import type { Media } from "../src/types/journal"

const UPDATED_AT = "2026-07-27T10:00:00.000Z"

function makeStore(): MetaStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getMeta: async (key) => data.get(key) ?? null,
    setMeta: async (key, value) => { data.set(key, value) },
    deleteMeta: async (key) => { data.delete(key) },
  }
}

function makePhoto(id: string, order = 0): Media {
  return {
    id,
    entryId: "entry-1",
    type: "photo",
    filePath: `/media/${id}/${id}.jpg`,
    thumbnailPath: `/media/${id}/${id}-thumb.webp`,
    order,
  }
}

describe("entryMediaMetaKey", () => {
  it("namespaces the entry id", () => {
    expect(entryMediaMetaKey("entry-1")).toBe(`${ENTRY_MEDIA_META_PREFIX}entry-1`)
  })
})

describe("serializeEntryMedia", () => {
  it("keeps server rows with their paths and stamps the entry revision", () => {
    const parsed = parseEntryMedia(serializeEntryMedia([makePhoto("a")], UPDATED_AT))
    expect(parsed.updatedAt).toBe(UPDATED_AT)
    expect(parsed.media).toHaveLength(1)
    expect(parsed.media[0]).toMatchObject({
      id: "a",
      filePath: "/media/a/a.jpg",
      thumbnailPath: "/media/a/a-thumb.webp",
    })
  })

  it("drops pending rows — a blob: URL dies with the page and must not be persisted", () => {
    const media: Media[] = [
      makePhoto("a"),
      { ...makePhoto("pending:x", 1), filePath: "blob:abc", thumbnailPath: undefined, pending: true },
    ]
    const raw = serializeEntryMedia(media, UPDATED_AT)
    expect(parseEntryMedia(raw).media.map((m) => m.id)).toEqual(["a"])
    expect(raw).not.toContain("blob:")
  })
})

describe("readCachedEntryMediaBox — unbekannt ≠ leer (Verbund-E2E-Fund 23.08.)", () => {
  // Der Cache droppt den Key beim nächsten Pull, sobald der Pin-eigene
  // updated_at-Bump ankommt — offline ist danach nicht unterscheidbar, ob der
  // Eintrag keine Medien HAT oder wir die Liste nur nicht KENNEN. Der Box-
  // Reader macht das Signal sichtbar: Miss ⇒ updatedAt null, Hit ⇒ Stempel
  // (auch bei leerer Liste). Dieselbe Lehre wie B14: Abwesenheit ist kein
  // Beweis.
  it("Miss ⇒ updatedAt null (Liste unbekannt)", async () => {
    const store = makeStore()
    const box = await readCachedEntryMediaBox(store, "entry-1")
    expect(box.updatedAt).toBeNull()
    expect(box.media).toEqual([])
  })

  it("Hit mit leerer Liste ⇒ updatedAt gestempelt (Liste bekannt leer)", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [], UPDATED_AT)
    const box = await readCachedEntryMediaBox(store, "entry-1")
    expect(box.updatedAt).toBe(UPDATED_AT)
    expect(box.media).toEqual([])
  })

  it("Hit mit Fotos ⇒ Liste + Stempel", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makePhoto("p1")], UPDATED_AT)
    const box = await readCachedEntryMediaBox(store, "entry-1")
    expect(box.updatedAt).toBe(UPDATED_AT)
    expect(box.media).toHaveLength(1)
  })
})

describe("parseEntryMedia", () => {
  const miss = { media: [], updatedAt: null }

  it("null → miss", () => {
    expect(parseEntryMedia(null)).toEqual(miss)
  })

  it("malformed JSON → miss, no throw", () => {
    expect(parseEntryMedia("{not json")).toEqual(miss)
  })

  it("a legacy v1 array → miss (kann nicht auf Staleness geprüft werden, heilt online)", () => {
    expect(parseEntryMedia(JSON.stringify([makePhoto("a")]))).toEqual(miss)
  })

  it("verlangt /media/-Pfade — ein fremder filePath macht den ganzen Wert zum Miss", () => {
    const raw = JSON.stringify({
      v: 2,
      updatedAt: UPDATED_AT,
      media: [makePhoto("good"), { ...makePhoto("evil"), filePath: "https://attacker.example/x.jpg" }],
    })
    expect(parseEntryMedia(raw)).toEqual(miss)
  })

  it("verlangt /media/-Präfix auch für thumbnailPath", () => {
    const raw = JSON.stringify({
      v: 2,
      updatedAt: UPDATED_AT,
      media: [{ ...makePhoto("a"), thumbnailPath: "//evil.example/t.webp" }],
    })
    expect(parseEntryMedia(raw)).toEqual(miss)
  })

  it("filtert persistierte pending-Reste (tote blob:-URLs einer fremden Version)", () => {
    const raw = JSON.stringify({
      v: 2,
      updatedAt: UPDATED_AT,
      media: [makePhoto("a"), { ...makePhoto("p"), filePath: "blob:dead", thumbnailPath: undefined, pending: true }],
    })
    expect(parseEntryMedia(raw).media.map((m) => m.id)).toEqual(["a"])
  })

  it("rows missing the fields the renderers rely on → miss", () => {
    const raw = JSON.stringify({
      v: 2,
      updatedAt: UPDATED_AT,
      media: [{ id: "no-path", entryId: "entry-1", type: "photo", order: 1 }],
    })
    expect(parseEntryMedia(raw)).toEqual(miss)
  })
})

describe("cacheEntryMedia / readCachedEntryMedia", () => {
  it("round-trips a media list", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makePhoto("a"), makePhoto("b", 1)], UPDATED_AT)
    expect((await readCachedEntryMedia(store, "entry-1")).map((m) => m.id)).toEqual(["a", "b"])
  })

  it("reads [] for an entry that was never cached", async () => {
    expect(await readCachedEntryMedia(makeStore(), "entry-unknown")).toEqual([])
  })

  it("Der Read prüft KEINEN Stempel — ein lokaler Offline-Edit darf die Fotos nicht verstecken", async () => {
    // Die Staleness-Invalidierung lebt im Sync-Pull (engine.ts): dort kommt das
    // Remote-Signal an. Ein Read-seitiger Vergleich gegen das lokale updatedAt
    // wertete den eigenen Offline-Edit als Staleness (brach den e2e-Testfall "bestehenden Eintrag offline bearbeiten").
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)
    expect(await readCachedEntryMedia(store, "entry-1")).toHaveLength(1)
  })

  it("overwrites — the server list is authoritative, so a deleted photo goes away", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makePhoto("a"), makePhoto("b", 1)], UPDATED_AT)
    await cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)
    expect((await readCachedEntryMedia(store, "entry-1")).map((m) => m.id)).toEqual(["a"])
  })

  it("deleteCachedEntryMedia entfernt den Schlüssel", async () => {
    const store = makeStore()
    await cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)
    await deleteCachedEntryMedia(store, "entry-1")
    expect(store.data.size).toBe(0)
  })

  it("a failing write is reported, not swallowed, and does not throw into render", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const store: MetaStore = {
      getMeta: async () => null,
      setMeta: async () => { throw new DOMException("closed", "InvalidStateError") },
    }
    await expect(cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("a failing read is reported and degrades to empty", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const store: MetaStore = {
      getMeta: async () => { throw new DOMException("closed", "InvalidStateError") },
      setMeta: async () => {},
    }
    expect(await readCachedEntryMedia(store, "entry-1")).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe("Quota-Signal", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("isQuotaError erkennt QuotaExceededError, aber keine anderen DOMExceptions", () => {
    expect(isQuotaError(new DOMException("voll", "QuotaExceededError"))).toBe(true)
    expect(isQuotaError(new DOMException("closed", "InvalidStateError"))).toBe(false)
    expect(isQuotaError(new Error("voll"))).toBe(false)
  })

  it("ein Quota-Fehler beim Schreiben feuert das Badge-Event", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const dispatched: Event[] = []
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => { dispatched.push(e); return true } })

    const store: MetaStore = {
      getMeta: async () => null,
      setMeta: async () => { throw new DOMException("voll", "QuotaExceededError") },
    }
    await cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].type).toBe(STORAGE_ERROR_EVENT)
    spy.mockRestore()
  })

  it("kein Event für Nicht-Quota-Fehler — das Badge soll nicht rauschen", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const dispatched: Event[] = []
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => { dispatched.push(e); return true } })

    const store: MetaStore = {
      getMeta: async () => null,
      setMeta: async () => { throw new DOMException("closed", "InvalidStateError") },
    }
    await cacheEntryMedia(store, "entry-1", [makePhoto("a")], UPDATED_AT)

    expect(dispatched).toHaveLength(0)
    spy.mockRestore()
  })
})
