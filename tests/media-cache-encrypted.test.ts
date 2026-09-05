/**
 * Vault P2 — der Pin-Flow (cacheMediaUrls) schreibt nur noch Ciphertext in
 * den Medien-Cache. Vorher legte er die Netz-Response im Klartext ab und
 * hätte damit den vom SW verschlüsselten Eintrag wieder überschrieben —
 * genau die Lücke, die P2 schließt.
 *
 * Dazu: reconcileMediaLRU() räumt LRU-Metadaten ohne Cache-Eintrag ab
 * (Purge des v1-Klartext-Caches hinterlässt sonst Geister-Einträge, deren
 * sizeBytes das Eviction-Budget dauerhaft verfälschen).
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { MediaLRUEntry } from "../src/lib/offline/lru-logic"
import { generateDekRaw, importDek } from "../src/lib/vault/crypto"
import {
  MEDIA_ENC_HEADER,
  MEDIA_ENC_VERSION,
  decryptMediaResponse,
} from "../src/lib/offline/media-encryption"

const PLAINTEXT = new TextEncoder().encode("synthetic-pin-photo")

// ── Mocks: IDB-Adapter, Vault-Session, Cache Storage, fetch ──────────────────

const lruStore = new Map<string, MediaLRUEntry>()
const pins: {
  entryId: string
  pinnedAt?: string
  mediaUrls?: string[]
  mediaUrlsPending?: boolean
}[] = []
// B14: Einträge-Spiegel + Pin-Löschungen für den Reconcile-Waisen-Check.
const entryIds = new Set<string>()
const deletedPins: string[] = []

vi.mock("@/lib/sync/idb", () => ({
  realIDBAdapter: {
    getMediaLRU: async (url: string) => lruStore.get(url),
    putMediaLRU: async (entry: MediaLRUEntry) => {
      lruStore.set(entry.url, entry)
    },
    getAllMediaLRU: async () => [...lruStore.values()],
    deleteMediaLRU: async (url: string) => {
      lruStore.delete(url)
    },
    listPins: async () => pins,
    getEntry: async (id: string) => (entryIds.has(id) ? { id } : undefined),
    putPin: async (pin: { entryId: string }) => {
      const idx = pins.findIndex((p) => p.entryId === pin.entryId)
      if (idx >= 0) pins[idx] = pin
      else pins.push(pin)
    },
    deletePin: async (entryId: string) => {
      deletedPins.push(entryId)
      const idx = pins.findIndex((p) => p.entryId === entryId)
      if (idx >= 0) pins.splice(idx, 1)
    },
  },
}))

const vaultState: { dek: CryptoKey | null } = { dek: null }
vi.mock("@/lib/vault/vault", () => ({
  getSessionDek: () => vaultState.dek,
}))

class MemCache {
  store = new Map<string, Response>()
  async match(url: string) {
    return this.store.get(url)?.clone()
  }
  async put(url: string, res: Response) {
    this.store.set(url, res)
  }
  // Die echte API nimmt Request | string und keys() liefert Requests —
  // hier minimale {url}-Objekte, die Implementierung normalisiert selbst.
  async delete(req: { url: string } | string) {
    return this.store.delete(typeof req === "string" ? req : req.url)
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }))
  }
}

class MemCacheStorage {
  caches = new Map<string, MemCache>()
  async open(name: string) {
    if (!this.caches.has(name)) this.caches.set(name, new MemCache())
    return this.caches.get(name)!
  }
  async delete(name: string) {
    return this.caches.delete(name)
  }
  async has(name: string) {
    return this.caches.has(name)
  }
}

let cacheStorage: MemCacheStorage

import { MEDIA_CACHE_NAME, cacheMediaUrls, reconcileMediaLRU } from "../src/lib/offline/media-cache"

beforeEach(() => {
  lruStore.clear()
  pins.length = 0
  entryIds.clear()
  deletedPins.length = 0
  vaultState.dek = null
  cacheStorage = new MemCacheStorage()
  vi.stubGlobal("caches", cacheStorage)
  // Seit dem HTTP-Cache-Fix antwortet die Medien-Route selbst mit
  // `private, no-store` — der Default-Mock bildet exakt diese Server-Antwort
  // ab. Der Pin-Flow MUSS sie cachen (Stolperdraht: ein älterer Guard
  // filterte auf no-store und hätte hier still nichts mehr gecacht).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(PLAINTEXT.slice(), {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(PLAINTEXT.length),
          "Cache-Control": "private, no-store",
        },
      })
    )
  )
})

describe("cacheMediaUrls (Pin-Flow) verschlüsselt", () => {
  it("legt den Eintrag als Umschlag ab — nie als Klartext", async () => {
    vaultState.dek = await importDek(generateDekRaw())
    await cacheMediaUrls("entry-1", ["/media/photos/synthetic-a.jpg"])

    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    const stored = cache.store.get("/media/photos/synthetic-a.jpg")
    expect(stored).toBeDefined()
    expect(stored!.headers.get(MEDIA_ENC_HEADER)).toBe(MEDIA_ENC_VERSION)
    const bytes = new Uint8Array(await stored!.clone().arrayBuffer())
    expect(new TextDecoder().decode(bytes)).not.toContain("synthetic-pin-photo")

    const dec = await decryptMediaResponse(vaultState.dek!, stored!.clone())
    expect(dec).not.toBeNull()
    expect(new Uint8Array(await dec!.arrayBuffer())).toEqual(PLAINTEXT)

    // LRU-Metadaten wie bisher (Klartext-Größe als Heuristik reicht dem Budget).
    expect(lruStore.get("/media/photos/synthetic-a.jpg")?.sizeBytes).toBe(PLAINTEXT.length)
  })

  it("ohne Session-DEK (gesperrt): kein Cache-Write, keine LRU-Metadaten (fail closed)", async () => {
    await cacheMediaUrls("entry-1", ["/media/photos/synthetic-a.jpg"])
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.size).toBe(0)
    expect(lruStore.size).toBe(0)
  })

  it("SVG-Platzhalter des SW wird weiterhin nie gecacht — erkannt am Marker-Header", async () => {
    vaultState.dek = await importDek(generateDekRaw())
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<svg/>", {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-store",
            "x-within-sw": "placeholder",
          },
        })
      )
    )
    await cacheMediaUrls("entry-1", ["/media/photos/synthetic-a.jpg"])
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.size).toBe(0)
    expect(lruStore.size).toBe(0)
  })

  it("SVG-Platzhalter eines ALTEN SW (ohne Marker-Header) wird ebenfalls nie gecacht", async () => {
    // Update-Übergang: alte SW-Generationen setzen den Marker noch nicht —
    // der SVG-Content-Type bleibt als Fallback-Erkennung (Uploads können nie
    // SVG sein, upload-security-Allowlist).
    vaultState.dek = await importDek(generateDekRaw())
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<svg/>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
        })
      )
    )
    await cacheMediaUrls("entry-1", ["/media/photos/synthetic-a.jpg"])
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.size).toBe(0)
    expect(lruStore.size).toBe(0)
  })
})

describe("reconcileMediaLRU", () => {
  const row = (url: string): MediaLRUEntry => ({
    url,
    entryId: "entry-1",
    cachedAt: "2026-08-01T00:00:00.000Z",
    lastAccessedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 10,
  })

  it("löscht den v1-Klartext-Cache und LRU-Zeilen ohne Cache-Eintrag, behält gedeckte Zeilen", async () => {
    await cacheStorage.open("within-media-v1")
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put("/media/photos/covered.jpg", new Response("x"))

    lruStore.set("/media/photos/covered.jpg", row("/media/photos/covered.jpg"))
    lruStore.set("/media/photos/ghost.jpg", row("/media/photos/ghost.jpg"))

    await reconcileMediaLRU()

    expect(await cacheStorage.has("within-media-v1")).toBe(false)
    expect(lruStore.has("/media/photos/covered.jpg")).toBe(true)
    expect(lruStore.has("/media/photos/ghost.jpg")).toBe(false)
  })

  it("löscht Cache-Einträge ohne LRU-Zeile (Auto-Cache-Altbestand; offline nur Pins)", async () => {
    // LRU-Zeilen schreibt ausschließlich der Pin-Flow — ein Cache-Eintrag ohne
    // Zeile ist ein Auto-Cache-Relikt (oder stammt von einem noch nicht
    // upgedateten SW) und fliegt beim Abgleich nach dem Entsperren raus.
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put("/media/photos/pinned.jpg", new Response("x"))
    await cache.put("/media/photos/auto-leftover.jpg", new Response("x"))
    lruStore.set("/media/photos/pinned.jpg", row("/media/photos/pinned.jpg"))

    await reconcileMediaLRU()

    expect(cache.store.has("/media/photos/pinned.jpg")).toBe(true)
    expect(cache.store.has("/media/photos/auto-leftover.jpg")).toBe(false)
  })
})

describe("Pin-Adoption + Backfill + Waisen-Pins (B12/B13/B14)", () => {
  const row = (url: string, entryId = "entry-1"): MediaLRUEntry => ({
    url,
    entryId,
    cachedAt: "2026-08-01T00:00:00.000Z",
    lastAccessedAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 10,
  })

  it("B12: adoptiert einen vorhandenen Cache-Eintrag, wenn der SW die Anfrage aus dem Cache beantwortet (Marker cache-decrypt)", async () => {
    // Pin-Fetch läuft durch den SW: liegt der Eintrag schon (verschlüsselt) im
    // Cache, antwortet der SW mit der ENTSCHLÜSSELTEN Response und markiert
    // sie mit x-within-sw: cache-decrypt (seit dem HTTP-Cache-Fix ist
    // no-store kein SW-Erkennungszeichen mehr — der Server sendet es selbst).
    // Bis B12 fehlte dann die LRU-Zeile → der nächste Reconcile purgte den
    // Eintrag als "untracked" — der Pin verlor sein Foto, obwohl es im Cache lag.
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/already-cached.jpg"
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put(url, new Response("ciphertext", { headers: { [MEDIA_ENC_HEADER]: MEDIA_ENC_VERSION } }))

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(PLAINTEXT.slice(), {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-store",
            "x-within-sw": "cache-decrypt",
          },
        })
      )
    )

    await cacheMediaUrls("entry-1", [url])
    expect(lruStore.has(url)).toBe(true)
    // Der vorhandene (verschlüsselte) Eintrag bleibt unangetastet.
    expect(cache.store.has(url)).toBe(true)
  })

  it("B13: reconcileMediaLRU lädt fehlende Medien gepinnter Einträge nach (offline gesetzter Pin)", async () => {
    // Ein offline gesetzter Pin bekam nie Medien — und nichts holte sie nach:
    // cacheMediaUrls lief nur im Pin-Moment. Der Abgleich nach dem Entsperren
    // ist der natürliche Heilungspunkt.
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/pinned-but-missing.jpg"
    entryIds.add("entry-1")
    pins.push({ entryId: "entry-1", pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [url] })

    await reconcileMediaLRU()

    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.has(url)).toBe(true)
    expect(lruStore.has(url)).toBe(true)
  })

  it("B14: reconcileMediaLRU räumt Pins, deren Löschung der Server bestätigt (404 → Cache + LRU + Pin-Record)", async () => {
    // Tombstone-Delete vom anderen Gerät: Eintrag weg, Pin blieb — gepinnte
    // Bytes waren unevictbar und zählten für immer gegen das 200-MiB-Budget.
    // Nachgeschärft im zweiten Pass 22.08.: Beweis ist die Server-Antwort
    // 404/410 (Route filtert deleted_at), nicht die lokale Abwesenheit.
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/orphan-pin.jpg"
    // KEIN entryIds.add — der Eintrag existiert nicht mehr.
    pins.push({ entryId: "entry-gone", pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [url] })
    lruStore.set(url, row(url, "entry-gone"))
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put(url, new Response("x"))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/entries/")
          ? new Response(null, { status: 404 })
          : new Response(PLAINTEXT.slice(), { status: 200, headers: { "Content-Type": "image/jpeg" } })
      )
    )

    await reconcileMediaLRU()

    expect(deletedPins).toContain("entry-gone")
    expect(lruStore.has(url)).toBe(false)
    expect(cache.store.has(url)).toBe(false)
  })

  it("Fail-safe: Eintrag fehlt nur lokal (nie gepullt), Server kennt ihn (200) → Pin und Cache bleiben", async () => {
    // Eintrag online angelegt und sofort
    // gepinnt — der lokale Store sieht ihn erst nach dem nächsten Sync-Pull.
    // Der alte Waisen-Check las „fehlt lokal" als „gelöscht" und entpinnte
    // still beim nächsten Unlock (Incident-Klasse: destruktive Routine
    // schließt aus Abwesenheit auf Löschbarkeit).
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/fresh-never-pulled.jpg"
    pins.push({ entryId: "entry-fresh", pinnedAt: "2026-08-22T00:00:00.000Z", mediaUrls: [url] })
    lruStore.set(url, row(url, "entry-fresh"))
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put(url, new Response("ciphertext", { headers: { [MEDIA_ENC_HEADER]: MEDIA_ENC_VERSION } }))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/entries/")
          ? new Response(null, { status: 200 })
          : new Response(PLAINTEXT.slice(), { status: 200, headers: { "Content-Type": "image/jpeg" } })
      )
    )

    await reconcileMediaLRU()

    expect(deletedPins).toHaveLength(0)
    expect(lruStore.has(url)).toBe(true)
    expect(cache.store.has(url)).toBe(true)
  })

  it("B14-Fail-safe: offline → kein Waisen-Räumen, keine Server-Anfrage (No-op)", async () => {
    // Offline-Kaltstart + Unlock ist der Hauptpfad für Pins — hier darf der
    // Reconcile nie raten. Ohne Netz gibt es keinen Löschbeweis → No-op.
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/offline-pin.jpg"
    pins.push({ entryId: "entry-offline", pinnedAt: "2026-08-22T00:00:00.000Z", mediaUrls: [url] })
    lruStore.set(url, row(url, "entry-offline"))
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put(url, new Response("ciphertext", { headers: { [MEDIA_ENC_HEADER]: MEDIA_ENC_VERSION } }))
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubGlobal("navigator", { onLine: false })

    await reconcileMediaLRU()

    expect(deletedPins).toHaveLength(0)
    expect(lruStore.has(url)).toBe(true)
    expect(cache.store.has(url)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("B14-Fail-safe: Server-Anfrage scheitert (Netz kippt) → Pin bleibt", async () => {
    vaultState.dek = await importDek(generateDekRaw())
    const url = "/media/photos/flaky-net-pin.jpg"
    pins.push({ entryId: "entry-flaky", pinnedAt: "2026-08-22T00:00:00.000Z", mediaUrls: [url] })
    lruStore.set(url, row(url, "entry-flaky"))
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    await cache.put(url, new Response("ciphertext", { headers: { [MEDIA_ENC_HEADER]: MEDIA_ENC_VERSION } }))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/entries/")) throw new TypeError("Failed to fetch")
        return new Response(PLAINTEXT.slice(), { status: 200, headers: { "Content-Type": "image/jpeg" } })
      })
    )

    await reconcileMediaLRU()

    expect(deletedPins).toHaveLength(0)
    expect(lruStore.has(url)).toBe(true)
    expect(cache.store.has(url)).toBe(true)
  })
})

describe("backfillPinnedMedia — Medien-Backfill server-adoptierter Pins", () => {
  // Der Sync-Feed trägt protokollbedingt keine Medien-Metadaten
  // (Invariante) — ein per Pull adoptierter Pin kennt seine URLs
  // nicht. Der Backfill löst sie über GET /api/entries/[id] auf (online)
  // und lädt die verschlüsselten Kopien nach; läuft nach jedem Sync und
  // nach jedem Unlock (reconcileMediaLRU).

  it("löst mediaUrlsPending über /api/entries/[id] auf und cached Fotos + Thumbnails verschlüsselt", async () => {
    vaultState.dek = await importDek(generateDekRaw())
    pins.push({ entryId: "entry-adopted", pinnedAt: "2026-08-23T10:00:00.000Z", mediaUrls: [], mediaUrlsPending: true })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/entries/")) {
          return new Response(
            JSON.stringify({
              media: [
                {
                  id: "m-1", entryId: "entry-adopted", type: "photo", order: 0,
                  filePath: "/media/photos/adopted.jpg",
                  thumbnailPath: "/media/photos/thumbs/adopted.jpg",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        }
        return new Response(PLAINTEXT.slice(), {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(PLAINTEXT.length),
            "Cache-Control": "private, no-store",
          },
        })
      })
    )

    const { backfillPinnedMedia } = await import("../src/lib/offline/media-cache")
    await backfillPinnedMedia()

    const pin = pins.find((p) => p.entryId === "entry-adopted")
    expect(pin?.mediaUrls).toEqual(["/media/photos/adopted.jpg", "/media/photos/thumbs/adopted.jpg"])
    expect(pin?.mediaUrlsPending).toBeFalsy()

    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.has("/media/photos/adopted.jpg")).toBe(true)
    expect(cache.store.has("/media/photos/thumbs/adopted.jpg")).toBe(true)
    expect(lruStore.has("/media/photos/adopted.jpg")).toBe(true)
  })

  it("Fail-safe: Detail-Fetch scheitert → Pin bleibt pending, nichts wird gelöscht", async () => {
    vaultState.dek = await importDek(generateDekRaw())
    pins.push({ entryId: "entry-adopted", pinnedAt: "2026-08-23T10:00:00.000Z", mediaUrls: [], mediaUrlsPending: true })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/entries/")) {
          return new Response("{}", { status: 500 })
        }
        return new Response(PLAINTEXT.slice(), { status: 200, headers: { "Content-Type": "image/jpeg" } })
      })
    )

    const { backfillPinnedMedia } = await import("../src/lib/offline/media-cache")
    await backfillPinnedMedia()

    const pin = pins.find((p) => p.entryId === "entry-adopted")
    expect(pin?.mediaUrlsPending).toBe(true)
    expect(deletedPins).toHaveLength(0)
    const cache = await cacheStorage.open(MEDIA_CACHE_NAME)
    expect(cache.store.size).toBe(0)
  })

  it("ohne Session-DEK: No-op (fail closed — kein Klartext, keine Writes)", async () => {
    pins.push({ entryId: "entry-adopted", pinnedAt: "2026-08-23T10:00:00.000Z", mediaUrls: [], mediaUrlsPending: true })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const { backfillPinnedMedia } = await import("../src/lib/offline/media-cache")
    await backfillPinnedMedia()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(pins[0].mediaUrlsPending).toBe(true)
  })
})
