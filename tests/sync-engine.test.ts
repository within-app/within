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
    deleteMeta:    async (k)  => { meta.delete(k) },
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
    expect(await idb.getMeta("schemaVersion")).toBe("3")
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
    await idb.setMeta("schemaVersion", "3")
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

// ── Datenbestand-Kennung (datasetId): Neuabgleich nach Restore/Neuaufsetzen/Journal-Löschung ──
// Der Server stempelt jeden Datenbestand mit einer UUID (app_settings.dataset_id)
// und wechselt sie bei Restore, Neuaufsetzen und Journal-Löschung. Ein Gerät,
// dessen gemerkte Kennung abweicht, verwirft seinen Entries-Bestand und zieht
// alles neu — Push bleibt vorher, damit offline Geschriebenes nicht verloren geht.
describe("sync() — Datenbestand-Kennung (datasetId)", () => {
  const serverTime = "2026-07-04T12:00:00.000Z"
  const epochSince = "1970-01-01T00:00:00.000Z"
  const storedLastSync = "2026-07-01T10:00:00.000Z"

  /** Stub mit clearEntries und einem Ereignis-Log für die Reihenfolge. */
  function stubWithLog() {
    const base = makeStubIDB()
    const log: string[] = []
    const idb: IDBAdapter = {
      ...base,
      clearEntries: async () => {
        log.push("clear")
        for (const e of await base.getAllEntries()) await base.deleteEntry(e.id)
      },
    }
    return { idb, log }
  }

  /** fetch-Mock, der nach URL antwortet und jede Anfrage im Log vermerkt. */
  function routedFetch(log: string[], opts: { datasetId?: string | null; pullOk?: boolean; pushOk?: boolean; serverEntries?: SyncEntry[] }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]
      log.push(`${init?.method ?? "GET"} ${path}`)
      if (path.endsWith("/api/settings")) {
        const body: Record<string, unknown> = { locale: null }
        if (opts.datasetId !== undefined && opts.datasetId !== null) body.datasetId = opts.datasetId
        return { ok: true, status: 200, json: async () => body }
      }
      if (path.endsWith("/api/sync/upsert")) {
        if (opts.pushOk === false) return { ok: false, status: 503, json: async () => ({}) }
        const sent = JSON.parse(String(init?.body ?? "{}")) as { entries?: Array<{ id: string }> }
        return { ok: true, status: 200, json: async () => ({ accepted: (sent.entries ?? []).map((e) => e.id), conflicts: [] }) }
      }
      if (path.endsWith("/api/sync/changes")) {
        if (opts.pullOk === false) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ entries: opts.serverEntries ?? [], nextCursor: null, serverTime }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
  }

  afterEach(() => vi.restoreAllMocks())

  it("gleiche Kennung → kein Reset, Delta-Pull ab lastSync, Kennung bleibt", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    await idb.putEntry(makeSyncEntry("20000000-0000-4000-8000-000000000001"))
    const fetchMock = routedFetch(log, { datasetId: "ds-1" })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    expect(log).not.toContain("clear")
    const pullUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/sync/changes"))!
    expect(pullUrl).toContain(`since=${encodeURIComponent(storedLastSync)}`)
    expect(await idb.getMeta("datasetId")).toBe("ds-1")
    expect(await idb.getAllEntries()).toHaveLength(1)
  })

  it("andere Kennung → Reihenfolge push, clear, Full-Pull ab Epoche, dann Stempel", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    const stale = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    await idb.putEntry(stale)
    // Offline geschriebener Eintrag wartet in der Queue — muss VOR dem Reset hoch.
    const local = makeSyncEntry("20000000-0000-4000-8000-000000000002")
    await idb.putEntry(local)
    await idb.enqueueEdit({ entryId: local.id, operation: "create", payload: local, queuedAt: new Date().toISOString() })
    const fromServer = makeSyncEntry("20000000-0000-4000-8000-000000000003")
    const fetchMock = routedFetch(log, { datasetId: "ds-2", serverEntries: [local, fromServer] })
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(idb).sync()

    const iPush = log.indexOf("POST /api/sync/upsert")
    const iClear = log.indexOf("clear")
    const iPull = log.indexOf("GET /api/sync/changes")
    expect(iPush).toBeGreaterThanOrEqual(0)
    expect(iClear).toBeGreaterThan(iPush)
    expect(iPull).toBeGreaterThan(iClear)
    const pullUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/sync/changes"))!
    expect(pullUrl).toContain(`since=${encodeURIComponent(epochSince)}`)
    expect(pullUrl).not.toContain("2026-07-01")
    // Stempel erst nach dem erfolgreichen Pull
    expect(await idb.getMeta("datasetId")).toBe("ds-2")
    // Alter Bestand weg, Server-Bestand da
    const ids = (await idb.getAllEntries()).map((e) => e.id).sort()
    expect(ids).toEqual([local.id, fromServer.id].sort())
    expect(result.pushed).toBe(1)
  })

  it("Pull-Fehler nach Reset → kein Stempel; der nächste Sync wiederholt den Full-Pull", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    await idb.putEntry(makeSyncEntry("20000000-0000-4000-8000-000000000001"))
    vi.stubGlobal("fetch", routedFetch(log, { datasetId: "ds-2", pullOk: false }))
    const first = await createSyncEngine(idb).sync()
    expect(first.pullFailed).toBe(true)
    expect(await idb.getMeta("datasetId")).toBe("ds-1")

    // Zweiter Sync: Server erreichbar → wieder Full-Pull, jetzt Stempel.
    const log2: string[] = []
    const fetch2 = routedFetch(log2, { datasetId: "ds-2", serverEntries: [makeSyncEntry("20000000-0000-4000-8000-000000000009")] })
    vi.stubGlobal("fetch", fetch2)
    await createSyncEngine(idb).sync()
    const pullUrl = fetch2.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/sync/changes"))!
    expect(pullUrl).toContain(`since=${encodeURIComponent(epochSince)}`)
    expect(await idb.getMeta("datasetId")).toBe("ds-2")
    expect((await idb.getAllEntries()).map((e) => e.id)).toEqual(["20000000-0000-4000-8000-000000000009"])
  })

  it("Kennung lokal unbekannt (erstes Mal) → nur stempeln, kein Reset, Delta-Pull", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.putEntry(makeSyncEntry("20000000-0000-4000-8000-000000000001"))
    const fetchMock = routedFetch(log, { datasetId: "ds-1" })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    expect(log).not.toContain("clear")
    const pullUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/sync/changes"))!
    expect(pullUrl).toContain(`since=${encodeURIComponent(storedLastSync)}`)
    expect(await idb.getMeta("datasetId")).toBe("ds-1")
    expect(await idb.getAllEntries()).toHaveLength(1)
  })

  it("Server ohne Kennung (älterer Stand) → weder Stempel noch Reset", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    vi.stubGlobal("fetch", routedFetch(log, { datasetId: null }))
    await createSyncEngine(idb).sync()
    expect(log).not.toContain("clear")
    expect(await idb.getMeta("datasetId")).toBe("ds-1")
  })

  it("Push scheitert transient (503) → der gequeuete Eintrag bleibt nach dem Reset sichtbar und in der Queue", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    const stale = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    await idb.putEntry(stale)
    const local = makeSyncEntry("20000000-0000-4000-8000-000000000002")
    await idb.putEntry(local)
    await idb.enqueueEdit({ entryId: local.id, operation: "create", payload: local, queuedAt: new Date().toISOString() })
    const fromServer = makeSyncEntry("20000000-0000-4000-8000-000000000003")
    vi.stubGlobal("fetch", routedFetch(log, { datasetId: "ds-2", pushOk: false, serverEntries: [fromServer] }))

    const result = await createSyncEngine(idb).sync()

    expect(log).toContain("clear")
    expect(result.errors).toBeGreaterThan(0)
    // Der Spiegel des offline geschriebenen Eintrags ist wieder da, der alte Bestand nicht
    const ids = (await idb.getAllEntries()).map((e) => e.id).sort()
    expect(ids).toEqual([local.id, fromServer.id].sort())
    expect((await idb.listQueue()).map((q) => q.entryId)).toEqual([local.id])
    expect(await idb.getMeta("datasetId")).toBe("ds-2")
  })

  it("Medien-Cache-Schlüssel (entryMedia:<id>) werden beim Neuabgleich verworfen, auch ohne lokalen Vorgänger", async () => {
    const { entryMediaMetaKey } = await import("@/lib/sync/entry-media-cache")
    const { idb, log } = stubWithLog()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    const entry = makeSyncEntry("20000000-0000-4000-8000-000000000001")
    await idb.putEntry(entry)
    await idb.setMeta(entryMediaMetaKey(entry.id), JSON.stringify({ media: ["stale"] }))
    vi.stubGlobal("fetch", routedFetch(log, { datasetId: "ds-2", serverEntries: [entry] }))
    await createSyncEngine(idb).sync()
    expect(await idb.getMeta(entryMediaMetaKey(entry.id))).toBeNull()
  })

  it("Schema-Backfill und Kennungswechsel zugleich → ein Full-Pull, danach beide Stempel", async () => {
    const { idb, log } = stubWithLog()
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    const fetchMock = routedFetch(log, { datasetId: "ds-2" })
    vi.stubGlobal("fetch", fetchMock)
    await createSyncEngine(idb).sync()
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/sync/changes"))).toHaveLength(1)
    expect(await idb.getMeta("schemaVersion")).toBe("3")
    expect(await idb.getMeta("datasetId")).toBe("ds-2")
  })

  it("Adapter ohne clearEntries (älterer Client-Code) → kein Absturz, Full-Pull und Stempel trotzdem", async () => {
    const idb = makeStubIDB()
    await idb.setMeta("schemaVersion", "3")
    await idb.setMeta("lastSync", storedLastSync)
    await idb.setMeta("datasetId", "ds-1")
    const log: string[] = []
    const fetchMock = routedFetch(log, { datasetId: "ds-2" })
    vi.stubGlobal("fetch", fetchMock)
    await expect(createSyncEngine(idb).sync()).resolves.toBeDefined()
    expect(await idb.getMeta("datasetId")).toBe("ds-2")
  })
})
