/**
 * Reconnect: der Wartekorb wird nach dem Entry-Push geleert.
 *
 * Reihenfolge ist der Kern: `/api/sync/upsert` legt den Eintrag unter der vom
 * Client erzeugten UUID an, `/api/upload?entryId=` hängt die Datei an einen
 * bereits existierenden Eintrag. Medien dürfen deshalb erst nach dem Push
 * hochgeladen werden — sonst schreibt der Server die Datei, überspringt den
 * DB-Insert und antwortet trotzdem 201.
 *
 * In-Memory-IDBAdapter-Stub, nur synthetische Daten.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSyncEngine } from "../src/lib/sync/engine"
import type { IDBAdapter } from "../src/lib/sync/idb"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "../src/lib/sync/types"
import { MAX_UPLOAD_ATTEMPTS, type OutboxMedia } from "../src/lib/sync/media-outbox"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID = "20000000-0000-4000-8000-000000000001"

function makeStubIDB() {
  const entries = new Map<string, SyncEntry>()
  const queue = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta = new Map<string, string>()
  const outbox = new Map<string, OutboxMedia>()

  const idb: IDBAdapter = {
    getEntry: async (id) => entries.get(id),
    putEntry: async (e) => { entries.set(e.id, e) },
    deleteEntry: async (id) => { entries.delete(id) },
    getAllEntries: async () => [...entries.values()],
    enqueueEdit: async (q) => { queue.set(q.entryId, q) },
    dequeueEdit: async (id) => { queue.delete(id) },
    listQueue: async () => [...queue.values()],
    putConflict: async (c) => { conflicts.set(c.id, c) },
    listConflicts: async () => [...conflicts.values()],
    clearConflict: async (id) => { conflicts.delete(id) },
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => { meta.set(k, v) },
    putPin: async () => {},
    getPin: async () => undefined,
    deletePin: async () => {},
    listPins: async () => [],
    putMediaLRU: async () => {},
    getMediaLRU: async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
    putOutboxMedia: async (item) => { outbox.set(item.id, item) },
    deleteOutboxMedia: async (id) => { outbox.delete(id) },
    listOutboxMedia: async () => [...outbox.values()],
    listOutboxMediaForEntry: async (entryId) =>
      [...outbox.values()].filter((i) => i.entryId === entryId),
  }
  return { idb, outbox, queue }
}

function makeOutboxItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
  return {
    id: "media-1",
    entryId: ENTRY_ID,
    blob: new Blob(["synthetic-bytes"], { type: "image/jpeg" }),
    fileName: "synthetic.jpg",
    mimeType: "image/jpeg",
    type: "photo",
    size: 15,
    queuedAt: "2026-07-27T10:00:00.000Z",
    attempts: 0,
    ...over,
  }
}

function makeQueuedEdit(): QueuedEdit {
  const payload: SyncEntry = {
    id: ENTRY_ID,
    journalId: JOURNAL_ID,
    text: "Synthetic offline entry",
    createdAt: "2026-07-27T09:00:00.000Z",
    updatedAt: "2026-07-27T09:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false,
    tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
  return { entryId: ENTRY_ID, operation: "create", payload, queuedAt: payload.updatedAt }
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

afterEach(() => vi.restoreAllMocks())

describe("flushMedia()", () => {
  let stub: ReturnType<typeof makeStubIDB>
  beforeEach(() => { stub = makeStubIDB() })

  it("hängt die wartende Datei an den Eintrag und räumt den Korb", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { id: "40000000-0000-4000-8000-000000000001", filePath: "/media/x/y.jpg" })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(stub.idb).flushMedia()

    expect(result).toEqual({ uploaded: 1, failed: 0 })
    expect(await stub.idb.listOutboxMedia!()).toHaveLength(0)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/upload?entryId=${ENTRY_ID}`)
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).body).toBeInstanceOf(FormData)
  })

  it("schickt die Outbox-Id als Idempotenzschlüssel mit", async () => {
    // Ohne clientMediaId erzeugt jeder Retry nach verlorener Antwort eine neue
    // media-Zeile mit neuem UUID-Pfad: dasselbe Foto dauerhaft doppelt.
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { id: "40000000-0000-4000-8000-000000000001" })
    )
    vi.stubGlobal("fetch", fetchMock)

    await createSyncEngine(stub.idb).flushMedia()

    const [, init] = fetchMock.mock.calls[0]
    const fd = (init as RequestInit).body as FormData
    expect(fd.get("clientMediaId")).toBe("media-1")
  })

  it("räumt ein Item auf, dessen Eintrag serverseitig gelöscht wurde (410)", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(410, { error: "Eintrag wurde gelöscht", code: "entry_deleted" })
    ))

    const result = await createSyncEngine(stub.idb).flushMedia()

    // Weder Erfolg noch Dauer-Fehler: der Eintrag ist weg, das Item hat kein
    // Zuhause mehr und darf nicht ewig als „wartet" angezeigt werden.
    expect(result).toEqual({ uploaded: 0, failed: 0 })
    expect(await stub.idb.listOutboxMedia!()).toHaveLength(0)
  })

  it("lädt nichts hoch, solange der Eintrag selbst noch in der Queue liegt", async () => {
    await stub.idb.enqueueEdit(makeQueuedEdit())
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(stub.idb).flushMedia()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ uploaded: 0, failed: 0 })
    expect(await stub.idb.listOutboxMedia!()).toHaveLength(1)
  })

  it("behält die Datei bei 201 ohne media-id und merkt sich die Ursache", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(201, { filePath: "/media/x/y.jpg" })
    ))

    const result = await createSyncEngine(stub.idb).flushMedia()

    expect(result.uploaded).toBe(0)
    const [kept] = await stub.idb.listOutboxMedia!()
    expect(kept.attempts).toBe(1)
    expect(kept.lastError).toContain("noch nicht vorhanden")
  })

  it("behält die Datei bei Netzwerkabbruch", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    await createSyncEngine(stub.idb).flushMedia()

    const [kept] = await stub.idb.listOutboxMedia!()
    expect(kept.attempts).toBe(1)
    expect(kept.lastError).toContain("Netzwerkfehler")
  })

  it("stoppt eine 4xx-Ablehnung sofort, löscht sie aber nicht stillschweigend", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem())
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(400, { error: "Dateiformat nicht erlaubt" })
    ))

    const result = await createSyncEngine(stub.idb).flushMedia()

    expect(result.failed).toBe(1)
    const [kept] = await stub.idb.listOutboxMedia!()
    expect(kept.attempts).toBe(MAX_UPLOAD_ATTEMPTS)
    expect(kept.lastError).toBe("Dateiformat nicht erlaubt")
  })

  it("meldet ausgereizte Dateien weiter, auch ohne neuen Versuch", async () => {
    await stub.idb.putOutboxMedia!(makeOutboxItem({ attempts: MAX_UPLOAD_ATTEMPTS }))
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(stub.idb).flushMedia()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
  })

  it("bleibt auf alten Adaptern ohne Outbox-Methoden ruhig", async () => {
    const legacy = { ...stub.idb }
    delete legacy.listOutboxMedia
    delete legacy.putOutboxMedia
    delete legacy.deleteOutboxMedia

    await expect(createSyncEngine(legacy).flushMedia()).resolves.toEqual({ uploaded: 0, failed: 0 })
  })
})

describe("sync() — Reihenfolge Push vor Medien", () => {
  it("pusht den Eintrag zuerst und lädt die Datei erst danach hoch", async () => {
    const { idb } = makeStubIDB()
    await idb.enqueueEdit(makeQueuedEdit())
    await idb.putOutboxMedia!(makeOutboxItem())

    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url.split("?")[0])
      if (url.includes("/api/sync/upsert")) {
        return jsonResponse(200, { accepted: [ENTRY_ID], conflicts: [], errors: [] })
      }
      if (url.includes("/api/upload")) {
        return jsonResponse(201, { id: "40000000-0000-4000-8000-000000000001" })
      }
      return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-07-27T12:00:00.000Z" })
    }))

    const result = await createSyncEngine(idb).sync()

    expect(calls.indexOf("/api/sync/upsert")).toBeLessThan(calls.indexOf("/api/upload"))
    expect(result.pushed).toBe(1)
    expect(result.mediaUploaded).toBe(1)
    expect(result.mediaFailed).toBe(0)
    expect(await idb.listOutboxMedia!()).toHaveLength(0)
  })
})
