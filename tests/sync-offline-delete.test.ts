/**
 * Offline löschen: Die Edit-Queue kennt die Operation
 * `delete`, aber push() filterte Delete-Edits heraus, meldete sie als accepted
 * und dequeute sie nie — ein offline gelöschter Eintrag erreichte den Server
 * niemals. Jetzt spielt push() gequeute Deletes gegen DELETE /api/entries/[id]
 * nach; 404 zählt als idempotenter Erfolg (Eintrag hat den Server nie erreicht
 * oder ist bereits tombstoned). Synthetic data only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSyncEngine } from "../src/lib/sync/engine"
import type { IDBAdapter } from "../src/lib/sync/idb"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "../src/lib/sync/types"

function makeStubIDB(): IDBAdapter {
  const entries = new Map<string, SyncEntry>()
  const queue   = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta    = new Map<string, string>()
  return {
    getEntry:      async (id) => entries.get(id),
    putEntry:      async (e)  => { entries.set(e.id, e) },
    deleteEntry:   async (id) => { entries.delete(id) },
    getAllEntries:  async ()   => [...entries.values()],
    enqueueEdit:   async (q)  => { queue.set(q.entryId, q) },
    dequeueEdit:   async (id) => { queue.delete(id) },
    listQueue:     async ()   => [...queue.values()],
    putConflict:   async (c)  => { conflicts.set(c.id, c) },
    listConflicts: async ()   => [...conflicts.values()],
    clearConflict: async (id) => { conflicts.delete(id) },
    getMeta:       async (k)  => meta.get(k) ?? null,
    setMeta:       async (k, v) => { meta.set(k, v) },
    putPin:        async () => {},
    getPin:        async () => undefined,
    deletePin:     async () => {},
    listPins:      async () => [],
    putMediaLRU:   async () => {},
    getMediaLRU:   async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
  }
}

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_A = "20000000-0000-4000-8000-00000000000a"
const ENTRY_B = "20000000-0000-4000-8000-00000000000b"

function makeSyncEntry(id: string, updatedAt = "2026-08-04T10:00:00.000Z"): SyncEntry {
  return {
    id, journalId: JOURNAL_ID, text: "Synthetic entry",
    createdAt: "2026-08-01T10:00:00.000Z", updatedAt,
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

function queuedDelete(entryId: string): QueuedEdit {
  return { entryId, operation: "delete", payload: null, queuedAt: "2026-08-04T11:00:00.000Z" }
}

describe("push() — queued deletes reach the server", () => {
  let idb: IDBAdapter
  beforeEach(() => { idb = makeStubIDB() })
  afterEach(() => vi.unstubAllGlobals())

  it("sends DELETE /api/entries/[id] and dequeues on success", async () => {
    await idb.enqueueEdit(queuedDelete(ENTRY_A))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(idb).push()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/entries/${ENTRY_A}`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" })
    expect(result.accepted).toEqual([ENTRY_A])
    expect(await idb.listQueue()).toEqual([])
  })

  it("treats 404 as idempotent success — entry never reached the server or is already tombstoned", async () => {
    await idb.enqueueEdit(queuedDelete(ENTRY_A))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    const result = await createSyncEngine(idb).push()

    expect(result.accepted).toEqual([ENTRY_A])
    expect(result.errors).toEqual([])
    expect(await idb.listQueue()).toEqual([])
  })

  it("keeps the delete queued on a server error", async () => {
    await idb.enqueueEdit(queuedDelete(ENTRY_A))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    const result = await createSyncEngine(idb).push()

    expect(result.accepted).toEqual([])
    expect(result.errors).toEqual([{ entryId: ENTRY_A, message: "HTTP 503" }])
    expect((await idb.listQueue()).map((q) => q.entryId)).toEqual([ENTRY_A])
  })

  it("keeps the delete queued on a network failure", async () => {
    await idb.enqueueEdit(queuedDelete(ENTRY_A))
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    const result = await createSyncEngine(idb).push()

    expect(result.accepted).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect((await idb.listQueue()).map((q) => q.entryId)).toEqual([ENTRY_A])
  })

  it("mixed batch: delete goes through DELETE, create through upsert", async () => {
    await idb.enqueueEdit(queuedDelete(ENTRY_A))
    await idb.enqueueEdit({
      entryId: ENTRY_B,
      operation: "create",
      payload: makeSyncEntry(ENTRY_B),
      queuedAt: "2026-08-04T11:00:00.000Z",
    })
    const fetchMock = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true }) }
      expect(url).toBe("/api/sync/upsert")
      return { ok: true, status: 200, json: async () => ({ accepted: [ENTRY_B], conflicts: [] }) }
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(idb).push()

    expect(result.accepted.sort()).toEqual([ENTRY_A, ENTRY_B])
    expect(await idb.listQueue()).toEqual([])
  })

  it("drops a corrupt create without payload instead of retrying forever", async () => {
    await idb.enqueueEdit({ entryId: ENTRY_B, operation: "create", payload: null, queuedAt: "2026-08-04T11:00:00.000Z" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await createSyncEngine(idb).push()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await idb.listQueue()).toEqual([])
  })
})
