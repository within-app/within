/**
 * Push ohne Retry-Sturm:
 *
 * Schlug der Batch-Upsert fehl, fächerte push() bei JEDEM Status pro Eintrag in
 * Einzel-Requests auf — auch bei 401 (Session weg), 429 (Rate-Limit), 5xx (Pi
 * überlastet) und 0 (Netzabriss). 50 Einträge = 50 weitere Requests, die genauso
 * scheitern. Jetzt: Einzel-Fallback nur bei 400/422 (Batch-Poison, ein kaputter
 * Eintrag); alles andere bricht die Batch-Schleife ab, die Einträge bleiben in
 * der Queue, der nächste Trigger wiederholt.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createSyncEngine } from "@/lib/sync/engine"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { QueuedEdit, SyncEntry } from "@/lib/sync/types"

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

const JOURNAL_ID = "20000000-0000-4000-8000-000000000001"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function makeEntry(n: number): SyncEntry {
  const id = `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  return {
    id, journalId: JOURNAL_ID, text: `synthetic ${n}`,
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:05:00.000Z",
    revisionId: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
  }
}

function makeQueueIdb(count: number) {
  const queue = new Map<string, QueuedEdit>()
  const conflicts: unknown[] = []
  for (let n = 1; n <= count; n++) {
    const payload = makeEntry(n)
    queue.set(payload.id, { entryId: payload.id, operation: "update", payload, queuedAt: payload.updatedAt })
  }
  const idb = {
    listQueue: async () => [...queue.values()],
    enqueueEdit: async (edit: QueuedEdit) => { queue.set(edit.entryId, edit) },
    dequeueEdit: async (entryId: string) => { queue.delete(entryId) },
    getMeta: async () => null,
    setMeta: async () => {},
    getEntry: async () => undefined,
    putEntry: async () => {},
    deleteEntry: async () => {},
    putConflict: async (c: unknown) => { conflicts.push(c) },
    listConflicts: async () => [],
    clearConflict: async () => {},
    getJournals: async () => [{ id: JOURNAL_ID, name: "QA", color: "#000" }],
  } as unknown as IDBAdapter
  return { idb, queue, conflicts }
}

/** Zählt die Upsert-Requests und antwortet jedem mit `status` (0 = Netzabriss). */
function stubUpsert(status: number) {
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.endsWith("/api/sync/upsert")) return jsonResponse(200, [])
    if (status === 0) throw new TypeError("Failed to fetch")
    return jsonResponse(status, { error: "synthetic" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/sync/upsert")).length
}

describe("push() — kein Einzel-Fallback bei transienten Batch-Fehlern", () => {
  it.each([0, 401, 403, 429, 503])("Status %s: ein Request, Einträge bleiben in der Queue", async (status) => {
    const { idb, queue, conflicts } = makeQueueIdb(3)
    const upsertCalls = stubUpsert(status)

    const result = await createSyncEngine(idb).push()

    expect(upsertCalls()).toBe(1)
    expect(queue.size).toBe(3)
    expect(conflicts).toHaveLength(0)
    expect(result.accepted).toHaveLength(0)
    expect(result.errors).toHaveLength(3)
  })

  it("5xx im ersten Batch: der zweite Batch wird gar nicht erst gesendet", async () => {
    const { idb, queue } = makeQueueIdb(51)
    const upsertCalls = stubUpsert(503)

    await createSyncEngine(idb).push()

    expect(upsertCalls()).toBe(1)
    expect(queue.size).toBe(51)
  })

  it("400 (Batch-Poison) fällt weiterhin pro Eintrag zurück", async () => {
    const { idb, queue, conflicts } = makeQueueIdb(2)
    const good = makeEntry(2).id
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/sync/upsert")) return jsonResponse(200, [])
      const { entries } = JSON.parse(String(init?.body)) as { entries: SyncEntry[] }
      if (entries.length === 1 && entries[0].id === good) return jsonResponse(200, { accepted: [good], conflicts: [] })
      return jsonResponse(400, { error: "validation_error" })
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await createSyncEngine(idb).push()

    // 1 Batch + 2 Einzel-Requests
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/sync/upsert"))).toHaveLength(3)
    expect(result.accepted).toEqual([good])
    expect(queue.size).toBe(0)          // der kaputte Eintrag ist als Konfliktkopie gesichert und dequeued
    expect(conflicts).toHaveLength(1)
  })
})
