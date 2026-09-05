/**
 * IndexedDB adapter for offline sync.
 *
 * All stores live in the "within-sync" database.
 * This module is browser-only — never import it in server code or tests
 * without mocking; use the IDBAdapter interface instead.
 */

import type { SyncEntry, QueuedEdit, ConflictCopy } from "@/lib/sync/types"
import type { MediaLRUEntry } from "@/lib/offline/lru-logic"
import type { OutboxMedia } from "@/lib/sync/media-outbox"
import type { Journal } from "@/types/journal"
import {
  createEncryptedAdapter,
  encodeMetaValue,
  encodeRecord,
  isEncryptedMetaValue,
} from "@/lib/vault/encrypted-adapter"
import { getSessionDek } from "@/lib/vault/vault"

const DB_NAME = "within-sync"

/**
 * Stores the app needs, with their key paths.
 *
 * There is deliberately no DB_VERSION constant. A PWA serves old and
 * new bundles side by side across a deploy: the shell may come from the service
 * worker cache while the database on disk was already upgraded by a newer bundle.
 * A hardcoded version then fails hard — opening with a version lower than the
 * stored one throws VersionError, which takes down every IDB operation at once
 * (empty timeline, offline save fails). Instead the database is opened without a
 * version and only upgraded when a store is genuinely missing.
 */
const REQUIRED_STORES: Record<string, string> = {
  entries:        "id",
  editQueue:      "entryId",
  conflictCopies: "id",
  meta:           "key",
  pinnedEntries:  "entryId",
  mediaLRU:       "url",
  // Files picked while offline, waiting to be uploaded.
  mediaOutbox:    "id",
}

/** Pin record stored per entry. mediaUrls lists the full-res paths for this entry. */
export interface PinnedEntry {
  entryId: string
  pinnedAt: string
  mediaUrls: string[]
  /**
   * Pin-Sync: Pin wurde vom Sync-Feed adoptiert (anderes Gerät hat
   * gepinnt) — der Feed trägt keine Medien-Metadaten,
   * die URLs löst backfillPinnedMedia über GET /api/entries/[id] nach.
   */
  mediaUrlsPending?: boolean
}

/** Abstract interface so the sync engine can be tested with a pure-JS stub. */
export interface IDBAdapter {
  getEntry(id: string): Promise<SyncEntry | undefined>
  putEntry(entry: SyncEntry): Promise<void>
  deleteEntry(id: string): Promise<void>
  getAllEntries(): Promise<SyncEntry[]>
  enqueueEdit(edit: QueuedEdit): Promise<void>
  dequeueEdit(entryId: string): Promise<void>
  listQueue(): Promise<QueuedEdit[]>
  putConflict(copy: ConflictCopy): Promise<void>
  listConflicts(): Promise<ConflictCopy[]>
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
  /** Optional so existing test stubs stay valid. */
  deleteMeta?(key: string): Promise<void>
  clearConflict(id: string): Promise<void>
  // Pin store
  putPin(pin: PinnedEntry): Promise<void>
  getPin(entryId: string): Promise<PinnedEntry | undefined>
  deletePin(entryId: string): Promise<void>
  listPins(): Promise<PinnedEntry[]>
  // Media LRU metadata
  putMediaLRU(entry: MediaLRUEntry): Promise<void>
  getMediaLRU(url: string): Promise<MediaLRUEntry | undefined>
  getAllMediaLRU(): Promise<MediaLRUEntry[]>
  deleteMediaLRU(url: string): Promise<void>
  // Journal list cache — optional so existing test stubs stay valid.
  putJournals?(journals: Journal[]): Promise<void>
  getJournals?(): Promise<Journal[]>
  // Offline media outbox — optional for the same reason.
  putOutboxMedia?(item: OutboxMedia): Promise<void>
  deleteOutboxMedia?(id: string): Promise<void>
  listOutboxMedia?(): Promise<OutboxMedia[]>
  listOutboxMediaForEntry?(entryId: string): Promise<OutboxMedia[]>
}

function rawOpen(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined
      ? indexedDB.open(DB_NAME)
      : indexedDB.open(DB_NAME, version)

    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result
      for (const [name, keyPath] of Object.entries(REQUIRED_STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error ?? new Error("IndexedDB konnte nicht geöffnet werden"))
    // Without onblocked this Promise never settles when another open connection
    // holds up the upgrade — the editor would spin on "Speichert…" forever.
    req.onblocked = () =>
      reject(new DOMException(
        "IndexedDB-Upgrade blockiert — die App ist noch in einem anderen Fenster offen",
        "BlockedError"
      ))
  })
}

async function openDB(): Promise<IDBDatabase> {
  let db = await rawOpen()

  const missing = Object.keys(REQUIRED_STORES).filter(
    (name) => !db.objectStoreNames.contains(name)
  )
  if (missing.length > 0) {
    const nextVersion = db.version + 1
    db.close()
    db = await rawOpen(nextVersion)
  }

  // Yield to another client that wants to upgrade, instead of blocking it.
  db.onversionchange = () => {
    db.close()
    _dbPromise = null
  }
  return db
}

function tx<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    fn(t).then(resolve).catch(reject)
    t.onerror = () => reject(t.error)
    // Without onabort the Promise hangs forever when the browser aborts the
    // transaction (e.g. quota exceeded mid-write, version change from another
    // tab).
    t.onabort = () => reject(t.error ?? new DOMException("IDB transaction aborted", "AbortError"))
  })
}

function req2<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror   = () => reject(r.error)
  })
}

// Memoised as a PROMISE, not an instance — detail effect, timeline
// effect and sync engine all open the DB on a cold start. Two concurrent
// openDB() runs can collide with the missing-store upgrade path: the second
// connection has no onversionchange handler yet and blocks the upgrade
// (onblocked → empty timeline for the session). A failed open resets the memo
// so the next call retries instead of caching the rejection forever.
let _dbPromise: Promise<IDBDatabase> | null = null
function getDB(): Promise<IDBDatabase> {
  _dbPromise ??= openDB().catch((err) => {
    _dbPromise = null
    throw err
  })
  return _dbPromise
}

/**
 * Raw adapter — talks to IndexedDB without any crypto. Only the encrypting
 * wrapper below, the vault migration, and adapter-hygiene tests may use it;
 * app code imports `realIDBAdapter`.
 */
export const rawIDBAdapter: IDBAdapter = {
  async getEntry(id) {
    const db = await getDB()
    return tx(db, "entries", "readonly", (t) =>
      req2(t.objectStore("entries").get(id))
    )
  },

  async putEntry(entry) {
    const db = await getDB()
    await tx(db, "entries", "readwrite", (t) =>
      req2(t.objectStore("entries").put(entry))
    )
  },

  async deleteEntry(id) {
    const db = await getDB()
    await tx(db, "entries", "readwrite", (t) =>
      req2(t.objectStore("entries").delete(id))
    )
  },

  async getAllEntries() {
    const db = await getDB()
    return tx(db, "entries", "readonly", (t) =>
      req2<SyncEntry[]>(t.objectStore("entries").getAll())
    )
  },

  async enqueueEdit(edit) {
    const db = await getDB()
    await tx(db, "editQueue", "readwrite", (t) =>
      req2(t.objectStore("editQueue").put(edit))
    )
  },

  async dequeueEdit(entryId) {
    const db = await getDB()
    await tx(db, "editQueue", "readwrite", (t) =>
      req2(t.objectStore("editQueue").delete(entryId))
    )
  },

  async listQueue() {
    const db = await getDB()
    return tx(db, "editQueue", "readonly", (t) =>
      req2<QueuedEdit[]>(t.objectStore("editQueue").getAll())
    )
  },

  async putConflict(copy) {
    const db = await getDB()
    await tx(db, "conflictCopies", "readwrite", (t) =>
      req2(t.objectStore("conflictCopies").put(copy))
    )
  },

  async listConflicts() {
    const db = await getDB()
    return tx(db, "conflictCopies", "readonly", (t) =>
      req2<ConflictCopy[]>(t.objectStore("conflictCopies").getAll())
    )
  },

  async clearConflict(id) {
    const db = await getDB()
    await tx(db, "conflictCopies", "readwrite", (t) =>
      req2(t.objectStore("conflictCopies").delete(id))
    )
  },

  async getMeta(key) {
    const db = await getDB()
    const row = await tx<{ key: string; value: string } | undefined>(
      db, "meta", "readonly", (t) =>
        req2(t.objectStore("meta").get(key))
    )
    return row?.value ?? null
  },

  async setMeta(key, value) {
    const db = await getDB()
    await tx(db, "meta", "readwrite", (t) =>
      req2(t.objectStore("meta").put({ key, value }))
    )
  },

  /** Meta keys (e.g. entryMedia:<id>) must be deletable, or the store
   *  grows monotonically and keeps media metadata of deleted entries around. */
  async deleteMeta(key) {
    const db = await getDB()
    await tx(db, "meta", "readwrite", (t) =>
      req2(t.objectStore("meta").delete(key))
    )
  },

  async putPin(pin) {
    const db = await getDB()
    await tx(db, "pinnedEntries", "readwrite", (t) =>
      req2(t.objectStore("pinnedEntries").put(pin))
    )
  },

  async getPin(entryId) {
    const db = await getDB()
    return tx(db, "pinnedEntries", "readonly", (t) =>
      req2<PinnedEntry | undefined>(t.objectStore("pinnedEntries").get(entryId))
    )
  },

  async deletePin(entryId) {
    const db = await getDB()
    await tx(db, "pinnedEntries", "readwrite", (t) =>
      req2(t.objectStore("pinnedEntries").delete(entryId))
    )
  },

  async listPins() {
    const db = await getDB()
    return tx(db, "pinnedEntries", "readonly", (t) =>
      req2<PinnedEntry[]>(t.objectStore("pinnedEntries").getAll())
    )
  },

  async putMediaLRU(entry) {
    const db = await getDB()
    await tx(db, "mediaLRU", "readwrite", (t) =>
      req2(t.objectStore("mediaLRU").put(entry))
    )
  },

  async getMediaLRU(url) {
    const db = await getDB()
    return tx(db, "mediaLRU", "readonly", (t) =>
      req2<MediaLRUEntry | undefined>(t.objectStore("mediaLRU").get(url))
    )
  },

  async getAllMediaLRU() {
    const db = await getDB()
    return tx(db, "mediaLRU", "readonly", (t) =>
      req2<MediaLRUEntry[]>(t.objectStore("mediaLRU").getAll())
    )
  },

  async deleteMediaLRU(url) {
    const db = await getDB()
    await tx(db, "mediaLRU", "readwrite", (t) =>
      req2(t.objectStore("mediaLRU").delete(url))
    )
  },

  /** The Blob is stored as-is — structured clone keeps the bytes, so
   *  the original survives an app restart and is uploaded untouched later. */
  async putOutboxMedia(item) {
    const db = await getDB()
    await tx(db, "mediaOutbox", "readwrite", (t) =>
      req2(t.objectStore("mediaOutbox").put(item))
    )
  },

  async deleteOutboxMedia(id) {
    const db = await getDB()
    await tx(db, "mediaOutbox", "readwrite", (t) =>
      req2(t.objectStore("mediaOutbox").delete(id))
    )
  },

  async listOutboxMedia() {
    const db = await getDB()
    return tx(db, "mediaOutbox", "readonly", (t) =>
      req2<OutboxMedia[]>(t.objectStore("mediaOutbox").getAll())
    )
  },

  /** Cursor instead of getAll — getAll deserialises EVERY outbox record
   *  including its Blob (up to the 250-MB budget) into one array just to filter
   *  by entryId. The cursor visits records one at a time, so non-matching blobs
   *  are released immediately. Still no index: the outbox holds a handful of
   *  files, and a new index would force a schema upgrade for a corpus-sized
   *  problem the store does not have. */
  async listOutboxMediaForEntry(entryId) {
    const db = await getDB()
    return tx(db, "mediaOutbox", "readonly", (t) =>
      new Promise<OutboxMedia[]>((resolve, reject) => {
        const matches: OutboxMedia[] = []
        const cursorReq = t.objectStore("mediaOutbox").openCursor()
        cursorReq.onerror = () => reject(cursorReq.error)
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) {
            resolve(matches)
            return
          }
          const item = cursor.value as OutboxMedia
          if (item.entryId === entryId) matches.push(item)
          cursor.continue()
        }
      })
    )
  },

}

/**
 * The adapter the app uses: raw IDB behind the vault's encrypting decorator
 * (Sicherheitskonzept Offline-Daten). Same interface, same import site —
 * consumers are unaware of the envelope format.
 */
export const realIDBAdapter: IDBAdapter = createEncryptedAdapter(rawIDBAdapter)

/** Stores whose envelope keeps a plaintext side-field (see encrypted-adapter). */
const MIGRATION_PLAIN_FIELDS: Record<string, string[]> = {
  mediaOutbox: ["entryId"],
}

/** Stores mit Blob-Records (bis zum 250-MB-Outbox-Budget) dürfen nie als
 *  Ganzes per getAll materialisiert werden — dieselbe RAM-Regel wie beim Cursor oben. */
const MIGRATION_BLOB_STORES = new Set(["mediaOutbox"])

/**
 * One-time in-place migration: encrypt every record that predates the vault.
 * Runs after PIN setup and after every unlock (covers an interrupted run —
 * already-encrypted records are skipped via the `__enc` marker). No-op without
 * a session key.
 */
export async function runVaultMigration(): Promise<void> {
  const dek = getSessionDek()
  if (!dek) return
  const db = await getDB()

  const migrateRecord = async (store: string, keyPath: string, record: Record<string, unknown>) => {
    if (store === "meta") {
      const value = record.value
      if (typeof value !== "string" || isEncryptedMetaValue(value)) return
      const encrypted = { key: record.key, value: await encodeMetaValue(dek, value) }
      await tx(db, store, "readwrite", (t) => req2(t.objectStore(store).put(encrypted)))
      return
    }
    if (record.__enc === 1) return
    const envelope = await encodeRecord(dek, keyPath, record, MIGRATION_PLAIN_FIELDS[store] ?? [])
    await tx(db, store, "readwrite", (t) => req2(t.objectStore(store).put(envelope)))
  }

  for (const [store, keyPath] of Object.entries(REQUIRED_STORES)) {
    if (MIGRATION_BLOB_STORES.has(store)) {
      // getAllKeys (billig, keine Blobs) + Einzel-Get — maximal ein Blob
      // gleichzeitig im Speicher statt des kompletten Outbox-Bestands.
      const keys = await tx(db, store, "readonly", (t) =>
        req2<IDBValidKey[]>(t.objectStore(store).getAllKeys())
      )
      for (const key of keys) {
        const record = await tx(db, store, "readonly", (t) =>
          req2<Record<string, unknown> | undefined>(t.objectStore(store).get(key))
        )
        if (record) await migrateRecord(store, keyPath, record)
      }
      continue
    }

    const records = await tx(db, store, "readonly", (t) =>
      req2<Record<string, unknown>[]>(t.objectStore(store).getAll())
    )
    for (const record of records) {
      await migrateRecord(store, keyPath, record)
    }
  }
}
