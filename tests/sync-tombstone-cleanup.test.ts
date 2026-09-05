/**
 * Pull-Tombstone räumt die lokalen Reste des Eintrags ab:
 * den entryMedia:<id>-Meta-Schlüssel und wartende Outbox-Dateien (die nie
 * wieder anhängen könnten — der Eintrag ist weg).
 *
 * In-Memory-Stub, synthetische Daten.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { createSyncEngine } from "../src/lib/sync/engine"
import type { IDBAdapter } from "../src/lib/sync/idb"
import type { SyncEntry } from "../src/lib/sync/types"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"

const ENTRY_ID = "20000000-0000-4000-8000-000000000001"

function makeStub() {
  const entries = new Map<string, SyncEntry>()
  const meta = new Map<string, string>()
  const outbox = new Map<string, OutboxMedia>()

  const idb: IDBAdapter = {
    getEntry: async (id) => entries.get(id),
    putEntry: async (e) => { entries.set(e.id, e) },
    deleteEntry: async (id) => { entries.delete(id) },
    getAllEntries: async () => [...entries.values()],
    enqueueEdit: async () => {},
    dequeueEdit: async () => {},
    listQueue: async () => [],
    putConflict: async () => {},
    listConflicts: async () => [],
    clearConflict: async () => {},
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => { meta.set(k, v) },
    deleteMeta: async (k) => { meta.delete(k) },
    putPin: async () => {},
    getPin: async () => undefined,
    deletePin: async () => {},
    listPins: async () => [],
    putMediaLRU: async () => {},
    getMediaLRU: async () => undefined,
    getAllMediaLRU: async () => [],
    deleteMediaLRU: async () => {},
    putOutboxMedia: async (item) => { outbox.set(item.id, item) },
    deleteOutboxMedia: async (id) => { outbox.delete(id) },
    listOutboxMedia: async () => [...outbox.values()],
    listOutboxMediaForEntry: async (entryId) =>
      [...outbox.values()].filter((i) => i.entryId === entryId),
  }
  return { idb, meta, outbox }
}

function tombstone(): SyncEntry {
  return {
    id: ENTRY_ID,
    journalId: "10000000-0000-4000-8000-000000000001",
    text: "",
    createdAt: "2026-07-27T09:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false,
    tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: "2026-07-27T10:00:00.000Z",
    thumbnailDataUrl: null,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("pull() mit Tombstone", () => {
  it("löscht entryMedia-Cache und Outbox-Reste des gelöschten Eintrags", async () => {
    const { idb, meta, outbox } = makeStub()
    meta.set(`entryMedia:${ENTRY_ID}`, '{"v":2,"updatedAt":"x","media":[]}')
    meta.set("entryMedia:anderer-eintrag", "bleibt")
    outbox.set("outbox-1", {
      id: "outbox-1",
      entryId: ENTRY_ID,
      blob: new Blob(["x"]),
      fileName: "synthetic.jpg",
      mimeType: "image/jpeg",
      type: "photo",
      size: 1,
      queuedAt: "2026-07-27T09:30:00.000Z",
      attempts: 0,
    })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [tombstone()],
        nextCursor: null,
        serverTime: "2026-07-27T12:00:00.000Z",
      }),
    }))

    await createSyncEngine(idb).pull(null)

    expect(meta.has(`entryMedia:${ENTRY_ID}`)).toBe(false)
    expect(meta.get("entryMedia:anderer-eintrag")).toBe("bleibt")
    expect(outbox.size).toBe(0)
  })

  it("Ein geändertes updatedAt im Pull invalidiert den Medien-Cache des Eintrags", async () => {
    // Das ist das einzige Sync-Signal für „Foto auf Gerät B gelöscht":
    // DELETE /api/media bumpt updated_at, der Pull transportiert es hierher.
    const { idb, meta } = makeStub()
    const old = { ...tombstone(), deletedAt: null, updatedAt: "2026-07-27T08:00:00.000Z" }
    await idb.putEntry(old)
    meta.set(`entryMedia:${ENTRY_ID}`, '{"v":2,"updatedAt":"x","media":[]}')

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [{ ...old, updatedAt: "2026-07-27T10:00:00.000Z" }],
        nextCursor: null,
        serverTime: "2026-07-27T12:00:00.000Z",
      }),
    }))

    await createSyncEngine(idb).pull(null)

    expect(meta.has(`entryMedia:${ENTRY_ID}`)).toBe(false)
  })

  it("Ein unverändertes updatedAt lässt den Medien-Cache stehen", async () => {
    const { idb, meta } = makeStub()
    const entry = { ...tombstone(), deletedAt: null }
    await idb.putEntry(entry)
    meta.set(`entryMedia:${ENTRY_ID}`, "bleibt")

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [entry],
        nextCursor: null,
        serverTime: "2026-07-27T12:00:00.000Z",
      }),
    }))

    await createSyncEngine(idb).pull(null)

    expect(meta.get(`entryMedia:${ENTRY_ID}`)).toBe("bleibt")
  })

  it("bleibt auf alten Adaptern ohne deleteMeta/Outbox-Methoden ruhig", async () => {
    const { idb } = makeStub()
    delete idb.deleteMeta
    delete idb.listOutboxMediaForEntry
    delete idb.deleteOutboxMedia

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [tombstone()],
        nextCursor: null,
        serverTime: "2026-07-27T12:00:00.000Z",
      }),
    }))

    await expect(createSyncEngine(idb).pull(null)).resolves.toBe(1)
  })
})

describe("pull() Tombstone räumt den Pin-Record (B14)", () => {
  it("löscht den Pin des tombstoned Eintrags — sonst bleiben gepinnte Bytes unevictbar", async () => {
    const { idb } = makeStub()
    const deletedPins: string[] = []
    idb.deletePin = async (entryId) => { deletedPins.push(entryId) }

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [tombstone()],
        nextCursor: null,
        serverTime: "2026-07-27T12:00:00.000Z",
      }),
    }))

    await createSyncEngine(idb).pull(null)
    expect(deletedPins).toContain(ENTRY_ID)
  })
})
