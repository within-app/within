/**
 * Conflict restore/dismiss operation tests.
 * Tests the pure IDB operations from @/lib/sync/conflict-ops.
 * Uses an in-memory IDBAdapter stub — synthetic data only.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { restoreConflict, dismissConflict } from "@/lib/sync/conflict-ops"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { SyncEntry, QueuedEdit, ConflictCopy } from "@/lib/sync/types"

function makeStubIDB(): IDBAdapter & {
  _entries: Map<string, SyncEntry>
  _queue: Map<string, QueuedEdit>
  _conflicts: Map<string, ConflictCopy>
} {
  const entries = new Map<string, SyncEntry>()
  const queue = new Map<string, QueuedEdit>()
  const conflicts = new Map<string, ConflictCopy>()
  const meta = new Map<string, string>()
  return {
    _entries: entries,
    _queue: queue,
    _conflicts: conflicts,
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

const JOURNAL_ID  = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID    = "20000000-0000-4000-8000-000000000001"
const CONFLICT_ID = "50000000-0000-4000-8000-000000000001"

function makeSyncEntry(id: string): SyncEntry {
  return {
    id,
    journalId: JOURNAL_ID,
    text: "Current entry text",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false,
    tags: ["journal"],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

function makeConflictCopy(id: string, entryId: string): ConflictCopy {
  return {
    id,
    entryId,
    revisionId: "40000000-0000-4000-8000-000000000001",
    text: "Conflicted version text",
    updatedAt: "2026-06-30T09:00:00.000Z",
    savedAt: "2026-07-01T10:05:00.000Z",
    tags: ["draft"],
  }
}

describe("restoreConflict()", () => {
  let idb: ReturnType<typeof makeStubIDB>

  beforeEach(() => { idb = makeStubIDB() })

  it("enqueues an update edit with conflict text and tags", async () => {
    await idb.putEntry(makeSyncEntry(ENTRY_ID))
    const conflict = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    await idb.putConflict(conflict)

    await restoreConflict(idb, conflict)

    const queue = await idb.listQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].entryId).toBe(ENTRY_ID)
    expect(queue[0].operation).toBe("update")
    expect(queue[0].payload?.text).toBe("Conflicted version text")
    expect(queue[0].payload?.tags).toEqual(["draft"])
  })

  it("preserves current-entry metadata in the enqueued payload", async () => {
    await idb.putEntry(makeSyncEntry(ENTRY_ID))
    const conflict = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    await idb.putConflict(conflict)

    await restoreConflict(idb, conflict)

    const queue = await idb.listQueue()
    expect(queue[0].payload?.journalId).toBe(JOURNAL_ID)
    expect(queue[0].payload?.createdAt).toBe("2026-06-01T10:00:00.000Z")
    expect(queue[0].payload?.starred).toBe(false)
  })

  it("enqueued payload has a newer updatedAt than the conflict", async () => {
    await idb.putEntry(makeSyncEntry(ENTRY_ID))
    const conflict = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    await idb.putConflict(conflict)

    const before = new Date().toISOString()
    await restoreConflict(idb, conflict)
    const after = new Date().toISOString()

    const queue = await idb.listQueue()
    const updatedAt = queue[0].payload?.updatedAt ?? ""
    expect(updatedAt >= before).toBe(true)
    expect(updatedAt <= after).toBe(true)
  })

  it("clears the conflict record after enqueuing", async () => {
    await idb.putEntry(makeSyncEntry(ENTRY_ID))
    const conflict = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    await idb.putConflict(conflict)

    await restoreConflict(idb, conflict)

    expect(await idb.listConflicts()).toHaveLength(0)
  })

  it("does not enqueue if the entry is not in IDB, but still clears the conflict", async () => {
    const conflict = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    await idb.putConflict(conflict)

    await restoreConflict(idb, conflict)

    expect(await idb.listQueue()).toHaveLength(0)
    expect(await idb.listConflicts()).toHaveLength(0)
  })

  it("leaves sibling conflicts untouched", async () => {
    const OTHER_ENTRY_ID    = "20000000-0000-4000-8000-000000000002"
    const OTHER_CONFLICT_ID = "50000000-0000-4000-8000-000000000002"
    await idb.putEntry(makeSyncEntry(ENTRY_ID))
    const c1 = makeConflictCopy(CONFLICT_ID, ENTRY_ID)
    const c2 = makeConflictCopy(OTHER_CONFLICT_ID, OTHER_ENTRY_ID)
    await idb.putConflict(c1)
    await idb.putConflict(c2)

    await restoreConflict(idb, c1)

    const remaining = await idb.listConflicts()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(OTHER_CONFLICT_ID)
  })
})

describe("dismissConflict()", () => {
  let idb: ReturnType<typeof makeStubIDB>

  beforeEach(() => { idb = makeStubIDB() })

  it("removes the conflict record from IDB", async () => {
    await idb.putConflict(makeConflictCopy(CONFLICT_ID, ENTRY_ID))

    await dismissConflict(idb, CONFLICT_ID)

    expect(await idb.listConflicts()).toHaveLength(0)
  })

  it("does not enqueue any edits", async () => {
    await idb.putConflict(makeConflictCopy(CONFLICT_ID, ENTRY_ID))

    await dismissConflict(idb, CONFLICT_ID)

    expect(await idb.listQueue()).toHaveLength(0)
  })

  it("leaves sibling conflicts untouched", async () => {
    const OTHER_CONFLICT_ID = "50000000-0000-4000-8000-000000000002"
    await idb.putConflict(makeConflictCopy(CONFLICT_ID, ENTRY_ID))
    await idb.putConflict(makeConflictCopy(OTHER_CONFLICT_ID, ENTRY_ID))

    await dismissConflict(idb, CONFLICT_ID)

    const remaining = await idb.listConflicts()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(OTHER_CONFLICT_ID)
  })
})
