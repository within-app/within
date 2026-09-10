/**
 * Klasse D — Konflikt bei gleichem Text, aber anderen Metadaten:
 *
 * Gerät A ergänzt offline nur einen Tag und einen Stern (Text gleich), Gerät B
 * bumpt updated_at (z. B. Foto gelöscht), A pusht und verliert LWW. Ein
 * „gleicher Text = Phantom"-Kurzschluss im Client hätte hier die Konfliktkopie
 * unterdrückt — Tag und Stern wären still weg. Verlorene Antworten fängt der
 * Server über revisionId ab (upsert-idempotent-retry.test.ts); der Client
 * legt bei JEDEM gemeldeten Konflikt die Kopie an.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createSyncEngine } from "@/lib/sync/engine"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { ConflictCopy, QueuedEdit, SyncEntry } from "@/lib/sync/types"

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

const ENTRY_ID = "40000000-0000-4000-8000-000000000001"

function makeEntry(over: Partial<SyncEntry>): SyncEntry {
  return {
    id: ENTRY_ID, journalId: "20000000-0000-4000-8000-000000000001", text: "same text",
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
    ...over,
  }
}

describe("applyPushResult — Konflikt mit gleichem Text, anderen Tags/Stern", () => {
  it("legt trotzdem eine Konfliktkopie mit den lokalen Tags an", async () => {
    const local = makeEntry({ tags: ["wichtig"], starred: true })
    const server = makeEntry({
      updatedAt: "2026-08-01T10:00:01.000Z",
      revisionId: "30000000-0000-4000-8000-000000000002",
    })
    const queue = new Map<string, QueuedEdit>([[ENTRY_ID, { entryId: ENTRY_ID, operation: "update", payload: local, queuedAt: local.updatedAt }]])
    const conflictCopies: ConflictCopy[] = []
    const idb = {
      listQueue: async () => [...queue.values()],
      enqueueEdit: async (edit: QueuedEdit) => { queue.set(edit.entryId, edit) },
      dequeueEdit: async (entryId: string) => { queue.delete(entryId) },
      getMeta: async () => null,
      setMeta: async () => {},
      getEntry: async () => local,
      putEntry: async () => {},
      deleteEntry: async () => {},
      putConflict: async (c: ConflictCopy) => { conflictCopies.push(c) },
      listConflicts: async () => conflictCopies,
      clearConflict: async () => {},
    } as unknown as IDBAdapter
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ accepted: [], conflicts: [{ entryId: ENTRY_ID, serverVersion: server }] }), { status: 200 })
    ))

    const result = await createSyncEngine(idb).push()

    expect(conflictCopies).toHaveLength(1)
    expect(conflictCopies[0].tags).toEqual(["wichtig"])
    expect(result.conflicts).toHaveLength(1)
    expect(result.accepted).toEqual([])
    expect(queue.size).toBe(0)
  })
})
