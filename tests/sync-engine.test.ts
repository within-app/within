/**
 * Sync engine tests (pull / push / sync).
 * Uses in-memory IDBAdapter stub. Synthetic data only (Constraint D).
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
    // Pin store stubs
    putPin:        async () => {},
    getPin:        async () => undefined,
    deletePin:     async () => {},
    listPins:      async () => [],
    // LRU metadata stubs
    putMediaLRU:   async () => {},
    getMediaLRU:   async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
  }
}

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

function makeSyncEntry(id: string, updatedAt = "2026-06-15T10:00:00.000Z"): SyncEntry {
  return {
    id, journalId: JOURNAL_ID, text: "Synthetic entry",
    createdAt: "2026-06-01T10:00:00.000Z", updatedAt,
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

describe("pull()", () => {
  let idb: IDBAdapter
  const serverTime = "2026-07-04T12:00:00.000Z"
  beforeEach(() => { idb = makeStubIDB() })
  afterEach(() => vi.restoreAllMocks())

  it("writes returned entries to IDB", async () => {
    const entry = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [entry], nextCursor: null, serverTime }) }))
    const engine = createSyncEngine(idb)
    const count = await engine.pull(null)
    expect(count).toBe(1)
    expect((await idb.getEntry(entry.id))?.id).toBe(entry.id)
  })

  it("pages through cursor until nextCursor is null", async () => {
    const entryA = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    const entryB = makeSyncEntry("20000000-0000-4000-8000-000000000002")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [entryA], nextCursor: "cursor-abc", serverTime }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [entryB], nextCursor: null, serverTime }) })
    vi.stubGlobal("fetch", fetchMock)
    const count = await createSyncEngine(idb).pull(null)
    expect(count).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=cursor-abc")
  })

  it("stores lastSync meta after exhausting pages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], nextCursor: null, serverTime }) }))
    await createSyncEngine(idb).pull(null)
    expect(await idb.getMeta("lastSync")).toBe(serverTime)
  })

  it("returns 0 and does not throw when the server returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }))
    expect(await createSyncEngine(idb).pull(null)).toBe(0)
  })

  it("returns 0 and does not throw on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("Network down")))
    expect(await createSyncEngine(idb).pull(null)).toBe(0)
  })

  it("removes tombstoned entries from IDB instead of upserting them", async () => {
    const entryId = "20000000-0000-4000-8000-000000000001"
    const existing = makeSyncEntry(entryId)
    await idb.putEntry(existing)

    const tombstone: SyncEntry = { ...existing, deletedAt: "2026-07-01T10:00:00.000Z" }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [tombstone], nextCursor: null, serverTime }),
    }))
    await createSyncEngine(idb).pull(null)
    expect(await idb.getEntry(entryId)).toBeUndefined()
  })
})

describe("push()", () => {
  let idb: IDBAdapter
  beforeEach(() => { idb = makeStubIDB() })
  afterEach(() => vi.restoreAllMocks())

  it("returns empty result when queue is empty", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const result = await createSyncEngine(idb).push()
    expect(result.accepted).toHaveLength(0)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("posts queued entries and dequeues accepted ones", async () => {
    const entry = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    await idb.enqueueEdit({ entryId: entry.id, operation: "create", payload: entry, queuedAt: new Date().toISOString() })
    await idb.putEntry(entry)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: [entry.id], conflicts: [] }) }))
    const result = await createSyncEngine(idb).push()
    expect(result.accepted).toContain(entry.id)
    expect(await idb.listQueue()).toHaveLength(0)
  })

  it("stores a conflict copy in IDB when server reports a conflict", async () => {
    const entryId = "20000000-0000-4000-8000-000000000001"
    const localEntry = makeSyncEntry(entryId, "2026-06-10T00:00:00.000Z")
    const serverVersion = makeSyncEntry(entryId, "2026-06-20T00:00:00.000Z")
    await idb.enqueueEdit({ entryId, operation: "update", payload: localEntry, queuedAt: new Date().toISOString() })
    await idb.putEntry(localEntry)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: [], conflicts: [{ entryId, serverVersion }] }) }))
    const result = await createSyncEngine(idb).push()
    expect(result.conflicts).toHaveLength(1)
    expect(await idb.listConflicts()).toHaveLength(1)
    expect((await idb.getEntry(entryId))?.updatedAt).toBe(serverVersion.updatedAt)
    expect(await idb.listQueue()).toHaveLength(0)
  })

  it("replays queued deletes against DELETE /api/entries/[id] and dequeues them", async () => {
    // Vor dem Offline-Delete-Fix wurden Delete-Edits
    // herausgefiltert und nie gesendet — offline löschen erreichte den Server nicht.
    const entryId = "20000000-0000-4000-8000-000000000001"
    await idb.enqueueEdit({ entryId, operation: "delete", payload: null, queuedAt: new Date().toISOString() })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal("fetch", fetchMock)
    const result = await createSyncEngine(idb).push()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/entries/${entryId}`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" })
    expect(result.accepted).toEqual([entryId])
    expect(await idb.listQueue()).toHaveLength(0)
  })
})

describe("sync()", () => {
  let idb: IDBAdapter
  const serverTime = "2026-07-04T12:00:00.000Z"
  beforeEach(() => { idb = makeStubIDB() })
  afterEach(() => vi.restoreAllMocks())

  it("returns combined pushed + pulled counts", async () => {
    const entryId = "20000000-0000-4000-8000-000000000001"
    const localEntry = makeSyncEntry(entryId)
    await idb.enqueueEdit({ entryId, operation: "create", payload: localEntry, queuedAt: new Date().toISOString() })
    const serverEntry = makeSyncEntry("20000000-0000-4000-8000-000000000002")
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: [entryId], conflicts: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [serverEntry], nextCursor: null, serverTime }) }))
    const result = await createSyncEngine(idb).sync()
    expect(result.pushed).toBe(1)
    expect(result.pulled).toBe(1)
    expect(result.conflicts).toBe(0)
  })
})

// Thumbnail backfill — schema version-based full-resync trigger
describe("sync() — schema version backfill", () => {
  let idb: IDBAdapter
  const serverTime = "2026-07-04T12:00:00.000Z"
  const epochSince = "1970-01-01T00:00:00.000Z"

  beforeEach(() => { idb = makeStubIDB() })
  afterEach(() => vi.restoreAllMocks())

  it("uses a full pull (epoch since) when schemaVersion is not stamped", async () => {
    // No schemaVersion set — simulates a fresh install or pre-v2 client.
    // Queue is empty, so push() returns early without calling fetch; only pull() calls fetch.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], nextCursor: null, serverTime }) })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    const pullUrl: string = fetchMock.mock.calls[1][0]
    expect(pullUrl).toContain(`since=${encodeURIComponent(epochSince)}`)
  })

  it("ignores a stored lastSync cursor when schemaVersion is missing (upgrade scenario)", async () => {
    // Simulate a v1 client that had synced entries: lastSync is set but schemaVersion is not.
    await idb.setMeta("lastSync", "2026-06-01T10:00:00.000Z")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], nextCursor: null, serverTime }) })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    const pullUrl: string = fetchMock.mock.calls[1][0]
    // Must use epoch, NOT the stale v1 lastSync cursor.
    expect(pullUrl).toContain(`since=${encodeURIComponent(epochSince)}`)
    expect(pullUrl).not.toContain("2026-06-01")
  })

  it("stamps schemaVersion after a successful full pull", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], nextCursor: null, serverTime }) }))
    await createSyncEngine(idb).sync()
    expect(await idb.getMeta("schemaVersion")).toBe("2")
  })

  it("does NOT stamp schemaVersion when pull fails, so the next sync retries with a full pull", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: false, status: 503 }))
    await createSyncEngine(idb).sync()
    expect(await idb.getMeta("schemaVersion")).toBeNull()
  })

  it("uses delta pull (lastSync) when schemaVersion already matches", async () => {
    const storedLastSync = "2026-07-01T10:00:00.000Z"
    await idb.setMeta("schemaVersion", "2")
    await idb.setMeta("lastSync", storedLastSync)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locale: null }) }) // PR4: Auth-Probe (/api/settings)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], nextCursor: null, serverTime }) })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    const pullUrl: string = fetchMock.mock.calls[1][0]
    expect(pullUrl).toContain(`since=${encodeURIComponent(storedLastSync)}`)
  })
})
