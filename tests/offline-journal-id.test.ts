/**
 * Offline create → sync split-brain, root cause.
 *
 * Offline, /api/journals fails, so the editor's journal list stays empty and
 * entry-editor.tsx falls back to `journals[0]?.id ?? ""`. The edit is queued
 * locally with journalId "" and POST /api/sync/upsert rejects it with 400
 * "Invalid UUID" on every retry — the entry never leaves the device.
 *
 * Covered here:
 *   1. the regression itself (empty journal list ⇒ server rejects)
 *   2. loadJournals() serving the cached list offline (prevention)
 *   3. push() repairing already-queued broken edits (data rescue)
 *
 * Synthetic data only (Constraint D).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db/sync", () => ({ upsertEntries: vi.fn() }))

import { upsertEntries } from "../src/lib/db/sync"
import { POST } from "../src/app/api/sync/upsert/route"
import { NextRequest } from "next/server"
import { buildQueuedEdit } from "../src/lib/sync/queue-edit"
import { loadJournals } from "../src/lib/journals/load-journals"
import { repairQueueJournalIds, isUsableJournalId } from "../src/lib/sync/repair-queue"
import { createSyncEngine } from "../src/lib/sync/engine"
import type { IDBAdapter } from "../src/lib/sync/idb"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "../src/lib/sync/types"
import type { Journal } from "../src/types/journal"

/** Minimal localStorage for the node test environment (legacy cache fallback). */
const memoryStorage = (() => {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
})()
vi.stubGlobal("localStorage", memoryStorage)

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

const JOURNAL: Journal = { id: JOURNAL_ID, name: "Tagebuch", color: "#334155", entryCount: 3 }

const editorPayload = (journalId: string) => ({
  text: "Offline geschriebener Eintrag",
  journalId,
  createdAt: "2026-07-27T08:00:00.000Z",
  starred: false,
  tags: [],
  photos: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
})

async function upsert(entries: unknown[]) {
  return POST(
    new NextRequest("http://localhost/api/sync/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    })
  )
}

function makeStubIDB(journals: Journal[] = []): IDBAdapter {
  const entries = new Map<string, SyncEntry>()
  const queue = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta = new Map<string, string>()
  let journalCache = [...journals]
  return {
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
    putJournals: async (j) => { journalCache = [...j] },
    getJournals: async () => [...journalCache],
  }
}

describe("root cause — offline journalId", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    localStorage.clear()
    vi.mocked(upsertEntries).mockResolvedValue({ accepted: [], conflicts: [] })
  })

  it("REGRESSION: an empty journal list produces an edit the server rejects with 400", async () => {
    const journals: Journal[] = [] // offline: /api/journals failed
    const edit = buildQueuedEdit({
      payload: editorPayload(journals[0]?.id ?? ""), // entry-editor.tsx:49-50
      queuedAt: "2026-07-27T08:00:00.000Z",
    })

    const res = await upsert([edit.payload])
    const body = (await res.json()) as { details?: Array<{ field: string; message: string }> }

    expect(res.status).toBe(400)
    expect(body.details?.[0]?.field).toBe("entries.0.journalId")
  })

  it("a cached journal id makes the very same offline edit acceptable", async () => {
    const edit = buildQueuedEdit({
      payload: editorPayload(JOURNAL_ID),
      queuedAt: "2026-07-27T08:00:00.000Z",
    })

    expect((await upsert([edit.payload])).status).toBe(200)
  })
})

describe("loadJournals()", () => {
  beforeEach(() => { localStorage.clear() })

  it("caches the list when online", async () => {
    const idb = makeStubIDB()
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([JOURNAL]), { status: 200 })
    ) as unknown as typeof globalThis.fetch

    expect(await loadJournals({ fetchFn, idb })).toEqual([JOURNAL])
    expect(await idb.getJournals?.()).toEqual([JOURNAL])
  })

  it("serves the cached list when the fetch fails offline", async () => {
    const idb = makeStubIDB([JOURNAL])
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof globalThis.fetch

    expect(await loadJournals({ fetchFn, idb })).toEqual([JOURNAL])
  })

  it("ignores the legacy localStorage cache (Journalnamen nur noch verschlüsselt in IDB)", async () => {
    const idb = makeStubIDB()
    localStorage.setItem("within.journals.cache", JSON.stringify([JOURNAL]))
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof globalThis.fetch

    expect(await loadJournals({ fetchFn, idb })).toEqual([])
  })

  it("returns an empty list rather than throwing when nothing is available", async () => {
    const idb = makeStubIDB()
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof globalThis.fetch

    expect(await loadJournals({ fetchFn, idb })).toEqual([])
  })
})

describe("repairQueueJournalIds()", () => {
  const brokenEdit = (entryId: string): QueuedEdit => ({
    entryId,
    operation: "create",
    payload: { ...editorPayload(""), id: entryId, updatedAt: "2026-07-27T08:00:00.000Z", revisionId: "40000000-0000-4000-8000-000000000001", deletedAt: null, thumbnailDataUrl: null } as SyncEntry,
    queuedAt: "2026-07-27T08:00:00.000Z",
  })

  it("rewrites an empty journalId to the fallback journal", () => {
    const { repaired, unrepairable } = repairQueueJournalIds([brokenEdit("e1")], JOURNAL_ID)

    expect(unrepairable).toEqual([])
    expect(repaired[0].payload?.journalId).toBe(JOURNAL_ID)
  })

  it("leaves valid edits untouched", () => {
    const valid: QueuedEdit = {
      ...brokenEdit("e2"),
      payload: { ...brokenEdit("e2").payload!, journalId: JOURNAL_ID },
    }

    expect(repairQueueJournalIds([valid], JOURNAL_ID).repaired).toEqual([])
  })

  it("reports edits as unrepairable when no journal is known", () => {
    const { repaired, unrepairable } = repairQueueJournalIds([brokenEdit("e3")], null)

    expect(repaired).toEqual([])
    expect(unrepairable).toEqual(["e3"])
  })

  it("rejects non-UUID journal ids", () => {
    expect(isUsableJournalId("")).toBe(false)
    expect(isUsableJournalId(undefined)).toBe(false)
    expect(isUsableJournalId("undefined")).toBe(false)
    expect(isUsableJournalId(JOURNAL_ID)).toBe(true)
  })
})

describe("push() rescues already-queued broken edits", () => {
  // buildQueuedEdit() uses the same UUID for entryId and payload.id — keep that
  // invariant, the engine dequeues by the id the server echoes back.
  const brokenPayload = (id: string): SyncEntry => ({
    id,
    journalId: "",
    text: "Vor dem Fix offline geschrieben",
    createdAt: "2026-07-26T20:00:00.000Z",
    updatedAt: "2026-07-26T20:00:00.000Z",
    revisionId: "40000000-0000-4000-8000-000000000002",
    starred: false,
    tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  })

  it("repairs from the cached journal list and the server accepts the entry", async () => {
    const idb = makeStubIDB([JOURNAL])
    await idb.enqueueEdit({
      entryId: "50000000-0000-4000-8000-000000000001",
      operation: "create",
      payload: brokenPayload("50000000-0000-4000-8000-000000000001"),
      queuedAt: "2026-07-26T20:00:00.000Z",
    })

    let sentJournalId: string | undefined
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { entries: SyncEntry[] }
      sentJournalId = body.entries[0].journalId
      return new Response(
        JSON.stringify({ accepted: [body.entries[0].id], conflicts: [], errors: [] }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createSyncEngine(idb).push()

    expect(sentJournalId).toBe(JOURNAL_ID)
    expect(result.errors).toEqual([])
    expect(await idb.listQueue()).toEqual([]) // dequeued = it reached the server
    vi.unstubAllGlobals()
  })

  it("fetches the journal list when the cache is still empty", async () => {
    const idb = makeStubIDB([]) // cache not populated yet — sync raced the page load
    await idb.enqueueEdit({
      entryId: "50000000-0000-4000-8000-000000000002",
      operation: "create",
      payload: brokenPayload("50000000-0000-4000-8000-000000000002"),
      queuedAt: "2026-07-26T20:00:00.000Z",
    })

    let sentJournalId: string | undefined
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/journals")) {
        return new Response(JSON.stringify([JOURNAL]), { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as { entries: SyncEntry[] }
      sentJournalId = body.entries[0].journalId
      return new Response(
        JSON.stringify({ accepted: [body.entries[0].id], conflicts: [], errors: [] }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchSpy)

    await createSyncEngine(idb).push()

    expect(sentJournalId).toBe(JOURNAL_ID)
    vi.unstubAllGlobals()
  })

  it("keeps the entry queued and reports an error when no journal can be resolved", async () => {
    const idb = makeStubIDB([])
    await idb.enqueueEdit({
      entryId: "50000000-0000-4000-8000-000000000003",
      operation: "create",
      payload: brokenPayload("50000000-0000-4000-8000-000000000003"),
      queuedAt: "2026-07-26T20:00:00.000Z",
    })

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    const result = await createSyncEngine(idb).push()

    expect(result.errors.map((e) => e.entryId)).toEqual(["50000000-0000-4000-8000-000000000003"])
    expect(await idb.listQueue()).toHaveLength(1) // never silently dropped
    vi.unstubAllGlobals()
  })
})
