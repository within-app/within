/**
 * Push-Dequeue-Race:
 *
 * applyPushResult löschte akzeptierte Edits UNBEDINGT aus der editQueue. Ein
 * Edit, der WÄHREND des laufenden Push-Requests neu enqueued wurde (30-s-
 * Autosave, Cmd+Enter, zweiter Tab — enqueueEdit ersetzt per keyPath), wurde
 * damit ungesehen mitgelöscht: Der Server hat v1, v2 existiert nirgendwo mehr,
 * der folgende Pull überschreibt auch den lokalen Spiegel — stiller
 * Datenverlust im Normalbetrieb (Reconnect-Sync bei offenem Editor).
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function makeEntry(id: string, text: string, updatedAt: string): SyncEntry {
  return {
    id,
    journalId: "20000000-0000-4000-8000-000000000001",
    text,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt,
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false,
    tags: [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

function makeQueueIdb() {
  const queue = new Map<string, QueuedEdit>()
  const idb = {
    listQueue: async () => [...queue.values()],
    enqueueEdit: async (edit: QueuedEdit) => {
      queue.set(edit.entryId, edit)
    },
    dequeueEdit: async (entryId: string) => {
      queue.delete(entryId)
    },
    getMeta: async () => null,
    setMeta: async () => {},
    getEntry: async () => undefined,
    putEntry: async () => {},
    deleteEntry: async () => {},
    putConflict: async () => {},
    listConflicts: async () => [],
    clearConflict: async () => {},
    getJournals: async () => [{ id: "20000000-0000-4000-8000-000000000001", name: "QA", color: "#000" }],
    // kein listOutboxMedia → flushMedia ist ein No-op
  } as unknown as IDBAdapter
  return { idb, queue }
}

describe("Push-Dequeue-Race (B02)", () => {
  it("ein während des Push-Requests neu enqueuter Edit überlebt das Accepted-Dequeue", async () => {
    const { idb, queue } = makeQueueIdb()
    const v1: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    }
    await idb.enqueueEdit(v1)
    const v2: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v2", "2026-08-01T10:05:00.000Z"),
      queuedAt: "2026-08-01T10:05:00.000Z",
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        // Editor speichert v2, WÄHREND der Push-Request von v1 unterwegs ist.
        await idb.enqueueEdit(v2)
        return jsonResponse(200, { accepted: ["e1"], conflicts: [] })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    // v2 muss die Runde überleben — der nächste Push liefert ihn nach.
    expect(queue.get("e1")?.payload?.text).toBe("v2")
  })

  it("Konflikt-Pfad: ein während des Requests neu enqueuter Edit überlebt ebenfalls", async () => {
    const { idb, queue } = makeQueueIdb()
    const v1: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    }
    await idb.enqueueEdit(v1)
    const v2: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v2", "2026-08-01T10:05:00.000Z"),
      queuedAt: "2026-08-01T10:05:00.000Z",
    }
    const serverVersion = makeEntry("e1", "server", "2026-08-01T10:04:00.000Z")

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        await idb.enqueueEdit(v2)
        return jsonResponse(200, {
          accepted: [],
          conflicts: [{ entryId: "e1", serverVersion }],
        })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    expect(queue.get("e1")?.payload?.text).toBe("v2")
  })

  // Der 400-Zweig in handleRejectedEntry
  // dequeuete UNBEDINGT — ohne den Guard, den accepted/conflict schon haben.
  // Antwortet der Server für v1 mit 400, sicherte putConflict v1 und
  // dequeueEdit entfernte v2 aus der Queue; restoreConflict brächte nur v1
  // zurück — der einzige Recovery-Pfad hätte v2 mit v1 überschrieben.
  it("400-Pfad: ein während des Requests neu enqueuter Edit überlebt; die Konfliktkopie trägt v1", async () => {
    const { idb, queue } = makeQueueIdb()
    const conflicts: Array<{ text: string; entryId: string }> = []
    ;(idb as unknown as { putConflict: (c: { text: string; entryId: string }) => Promise<void> }).putConflict =
      async (c) => { conflicts.push({ text: c.text, entryId: c.entryId }) }
    const v1: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    }
    await idb.enqueueEdit(v1)
    const v2: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v2", "2026-08-01T10:05:00.000Z"),
      queuedAt: "2026-08-01T10:05:00.000Z",
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        // Editor speichert v2, WÄHREND der Push-Request von v1 unterwegs ist —
        // und der Server lehnt v1 dauerhaft ab.
        await idb.enqueueEdit(v2)
        return jsonResponse(400, { error: "invalid" })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    const result = await engine.sync()

    // v1 ist als Konfliktkopie gesichert, v2 bleibt in der Queue — der nächste Push liefert ihn.
    expect(conflicts).toEqual([{ text: "v1", entryId: "e1" }])
    expect(queue.get("e1")?.payload?.text).toBe("v2")
    expect(result.errors).toBe(1)
  })

  it("400-Pfad ohne Zwischen-Edit: Konfliktkopie gesichert und der Edit dequeued (Semantik unverändert)", async () => {
    const { idb, queue } = makeQueueIdb()
    const conflicts: string[] = []
    ;(idb as unknown as { putConflict: (c: { text: string }) => Promise<void> }).putConflict =
      async (c) => { conflicts.push(c.text) }
    await idb.enqueueEdit({
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) return jsonResponse(400, { error: "invalid" })
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    expect(conflicts).toEqual(["v1"])
    expect(queue.has("e1")).toBe(false)
  })

  it("400-Pfad: Re-Enqueue mit identischem Text (Metadaten-Speichern) → Zeile bleibt, keine zweite Konfliktkopie", async () => {
    const { idb, queue } = makeQueueIdb()
    const conflicts: string[] = []
    ;(idb as unknown as { putConflict: (c: { text: string }) => Promise<void> }).putConflict =
      async (c) => { conflicts.push(c.text) }
    await idb.enqueueEdit({
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    })
    // Stern/Tag gesetzt: gleicher Text, neue Zeile — würde pro Sync-Lauf eine
    // weitere identische Konfliktkopie erzeugen, wenn die Kopie unbedingt käme.
    const v1b: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: { ...makeEntry("e1", "v1", "2026-08-01T10:05:00.000Z"), starred: true },
      queuedAt: "2026-08-01T10:05:00.000Z",
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        await idb.enqueueEdit(v1b)
        return jsonResponse(400, { error: "invalid" })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    expect(conflicts).toEqual([])
    expect(queue.get("e1")?.payload?.starred).toBe(true)
  })

  it("Batch-Poison-Fallback: e1 mit 400 + Re-Enqueue behält v2 und sichert v1, e2 wird akzeptiert und dequeued", async () => {
    const { idb, queue } = makeQueueIdb()
    const conflicts: string[] = []
    ;(idb as unknown as { putConflict: (c: { text: string }) => Promise<void> }).putConflict =
      async (c) => { conflicts.push(c.text) }
    for (const id of ["e1", "e2"]) {
      await idb.enqueueEdit({
        entryId: id,
        operation: "update",
        payload: makeEntry(id, "v1", "2026-08-01T10:00:00.000Z"),
        queuedAt: "2026-08-01T10:00:00.000Z",
      })
    }
    const v2: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v2", "2026-08-01T10:05:00.000Z"),
      queuedAt: "2026-08-01T10:05:00.000Z",
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        const sent = (JSON.parse(String(init?.body)) as { entries: SyncEntry[] }).entries
        // Batch mit beiden → 500 (Batch-Poison), danach einzeln.
        if (sent.length === 2) return jsonResponse(500, { error: "boom" })
        if (sent[0].id === "e1") {
          await idb.enqueueEdit(v2)
          return jsonResponse(400, { error: "invalid" })
        }
        return jsonResponse(200, { accepted: ["e2"], conflicts: [] })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    const result = await engine.sync()

    expect(conflicts).toEqual(["v1"])
    expect(queue.get("e1")?.payload?.text).toBe("v2")
    expect(queue.has("e2")).toBe(false)
    expect(result.pushed).toBe(1)
    expect(result.errors).toBe(1)
  })

  it("gleiche Millisekunde, nur Metadaten anders (revisionId/tags): der neue Edit überlebt das Accepted-Dequeue", async () => {
    const { idb, queue } = makeQueueIdb()
    const base = makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z")
    await idb.enqueueEdit({ entryId: "e1", operation: "update", payload: base, queuedAt: "2026-08-01T10:00:00.000Z" })
    const sameMs: QueuedEdit = {
      entryId: "e1",
      operation: "update",
      payload: { ...base, revisionId: "30000000-0000-4000-8000-000000000002", tags: ["neu"] },
      queuedAt: "2026-08-01T10:00:00.000Z",
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) {
        await idb.enqueueEdit(sameMs)
        return jsonResponse(200, { accepted: ["e1"], conflicts: [] })
      }
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    expect(queue.get("e1")?.payload?.tags).toEqual(["neu"])
  })

  it("ohne Zwischen-Edit wird der akzeptierte Edit normal dequeued", async () => {
    const { idb, queue } = makeQueueIdb()
    await idb.enqueueEdit({
      entryId: "e1",
      operation: "update",
      payload: makeEntry("e1", "v1", "2026-08-01T10:00:00.000Z"),
      queuedAt: "2026-08-01T10:00:00.000Z",
    })

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/upsert")) return jsonResponse(200, { accepted: ["e1"], conflicts: [] })
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:06:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const engine = createSyncEngine(idb)
    await engine.sync()

    expect(queue.has("e1")).toBe(false)
  })
})
