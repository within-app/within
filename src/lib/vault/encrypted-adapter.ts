/**
 * Encrypting decorator around the raw IDBAdapter.
 *
 * Every record is stored as an envelope: only the keyPath field stays in
 * plaintext (IndexedDB needs it to address the record; it is a UUID/path
 * without content) — everything else (text, tags, GPS, thumbnails, file names,
 * photo blobs, payloads) is AES-GCM ciphertext under the session DEK.
 *
 * Three states, decided per operation:
 *   - no vault configured  → passthrough (pre-setup legacy behaviour; the UI
 *     forces the PIN setup before any app content is reachable)
 *   - vault locked         → reject with VaultLockedError
 *   - vault unlocked       → encrypt on write, decrypt on read
 *
 * Reads tolerate plaintext records (no `__enc` marker): during migration the
 * stores hold a mix, and a record the migration has not reached yet must stay
 * readable.
 *
 * mediaOutbox keeps `entryId` in plaintext next to the envelope: the raw
 * adapter's cursor filter (listOutboxMediaForEntry) matches on it
 * without decrypting every blob. An entry UUID leaks no content.
 */

import type { IDBAdapter } from "@/lib/sync/idb"
import type { Journal } from "@/types/journal"
import {
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
} from "@/lib/vault/crypto"
import { VaultLockedError, getSessionDek, getVaultStatus } from "@/lib/vault/vault"

/** Envelope record as stored in an object store. */
interface EncryptedRecord {
  __enc: 1
  iv: Uint8Array
  data: ArrayBuffer
  /** Present only for records carrying a Blob (mediaOutbox). */
  blobIv?: Uint8Array
  blobData?: ArrayBuffer
  [plainField: string]: unknown
}

/** Marker prefix for encrypted string values in the meta store. */
const META_PREFIX = "enc1:"

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  return typeof value === "object" && value !== null && (value as EncryptedRecord).__enc === 1
}

/**
 * Resolve the session key or decide the passthrough/locked path.
 * Returns null for passthrough (no vault configured), throws when locked.
 */
async function requireDekOrPassthrough(): Promise<CryptoKey | null> {
  const dek = getSessionDek()
  if (dek) return dek
  const status = await getVaultStatus()
  if (status === "none") return null
  throw new VaultLockedError()
}

/** Encrypt one record into its envelope. Exported for the migration in idb.ts. */
export async function encodeRecord(
  dek: CryptoKey,
  keyPathField: string,
  record: Record<string, unknown>,
  plainFields: string[] = []
): Promise<EncryptedRecord> {
  const json: Record<string, unknown> = {}
  let blob: Blob | null = null
  for (const [field, value] of Object.entries(record)) {
    if (value instanceof Blob) {
      blob = value
      json.__blobField = field
      json.__blobType = value.type
    } else {
      json[field] = value
    }
  }

  const payload = await encryptJson(dek, json)
  const envelope: EncryptedRecord = {
    __enc: 1,
    iv: payload.iv,
    data: payload.data,
    [keyPathField]: record[keyPathField],
  }
  for (const field of plainFields) envelope[field] = record[field]

  if (blob) {
    const bytes = await blob.arrayBuffer()
    const encBlob = await encryptBytes(dek, bytes)
    envelope.blobIv = encBlob.iv
    envelope.blobData = encBlob.data
  }
  return envelope
}

/** Marker für einen kryptographisch unlesbaren Record (GCM-Auth-Fehler —
 *  Korruption oder falsche Vault-Generation). Ein einzelner solcher Record
 *  darf nicht den kompletten Store-Read rejecten: die Daten sind ohnehin
 *  unwiederbringlich, der Sync liefert die Server-Wahrheit nach. */
const CORRUPT_RECORD: unique symbol = Symbol("within-corrupt-record")

async function decodeRecord<T>(
  dek: CryptoKey | null,
  stored: unknown
): Promise<T | typeof CORRUPT_RECORD> {
  if (!isEncryptedRecord(stored)) return stored as T
  if (!dek) throw new VaultLockedError()
  try {
    const json = await decryptJson<Record<string, unknown>>(dek, {
      iv: stored.iv,
      data: stored.data,
    })
    if (stored.blobData && stored.blobIv && typeof json.__blobField === "string") {
      const bytes = await decryptBytes(dek, { iv: stored.blobIv, data: stored.blobData })
      json[json.__blobField] = new Blob([bytes], { type: (json.__blobType as string) ?? "" })
    }
    delete json.__blobField
    delete json.__blobType
    return json as T
  } catch {
    return CORRUPT_RECORD
  }
}

/** Encrypt a meta-store string value. Exported for the migration in idb.ts. */
export async function encodeMetaValue(dek: CryptoKey, value: string): Promise<string> {
  const enc = await encryptBytes(dek, new TextEncoder().encode(value))
  return META_PREFIX + bytesToBase64(enc.iv) + ":" + bytesToBase64(new Uint8Array(enc.data))
}

export function isEncryptedMetaValue(value: string): boolean {
  return value.startsWith(META_PREFIX)
}

async function decodeMetaValue(dek: CryptoKey | null, value: string | null): Promise<string | null> {
  if (value === null || !isEncryptedMetaValue(value)) return value
  if (!dek) throw new VaultLockedError()
  try {
    const [ivB64, ctB64] = value.slice(META_PREFIX.length).split(":")
    const plain = await decryptBytes(dek, {
      iv: base64ToBytes(ivB64),
      data: base64ToBytes(ctB64).buffer as ArrayBuffer,
    })
    return new TextDecoder().decode(plain)
  } catch {
    // Korrupter Meta-Wert liest sich als "nicht vorhanden" — z.B. ein
    // kaputter lastSync erzwingt so einen vollen Re-Pull statt Dauerfehler.
    console.warn("[within/vault] korrupter Meta-Wert übersprungen (GCM-Auth fehlgeschlagen)")
    return null
  }
}

/** Wrap the raw adapter. All consumers keep the plain-object view; the
 *  envelope exists only between this wrapper and IndexedDB. */
export function createEncryptedAdapter(raw: IDBAdapter): IDBAdapter {
  // The raw adapter's put/get signatures carry the plain types; the envelope
  // intentionally violates them at the storage boundary. The casts below are
  // confined to this factory — consumers never see an envelope.
  async function encodeFor(
    keyPathField: string,
    record: unknown,
    plainFields: string[] = []
  ): Promise<unknown> {
    const dek = await requireDekOrPassthrough()
    if (!dek) return record
    return encodeRecord(dek, keyPathField, record as Record<string, unknown>, plainFields)
  }

  async function decodeOne<T>(stored: T | undefined): Promise<T | undefined> {
    if (stored === undefined) return undefined
    const dek = await requireDekOrPassthrough()
    const decoded = await decodeRecord<T>(dek, stored)
    if (decoded === CORRUPT_RECORD) {
      console.warn("[within/vault] korrupter Record übersprungen (GCM-Auth fehlgeschlagen)")
      return undefined
    }
    return decoded
  }

  async function decodeMany<T>(stored: T[]): Promise<T[]> {
    const dek = await requireDekOrPassthrough()
    const decoded = await Promise.all(stored.map((record) => decodeRecord<T>(dek, record)))
    const intact = decoded.filter((r): r is Awaited<T> => r !== CORRUPT_RECORD)
    if (intact.length !== decoded.length) {
      console.warn(
        `[within/vault] ${decoded.length - intact.length} korrupte(r) Record(s) übersprungen (GCM-Auth fehlgeschlagen)`
      )
    }
    return intact
  }

  const adapter: IDBAdapter = {
    async getEntry(id) {
      return decodeOne(await raw.getEntry(id))
    },
    async putEntry(entry) {
      await raw.putEntry((await encodeFor("id", entry)) as typeof entry)
    },
    deleteEntry: (id) => raw.deleteEntry(id),
    async getAllEntries() {
      return decodeMany(await raw.getAllEntries())
    },

    async enqueueEdit(edit) {
      await raw.enqueueEdit((await encodeFor("entryId", edit)) as typeof edit)
    },
    dequeueEdit: (entryId) => raw.dequeueEdit(entryId),
    async listQueue() {
      return decodeMany(await raw.listQueue())
    },

    async putConflict(copy) {
      await raw.putConflict((await encodeFor("id", copy)) as typeof copy)
    },
    async listConflicts() {
      return decodeMany(await raw.listConflicts())
    },
    clearConflict: (id) => raw.clearConflict(id),

    async getMeta(key) {
      const dek = await requireDekOrPassthrough()
      return decodeMetaValue(dek, await raw.getMeta(key))
    },
    async setMeta(key, value) {
      const dek = await requireDekOrPassthrough()
      await raw.setMeta(key, dek ? await encodeMetaValue(dek, value) : value)
    },
    deleteMeta: raw.deleteMeta ? (key) => raw.deleteMeta!(key) : undefined,

    async putPin(pin) {
      await raw.putPin((await encodeFor("entryId", pin)) as typeof pin)
    },
    async getPin(entryId) {
      return decodeOne(await raw.getPin(entryId))
    },
    deletePin: (entryId) => raw.deletePin(entryId),
    async listPins() {
      return decodeMany(await raw.listPins())
    },

    async putMediaLRU(entry) {
      await raw.putMediaLRU((await encodeFor("url", entry)) as typeof entry)
    },
    async getMediaLRU(url) {
      return decodeOne(await raw.getMediaLRU(url))
    },
    async getAllMediaLRU() {
      return decodeMany(await raw.getAllMediaLRU())
    },
    deleteMediaLRU: (url) => raw.deleteMediaLRU(url),

    async putJournals(journals) {
      await adapter.setMeta("journalsCache", JSON.stringify(journals))
    },
    async getJournals() {
      const value = await adapter.getMeta("journalsCache")
      if (!value) return []
      try {
        const parsed = JSON.parse(value) as Journal[]
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },

    putOutboxMedia: raw.putOutboxMedia
      ? async (item) => {
          await raw.putOutboxMedia!(
            (await encodeFor("id", item, ["entryId"])) as typeof item
          )
        }
      : undefined,
    deleteOutboxMedia: raw.deleteOutboxMedia ? (id) => raw.deleteOutboxMedia!(id) : undefined,
    listOutboxMedia: raw.listOutboxMedia
      ? async () => decodeMany(await raw.listOutboxMedia!())
      : undefined,
    listOutboxMediaForEntry: raw.listOutboxMediaForEntry
      ? // Plaintext entryId on the envelope keeps the raw cursor filter working.
        async (entryId) => decodeMany(await raw.listOutboxMediaForEntry!(entryId))
      : undefined,
  }

  return adapter
}
