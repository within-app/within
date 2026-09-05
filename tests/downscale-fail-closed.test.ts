/**
 * PR6 — Fail-closed-Korrektur des Upload-Verkleinerungs-Schalters (Befund
 * 05.08. abends): Der stille Original-Fallback hat auf Vanadium 11-MB-Zombies
 * in die Outbox gelassen. Jetzt gilt: Verkleinern unmöglich + Datei über der
 * Kappe → sichtbar ablehnen (Attach) bzw. endgültig rejecten (Flush-Hook),
 * nie mehr still das Original durchreichen.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { tryDownscalePhoto, UPLOAD_HARD_CAP_BYTES, jpegName } from "@/lib/upload-downscale"
import { createSyncEngine, type SyncEngineHooks } from "@/lib/sync/engine"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { OutboxMedia } from "@/lib/sync/media-outbox"

const ORIGINAL_FETCH = globalThis.fetch

function makeItem(size: number, mimeType = "image/jpeg"): OutboxMedia {
  return {
    id: "outbox-1",
    entryId: "20000000-0000-4000-8000-000000000001",
    fileName: "synthetic.jpg",
    mimeType,
    blob: new Blob([new Uint8Array(size)], { type: mimeType }),
    queuedAt: "2026-08-05T10:00:00.000Z",
    attempts: 0,
  } as unknown as OutboxMedia
}

function makeIdb(items: OutboxMedia[]) {
  const put = vi.fn<(media: OutboxMedia) => Promise<void>>(async () => {})
  return {
    idb: {
      getMeta: vi.fn(async () => "2"),
      setMeta: vi.fn(async () => {}),
      listQueue: vi.fn(async () => []),
      listConflicts: vi.fn(async () => []),
      listOutboxMedia: vi.fn(async () => items),
      deleteOutboxMedia: vi.fn(async () => {}),
      putOutboxMedia: put,
      deleteEntry: vi.fn(async () => {}),
      putEntry: vi.fn(async () => {}),
    } as unknown as IDBAdapter,
    put,
  }
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe("tryDownscalePhoto — ehrliches Ergebnis statt stillem Fallback", () => {
  it("meldet ok:false, wenn die Plattform-APIs fehlen (node)", async () => {
    const result = await tryDownscalePhoto(new Blob([new Uint8Array(100)], { type: "image/jpeg" }))
    expect(result.ok).toBe(false)
  })

  it("jpegName ersetzt bzw. ergänzt die Endung (Re-Encode ist immer JPEG)", () => {
    expect(jpegName("DSC09525.ARW.jpeg")).toBe("DSC09525.ARW.jpg")
    expect(jpegName("foto")).toBe("foto.jpg")
  })
})

describe("flushMedia prepareUploadBlob-Hook", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ locale: null }), { status: 200 })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  it("rejectMessage markiert das Item endgültig und lädt NICHT hoch", async () => {
    const item = makeItem(UPLOAD_HARD_CAP_BYTES + 1)
    const { idb, put } = makeIdb([item])
    const hooks: SyncEngineHooks = {
      prepareUploadBlob: async () => ({ rejectMessage: "zu groß fürs Gerät" }),
    }
    const engine = createSyncEngine(idb, "", undefined, hooks)

    const result = await engine.flushMedia()

    expect(result.failed).toBe(1)
    expect(result.uploaded).toBe(0)
    // Kein /api/upload-Request — nur was sonst so läuft (hier: nichts weiter)
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/upload"))).toHaveLength(0)
    // Item wurde als rejected persistiert (attempts auf Max, lastError gesetzt)
    expect(put).toHaveBeenCalledTimes(1)
    const stored = put.mock.calls[0][0] as OutboxMedia
    expect(stored.lastError).toBe("zu groß fürs Gerät")
  })

  it("blob-Ersatz lädt den kleinen Body unter derselben Idempotenz-Id hoch", async () => {
    const item = makeItem(UPLOAD_HARD_CAP_BYTES + 1)
    const { idb } = makeIdb([item])
    const small = new Blob([new Uint8Array(1000)], { type: "image/jpeg" })
    const hooks: SyncEngineHooks = { prepareUploadBlob: async () => ({ blob: small }) }
    fetchMock.mockImplementation(async (url: string | URL) =>
      String(url).includes("/api/upload")
        ? new Response(JSON.stringify({ id: "media-1" }), { status: 201 })
        : new Response(JSON.stringify({}), { status: 200 })
    )
    const engine = createSyncEngine(idb, "", undefined, hooks)

    const result = await engine.flushMedia()

    expect(result.uploaded).toBe(1)
    const uploadCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/upload"))
    expect(uploadCall).toBeDefined()
    const body = uploadCall![1]?.body as FormData
    expect((body.get("file") as File).size).toBe(1000)
    expect(body.get("clientMediaId")).toBe("outbox-1")
  })

  it("ohne Hook bleibt das Verhalten unverändert (Original-Blob)", async () => {
    const item = makeItem(500)
    const { idb } = makeIdb([item])
    fetchMock.mockImplementation(async (url: string | URL) =>
      String(url).includes("/api/upload")
        ? new Response(JSON.stringify({ id: "media-1" }), { status: 201 })
        : new Response(JSON.stringify({}), { status: 200 })
    )
    const engine = createSyncEngine(idb)

    const result = await engine.flushMedia()

    expect(result.uploaded).toBe(1)
    const uploadCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/upload"))
    expect((uploadCall![1]?.body as FormData).get("file")).toBeInstanceOf(File)
    expect(((uploadCall![1]?.body as FormData).get("file") as File).size).toBe(500)
  })
})
