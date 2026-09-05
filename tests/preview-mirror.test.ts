/**
 * Offline-Medienspiegel: Die Zeitraum-Einstellung
 * regelt, welche Foto-VORSCHAUEN (Server-Thumbs) offline in der Medien-
 * übersicht liegen. Der Spiegel:
 *
 * - läuft nur online + entsperrt (fail closed ohne Session-DEK),
 * - holt die Foto-Liste über das bestehende paginierte /api/media
 *   (KEINE Sync-Feed-Erweiterung, Invariante),
 * - cached Thumb-URLs ausschließlich über cacheMediaUrls (verschlüsselter
 *   Umschlag + LRU-Zeile — Budget-Eviction/Reconcile greifen ohne Umbau),
 * - führt eine Registry im verschlüsselten meta-Store (Herkunft: was der
 *   Spiegel verwaltet — NIEMALS Pin-Bytes anfassen),
 * - räumt beim Verkleinern/Aus NUR eigene, nicht pin-gehörende Einträge,
 * - Incident-Lehre (22.08.): leere/fehlgeschlagene Server-Antwort ⇒ No-op,
 *   nie Totalräumung.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { MediaLRUEntry } from "../src/lib/offline/lru-logic"

// ── Mocks: IDB-Adapter (meta/LRU/Pins), Vault, media-cache, fetch ────────────

const metaStore = new Map<string, string>()
const lruStore = new Map<string, MediaLRUEntry>()
const pins: { entryId: string; pinnedAt?: string; mediaUrls?: string[] }[] = []

vi.mock("@/lib/sync/idb", () => ({
  realIDBAdapter: {
    getMeta: async (key: string) => metaStore.get(key) ?? null,
    setMeta: async (key: string, value: string) => {
      metaStore.set(key, value)
    },
    deleteMeta: async (key: string) => {
      metaStore.delete(key)
    },
    getMediaLRU: async (url: string) => lruStore.get(url),
    listPins: async () => pins,
  },
}))

const vaultState: { dek: unknown } = { dek: null }
vi.mock("@/lib/vault/vault", () => ({
  getSessionDek: () => vaultState.dek,
}))

const cacheMediaUrlsMock = vi.fn<(entryId: string, urls: string[]) => Promise<void>>()
const uncacheMediaUrlMock = vi.fn(async (url: string) => {
  lruStore.delete(url)
})
vi.mock("@/lib/offline/media-cache", () => ({
  cacheMediaUrls: (entryId: string, urls: string[]) => cacheMediaUrlsMock(entryId, urls),
  uncacheMediaUrl: (url: string) => uncacheMediaUrlMock(url),
}))

import {
  previewPeriodSince,
  runPreviewMirror,
  readPreviewRegistry,
  PREVIEW_PERIOD_META_KEY,
  PREVIEW_REGISTRY_META_KEY,
  PREVIEW_LASTRUN_META_KEY,
} from "../src/lib/offline/preview-mirror"

const NOW = new Date("2026-08-24T12:00:00.000Z")

function photo(id: string, entryId: string, createdAt: string) {
  return {
    id,
    entryId,
    type: "photo",
    filePath: `/media/${id}/${id}-original.jpg`,
    thumbnailPath: `/media/${id}/${id}-thumb.webp`,
    createdAt,
    journalColor: "#007AFF",
  }
}

function mockMediaApi(pages: Record<number, unknown>, totalPages: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    expect(url.pathname).toBe("/api/media")
    const page = parseInt(url.searchParams.get("page") ?? "1", 10)
    const photos = (pages[page] ?? []) as unknown[]
    return new Response(
      JSON.stringify({ photos, totalCount: 0, page, totalPages }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  })
}

function lruRow(url: string, entryId: string): MediaLRUEntry {
  return { url, entryId, cachedAt: "2026-08-01T00:00:00.000Z", lastAccessedAt: "2026-08-01T00:00:00.000Z", sizeBytes: 19_000 }
}

async function setRegistry(items: unknown[]) {
  metaStore.set(PREVIEW_REGISTRY_META_KEY, JSON.stringify({ items, updatedAt: "2026-08-01T00:00:00.000Z" }))
}

beforeEach(() => {
  metaStore.clear()
  lruStore.clear()
  pins.length = 0
  vaultState.dek = { synthetic: true }
  cacheMediaUrlsMock.mockClear()
  uncacheMediaUrlMock.mockClear()
  vi.unstubAllGlobals()
  vi.stubGlobal("caches", { open: async () => ({}) })
  // Nicht via defineProperty auf dem echten Node-navigator — dessen onLine
  // ist je nach Node-Version nicht überschreibbar (CI-Fail 24.08.).
  vi.stubGlobal("navigator", { onLine: true })
})

// ── previewPeriodSince ───────────────────────────────────────────────────────

describe("previewPeriodSince", () => {
  it("rechnet Monate/Jahre zurück (UTC)", () => {
    expect(previewPeriodSince("1m", NOW)).toBe("2026-07-24T12:00:00.000Z")
    expect(previewPeriodSince("3m", NOW)).toBe("2026-05-24T12:00:00.000Z")
    expect(previewPeriodSince("6m", NOW)).toBe("2026-02-24T12:00:00.000Z")
    expect(previewPeriodSince("1y", NOW)).toBe("2025-08-24T12:00:00.000Z")
    expect(previewPeriodSince("2y", NOW)).toBe("2024-08-24T12:00:00.000Z")
  })

  it("'all' hat keinen Stichtag", () => {
    expect(previewPeriodSince("all", NOW)).toBeNull()
  })
})

// ── runPreviewMirror — Guards ────────────────────────────────────────────────

describe("runPreviewMirror — Guards (fail closed)", () => {
  it("ohne Session-DEK: kein Fetch, keine Cache-Aufrufe (Vault P2)", async () => {
    vaultState.dek = null
    metaStore.set(PREVIEW_PERIOD_META_KEY, "6m")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await runPreviewMirror({ now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cacheMediaUrlsMock).not.toHaveBeenCalled()
  })

  it("offline: No-op", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "6m")
    vi.stubGlobal("navigator", { onLine: false })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await runPreviewMirror({ now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Zeitraum nie gesetzt (Default Aus) + leere Registry: No-op", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await runPreviewMirror({ now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(uncacheMediaUrlMock).not.toHaveBeenCalled()
  })
})

// ── runPreviewMirror — Spiegeln ──────────────────────────────────────────────

describe("runPreviewMirror — Spiegel-Lauf", () => {
  it("cached Thumb-URLs des Zeitraums über cacheMediaUrls und schreibt die Registry", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "6m")
    const p1 = photo("m1", "e1", "2026-08-20T10:00:00.000Z")
    const p2 = photo("m2", "e1", "2026-08-20T10:00:00.000Z")
    const p3 = photo("m3", "e2", "2026-07-01T10:00:00.000Z")
    vi.stubGlobal("fetch", mockMediaApi({ 1: [p1, p2, p3] }, 1))

    await runPreviewMirror({ now: NOW })

    expect(cacheMediaUrlsMock).toHaveBeenCalledWith("e1", [
      "/media/m1/m1-thumb.webp",
      "/media/m2/m2-thumb.webp",
    ])
    expect(cacheMediaUrlsMock).toHaveBeenCalledWith("e2", ["/media/m3/m3-thumb.webp"])
    const registry = await readPreviewRegistry()
    expect(registry.items).toHaveLength(3)
    expect(registry.items[0]).toEqual({
      mediaId: "m1",
      entryId: "e1",
      thumbUrl: "/media/m1/m1-thumb.webp",
      createdAt: "2026-08-20T10:00:00.000Z",
    })
  })

  it("filtert Videos, thumb-lose Fotos und Einträge außerhalb des Zeitraums", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    const inRange = photo("m1", "e1", "2026-08-20T10:00:00.000Z")
    const tooOld = photo("m2", "e2", "2026-01-01T10:00:00.000Z")
    const video = { ...photo("m3", "e3", "2026-08-21T10:00:00.000Z"), type: "video" }
    const noThumb = { ...photo("m4", "e4", "2026-08-22T10:00:00.000Z"), thumbnailPath: undefined }
    vi.stubGlobal("fetch", mockMediaApi({ 1: [video, noThumb, inRange, tooOld] }, 1))

    await runPreviewMirror({ now: NOW })

    expect(cacheMediaUrlsMock).toHaveBeenCalledTimes(1)
    expect(cacheMediaUrlsMock).toHaveBeenCalledWith("e1", ["/media/m1/m1-thumb.webp"])
    expect((await readPreviewRegistry()).items).toHaveLength(1)
  })

  it("paginiert über alle Seiten (perPage 100)", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "all")
    const p1 = photo("m1", "e1", "2026-08-20T10:00:00.000Z")
    const p2 = photo("m2", "e2", "2026-05-01T10:00:00.000Z")
    const fetchMock = mockMediaApi({ 1: [p1], 2: [p2] }, 2)
    vi.stubGlobal("fetch", fetchMock)

    await runPreviewMirror({ now: NOW })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await readPreviewRegistry()).items).toHaveLength(2)
  })

  it("stoppt die Pagination früh, sobald eine Seite den Zeitraum verlässt (Server sortiert DESC)", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    const fresh = photo("m1", "e1", "2026-08-20T10:00:00.000Z")
    const stale = photo("m2", "e2", "2026-01-01T10:00:00.000Z")
    const fetchMock = mockMediaApi({ 1: [fresh, stale], 2: [photo("m3", "e3", "2025-12-01T10:00:00.000Z")] }, 2)
    vi.stubGlobal("fetch", fetchMock)

    await runPreviewMirror({ now: NOW })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("Throttle: zweiter Lauf < 10 min mit gleichem Zeitraum ist No-op, force überstimmt", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "6m")
    const fetchMock = mockMediaApi({ 1: [photo("m1", "e1", "2026-08-20T10:00:00.000Z")] }, 1)
    vi.stubGlobal("fetch", fetchMock)

    await runPreviewMirror({ now: NOW })
    await runPreviewMirror({ now: new Date(NOW.getTime() + 60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await runPreviewMirror({ now: new Date(NOW.getTime() + 60_000), force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ── runPreviewMirror — Aufräumen (Verkleinern/Aus) ───────────────────────────

describe("runPreviewMirror — Aufräumen", () => {
  it("Zeitraum verkleinert: räumt NUR eigene Registry-URLs außerhalb, nie Pin-Bytes", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    await setRegistry([
      { mediaId: "m1", entryId: "e1", thumbUrl: "/media/m1/m1-thumb.webp", createdAt: "2026-08-20T10:00:00.000Z" },
      { mediaId: "m2", entryId: "e2", thumbUrl: "/media/m2/m2-thumb.webp", createdAt: "2026-01-01T10:00:00.000Z" },
      { mediaId: "m3", entryId: "e3", thumbUrl: "/media/m3/m3-thumb.webp", createdAt: "2026-02-01T10:00:00.000Z" },
    ])
    lruStore.set("/media/m2/m2-thumb.webp", lruRow("/media/m2/m2-thumb.webp", "e2"))
    lruStore.set("/media/m3/m3-thumb.webp", lruRow("/media/m3/m3-thumb.webp", "e3"))
    // e3 ist gepinnt — seine Bytes gehören dem Pin, der Spiegel fasst sie nie an.
    pins.push({ entryId: "e3", mediaUrls: ["/media/m3/m3-original.jpg", "/media/m3/m3-thumb.webp"] })
    vi.stubGlobal("fetch", mockMediaApi({ 1: [photo("m1", "e1", "2026-08-20T10:00:00.000Z")] }, 1))

    await runPreviewMirror({ now: NOW })

    expect(uncacheMediaUrlMock).toHaveBeenCalledTimes(1)
    expect(uncacheMediaUrlMock).toHaveBeenCalledWith("/media/m2/m2-thumb.webp")
    const registry = await readPreviewRegistry()
    expect(registry.items.map((i) => i.mediaId)).toEqual(["m1"])
  })

  it("Zeitraum Aus: räumt eigene nicht-gepinnte Einträge und leert die Registry — ohne Server-Fetch", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "off")
    await setRegistry([
      { mediaId: "m1", entryId: "e1", thumbUrl: "/media/m1/m1-thumb.webp", createdAt: "2026-08-20T10:00:00.000Z" },
      { mediaId: "m2", entryId: "e2", thumbUrl: "/media/m2/m2-thumb.webp", createdAt: "2026-08-21T10:00:00.000Z" },
    ])
    lruStore.set("/media/m1/m1-thumb.webp", lruRow("/media/m1/m1-thumb.webp", "e1"))
    lruStore.set("/media/m2/m2-thumb.webp", lruRow("/media/m2/m2-thumb.webp", "e2"))
    pins.push({ entryId: "e2", mediaUrls: ["/media/m2/m2-thumb.webp"] })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await runPreviewMirror({ now: NOW })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(uncacheMediaUrlMock).toHaveBeenCalledTimes(1)
    expect(uncacheMediaUrlMock).toHaveBeenCalledWith("/media/m1/m1-thumb.webp")
    expect((await readPreviewRegistry()).items).toHaveLength(0)
  })
})

// ── runPreviewMirror — Fail-safes (Incident-Lehre 22.08.) ───────────────────

describe("runPreviewMirror — Fail-safes", () => {
  it("Server-Fehler (!ok): kompletter No-op — Registry bleibt, nichts wird geräumt", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    await setRegistry([
      { mediaId: "m2", entryId: "e2", thumbUrl: "/media/m2/m2-thumb.webp", createdAt: "2026-01-01T10:00:00.000Z" },
    ])
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })))

    await runPreviewMirror({ now: NOW })

    expect(uncacheMediaUrlMock).not.toHaveBeenCalled()
    expect((await readPreviewRegistry()).items).toHaveLength(1)
  })

  it("Netzfehler (fetch wirft): kompletter No-op", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    await setRegistry([
      { mediaId: "m2", entryId: "e2", thumbUrl: "/media/m2/m2-thumb.webp", createdAt: "2026-01-01T10:00:00.000Z" },
    ])
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down") }))

    await runPreviewMirror({ now: NOW })

    expect(uncacheMediaUrlMock).not.toHaveBeenCalled()
    expect((await readPreviewRegistry()).items).toHaveLength(1)
  })

  it("leere Server-Antwort bei nicht-leerer Registry: No-op statt Totalräumung", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    await setRegistry([
      { mediaId: "m2", entryId: "e2", thumbUrl: "/media/m2/m2-thumb.webp", createdAt: "2026-08-20T10:00:00.000Z" },
    ])
    vi.stubGlobal("fetch", mockMediaApi({ 1: [] }, 1))

    await runPreviewMirror({ now: NOW })

    expect(uncacheMediaUrlMock).not.toHaveBeenCalled()
    expect((await readPreviewRegistry()).items).toHaveLength(1)
    // Kein lastRun-Stempel — der nächste Lauf probiert es sofort erneut.
    expect(metaStore.get(PREVIEW_LASTRUN_META_KEY)).toBeUndefined()
  })

  it("kaputte Registry-JSON wird als leer behandelt (kein Crash, kein Räumen)", async () => {
    metaStore.set(PREVIEW_PERIOD_META_KEY, "1m")
    metaStore.set(PREVIEW_REGISTRY_META_KEY, "{not json")
    vi.stubGlobal("fetch", mockMediaApi({ 1: [photo("m1", "e1", "2026-08-20T10:00:00.000Z")] }, 1))

    await runPreviewMirror({ now: NOW })

    expect(uncacheMediaUrlMock).not.toHaveBeenCalled()
    expect((await readPreviewRegistry()).items).toHaveLength(1)
  })
})
