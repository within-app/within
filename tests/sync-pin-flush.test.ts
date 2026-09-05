/**
 * Pin-Sync in der Sync-Engine:
 *
 * - sync() pusht gequeue-te Pin-Ops nach dem Entry-Push (der Eintrag muss
 *   serverseitig existieren, sonst 404t der Pin-Endpoint — gleiche
 *   Reihenfolge-Logik wie flushMedia) und VOR dem Pull.
 * - Ops für Einträge, die noch in der editQueue hängen, werden übersprungen
 *   (bleiben queued für den nächsten Sync).
 * - 200/404/410 räumen den Op; Netz-/Serverfehler lassen ihn liegen.
 * - Der Pull wendet den Server-Pin-Zustand an (putPin/deletePin + Cache-
 *   Freigabe über den uncacheEntryMedia-Hook) — Details der Anwendungs-
 *   regeln in tests/pin-ops.test.ts.
 *
 * Nur synthetische Daten.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSyncEngine } from "../src/lib/sync/engine"
import type { IDBAdapter, PinnedEntry } from "../src/lib/sync/idb"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "../src/lib/sync/types"
import { PIN_OPS_META_KEY, queuePinOp, readPinOps } from "../src/lib/sync/pin-ops"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_A = "20000000-0000-4000-8000-000000000001"

function makeStubIDB() {
  const entries = new Map<string, SyncEntry>()
  const queue = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta = new Map<string, string>()
  const pins = new Map<string, PinnedEntry>()
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
    putPin: async (p) => { pins.set(p.entryId, p) },
    getPin: async (id) => pins.get(id),
    deletePin: async (id) => { pins.delete(id) },
    listPins: async () => [...pins.values()],
    putMediaLRU: async () => {},
    getMediaLRU: async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
  }
  return { idb, entries, queue, meta, pins }
}

function makeSyncEntry(id: string, over: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id, journalId: JOURNAL_ID, text: "Synthetic entry",
    createdAt: "2026-06-01T10:00:00.000Z", updatedAt: "2026-06-15T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
    ...over,
  }
}

interface FetchCall { url: string; init?: RequestInit }

interface FetchStubResult {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/** fetch-Mock: Settings-Probe 200, Pull leer, Pin-PUT konfigurierbar. */
function makeFetchMock(opts: {
  pinStatus?: number
  pullEntries?: SyncEntry[]
} = {}) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit): Promise<FetchStubResult> => {
    calls.push({ url, init })
    if (url.includes("/api/settings")) return { ok: true, status: 200, json: async () => ({}) }
    if (url.includes("/pin")) {
      const status = opts.pinStatus ?? 200
      return { ok: status < 300, status, json: async () => ({ ok: status < 300 }) }
    }
    if (url.includes("/api/sync/changes")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          entries: opts.pullEntries ?? [],
          nextCursor: null,
          serverTime: "2026-08-23T12:00:00.000Z",
        }),
      }
    }
    if (url.includes("/api/sync/upsert")) {
      return { ok: true, status: 200, json: async () => ({ accepted: [ENTRY_A], conflicts: [] }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  return { fn, calls }
}

describe("sync() flusht Pin-Ops", () => {
  let s: ReturnType<typeof makeStubIDB>
  beforeEach(() => { s = makeStubIDB() })
  afterEach(() => vi.restoreAllMocks())

  it("pusht einen gequeue-ten Pin-Op als PUT /api/entries/[id]/pin und räumt ihn bei 200", async () => {
    await queuePinOp(s.idb, ENTRY_A, true)
    const mock = makeFetchMock()
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()

    const pinCall = mock.calls.find((c) => c.url.includes(`/api/entries/${ENTRY_A}/pin`))
    expect(pinCall).toBeDefined()
    expect(pinCall?.init?.method).toBe("PUT")
    expect(JSON.parse(String(pinCall?.init?.body))).toEqual({ pinned: true })
    expect(await readPinOps(s.idb)).toEqual({})
  })

  it("überspringt Ops für Einträge, die noch in der editQueue hängen (Eintrag existiert serverseitig noch nicht)", async () => {
    // Push scheitert → Edit bleibt in der Queue → Pin-Op darf nicht gesendet werden.
    await s.idb.enqueueEdit({
      entryId: ENTRY_A, operation: "create",
      payload: makeSyncEntry(ENTRY_A), queuedAt: "2026-08-23T10:00:00.000Z",
    })
    await queuePinOp(s.idb, ENTRY_A, true)
    const mock = makeFetchMock()
    mock.fn.mockImplementation(async (url: string, init?: RequestInit): Promise<FetchStubResult> => {
      mock.calls.push({ url, init })
      if (url.includes("/api/settings")) return { ok: true, status: 200, json: async () => ({}) }
      if (url.includes("/api/sync/upsert")) return { ok: false, status: 500, json: async () => null }
      if (url.includes("/api/sync/changes")) {
        return { ok: true, status: 200, json: async () => ({ entries: [], nextCursor: null, serverTime: "2026-08-23T12:00:00.000Z" }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()

    expect(mock.calls.some((c) => c.url.includes("/pin"))).toBe(false)
    expect((await readPinOps(s.idb))[ENTRY_A]?.pinned).toBe(true)
  })

  it("Reihenfolge: Entry-Push (upsert) kommt vor dem Pin-Flush", async () => {
    await s.idb.enqueueEdit({
      entryId: ENTRY_A, operation: "create",
      payload: makeSyncEntry(ENTRY_A), queuedAt: "2026-08-23T10:00:00.000Z",
    })
    await queuePinOp(s.idb, ENTRY_A, true)
    const mock = makeFetchMock()
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()

    const upsertIdx = mock.calls.findIndex((c) => c.url.includes("/api/sync/upsert"))
    const pinIdx = mock.calls.findIndex((c) => c.url.includes("/pin"))
    expect(upsertIdx).toBeGreaterThanOrEqual(0)
    expect(pinIdx).toBeGreaterThan(upsertIdx)
  })

  it("404 räumt den Op (Eintrag serverseitig gelöscht — Absicht gegenstandslos)", async () => {
    await queuePinOp(s.idb, ENTRY_A, true)
    const mock = makeFetchMock({ pinStatus: 404 })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()
    expect(await readPinOps(s.idb)).toEqual({})
  })

  it("Server-/Netzfehler lässt den Op liegen — nächster Sync versucht erneut", async () => {
    await queuePinOp(s.idb, ENTRY_A, true)
    const mock = makeFetchMock({ pinStatus: 500 })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()
    expect((await readPinOps(s.idb))[ENTRY_A]?.pinned).toBe(true)
  })

  it("ROLLOUT-INTEGRATION (Flush scheitert): Bestands-Pin überlebt den ersten Sync trotz Pull-NULL", async () => {
    // Gerät hat einen Bestands-Pin; Server ist frisch migriert (pinned_at
    // überall NULL). Der Union-Upload wird versucht, scheitert aber (z. B.
    // 500) — und der Pull liefert den Eintrag mit NULL. Ohne Fail-safe wäre
    // der Pin jetzt weg: exakt „Update löscht alle Pins" (B14-Klasse). Der
    // noch offene Op muss den Pull-NULL überstimmen.
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    const uncached: string[] = []
    const mock = makeFetchMock({ pinStatus: 500, pullEntries: [makeSyncEntry(ENTRY_A, { pinnedAt: null })] })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb, "", undefined, {
      uncacheEntryMedia: async (id) => { uncached.push(id) },
    }).sync()

    // Union-Op wurde versucht …
    expect(mock.calls.some((c) => c.url.includes(`/api/entries/${ENTRY_A}/pin`))).toBe(true)
    // … der Pin hat den Sync überlebt, nichts wurde freigegeben.
    expect(s.pins.has(ENTRY_A)).toBe(true)
    expect(uncached).toEqual([])
    // Op liegt noch — der nächste Sync versucht es erneut.
    expect((await readPinOps(s.idb))[ENTRY_A]?.pinned).toBe(true)
  })

  it("ROLLOUT-INTEGRATION (Flush gelingt): Pull liefert danach pinnedAt gesetzt — mediaUrls bleiben erhalten", async () => {
    // Normalfall des ersten Syncs: Union-Op kommt durch, der eigene Bump
    // erscheint im selben Pull — der lokale Pin wird gemergt, nicht ersetzt.
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    const mock = makeFetchMock({ pullEntries: [makeSyncEntry(ENTRY_A, { pinnedAt: "2026-08-23T10:00:00.000Z" })] })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()

    const pin = s.pins.get(ENTRY_A)
    expect(pin?.mediaUrls).toEqual(["/media/a.jpg"])
    expect(pin?.pinnedAt).toBe("2026-08-23T10:00:00.000Z")
    expect(await readPinOps(s.idb)).toEqual({})
  })

  it("Pull wendet Server-Zustand an: pinnedAt gesetzt → Pin adoptiert; NULL → Pin weg + Cache freigegeben", async () => {
    // Initialisiert + keine offenen Ops (Normalbetrieb nach dem Rollout).
    const uncached: string[] = []
    const entryPinned = makeSyncEntry(ENTRY_A, { pinnedAt: "2026-08-23T10:00:00.000Z" })
    const mock1 = makeFetchMock({ pullEntries: [entryPinned] })
    vi.stubGlobal("fetch", mock1.fn)
    const engine = createSyncEngine(s.idb, "", undefined, {
      uncacheEntryMedia: async (id) => { uncached.push(id) },
    })
    await engine.sync()
    expect(s.pins.get(ENTRY_A)?.mediaUrlsPending).toBe(true)

    const entryUnpinned = makeSyncEntry(ENTRY_A, { pinnedAt: null, updatedAt: "2026-08-23T11:00:00.000Z" })
    const mock2 = makeFetchMock({ pullEntries: [entryUnpinned] })
    vi.stubGlobal("fetch", mock2.fn)
    await engine.sync()

    expect(s.pins.has(ENTRY_A)).toBe(false)
    expect(uncached).toEqual([ENTRY_A])
  })

  it("Tombstone räumt Pin UND offenen Pin-Op ab", async () => {
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [] })
    await s.idb.setMeta(PIN_OPS_META_KEY, JSON.stringify({ [ENTRY_A]: { pinned: true, queuedAt: "2026-08-23T10:00:00.000Z" } }))
    const tombstone = makeSyncEntry(ENTRY_A, { deletedAt: "2026-08-23T11:00:00.000Z" })
    const mock = makeFetchMock({ pullEntries: [tombstone], pinStatus: 404 })
    vi.stubGlobal("fetch", mock.fn)

    await createSyncEngine(s.idb).sync()

    expect(s.pins.has(ENTRY_A)).toBe(false)
    expect(await readPinOps(s.idb)).toEqual({})
  })
})
