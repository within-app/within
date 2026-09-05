/**
 * deleteEntryWithOfflineFallback (Regression: offline löschen ging
 * nicht — beide Delete-Handler fetchten direkt und landeten offline im catch).
 * Online wird direkt gelöscht (404 = idempotent erledigt) und ein evtl. noch
 * gequeuter Create/Update dequeued; offline wandert ein delete-Tombstone in
 * die Edit-Queue und der lokale Spiegel wird aufgeräumt. Synthetic data only.
 */

import { describe, it, expect, vi } from "vitest"
import { deleteEntryWithOfflineFallback } from "../src/lib/sync/delete-entry"
import type { IDBAdapter } from "../src/lib/sync/idb"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "../src/lib/sync/types"

const ENTRY_ID = "20000000-0000-4000-8000-000000000001"

function makeStubIDB(outbox: OutboxMedia[] = []) {
  const entries = new Map<string, SyncEntry>()
  const queue   = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta    = new Map<string, string>()
  const outboxItems = new Map(outbox.map((o) => [o.id, o]))
  const idb: IDBAdapter = {
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
    putPin:        async () => {},
    getPin:        async () => undefined,
    deletePin:     async () => {},
    listPins:      async () => [],
    putMediaLRU:   async () => {},
    getMediaLRU:   async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
    listOutboxMediaForEntry: async (entryId) =>
      [...outboxItems.values()].filter((o) => o.entryId === entryId),
    deleteOutboxMedia: async (id) => { outboxItems.delete(id) },
  }
  return { idb, entries, queue, meta, outboxItems }
}

function seedEntry(entries: Map<string, SyncEntry>) {
  entries.set(ENTRY_ID, {
    id: ENTRY_ID, journalId: "10000000-0000-4000-8000-000000000001",
    text: "Synthetic", createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
  })
}

describe("deleteEntryWithOfflineFallback", () => {
  it("online: deletes server-side, dequeues a pending edit, cleans the local mirror", async () => {
    const { idb, entries, queue, meta } = makeStubIDB()
    seedEntry(entries)
    meta.set(`entryMedia:${ENTRY_ID}`, "[]")
    // A queued offline create must not survive the delete — the next push
    // would otherwise resurrect the entry server-side.
    queue.set(ENTRY_ID, { entryId: ENTRY_ID, operation: "create", payload: null, queuedAt: "x" })
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch

    const result = await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)

    expect(result).toBe("deleted")
    expect(queue.size).toBe(0)
    expect(entries.size).toBe(0)
    expect(meta.size).toBe(0)
  })

  it("online: 404 counts as success — entry never reached the server", async () => {
    const { idb, entries } = makeStubIDB()
    seedEntry(entries)
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch

    expect(await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)).toBe("deleted")
    expect(entries.size).toBe(0)
  })

  it("server error: fails without queueing and keeps the local entry", async () => {
    const { idb, entries, queue } = makeStubIDB()
    seedEntry(entries)
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch

    expect(await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)).toBe("failed")
    expect(queue.size).toBe(0)
    expect(entries.size).toBe(1)
  })

  it("offline: queues a delete tombstone and removes the local mirror", async () => {
    const { idb, entries, queue } = makeStubIDB()
    seedEntry(entries)
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch

    const result = await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)

    expect(result).toBe("queued")
    expect(queue.get(ENTRY_ID)).toMatchObject({ operation: "delete", payload: null })
    expect(entries.size).toBe(0)
  })

  it("offline: a delete tombstone replaces a queued offline create (keyPath entryId)", async () => {
    const { idb, queue } = makeStubIDB()
    queue.set(ENTRY_ID, { entryId: ENTRY_ID, operation: "create", payload: null, queuedAt: "x" })
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch

    await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)

    expect(queue.size).toBe(1)
    expect(queue.get(ENTRY_ID)?.operation).toBe("delete")
  })

  it("removes waiting outbox files for the entry on both paths", async () => {
    const outboxItem = { id: "ob-1", entryId: ENTRY_ID } as OutboxMedia
    const { idb, outboxItems } = makeStubIDB([outboxItem])
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch

    await deleteEntryWithOfflineFallback(ENTRY_ID, idb, fetchFn)

    expect(outboxItems.size).toBe(0)
  })
})

describe("deleteOutcomeUi (B06)", () => {
  // Bis B06 schluckte die Detailansicht ein fehlgeschlagenes Löschen komplett:
  // Dialog zu, Eintrag bleibt, keine Meldung — der Nutzer hielt es für erledigt.
  it("failed → Fehler anzeigen, Ansicht nicht verlassen", async () => {
    const { deleteOutcomeUi } = await import("../src/lib/sync/delete-entry")
    expect(deleteOutcomeUi("failed")).toEqual({ leaveView: false, showError: true })
  })
  it("deleted/queued → Ansicht verlassen, kein Fehler", async () => {
    const { deleteOutcomeUi } = await import("../src/lib/sync/delete-entry")
    expect(deleteOutcomeUi("deleted")).toEqual({ leaveView: true, showError: false })
    expect(deleteOutcomeUi("queued")).toEqual({ leaveView: true, showError: false })
  })
})
