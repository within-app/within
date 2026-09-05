/**
 * Local vault — PIN lock + key management for the offline encryption.
 *
 * The vault config (salt, iterations, wrapped DEK) lives in its OWN IndexedDB
 * database ("within-vault"), not in within-sync's meta store: the config must
 * be readable BEFORE unlock, while within-sync sits behind the encrypting
 * adapter and is deliberately unreadable when locked. Separate DBs also break
 * the import cycle idb.ts → encrypted-adapter.ts → vault.ts.
 *
 * The unlocked DEK exists only in module memory (non-extractable CryptoKey).
 * lockVault() drops the reference — from then on every adapter operation
 * rejects until the next successful unlock.
 *
 * Browser-only module. Never import in server code.
 */

import {
  VAULT_KDF_ITERATIONS,
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  deriveKekFromPin,
  encryptBytes,
  generateDekRaw,
  importDek,
  randomBytes,
} from "@/lib/vault/crypto"

const VAULT_DB = "within-vault"
const VAULT_STORE = "vault"
const CONFIG_KEY = "config"

/** Minimum PIN length — enforced here as the last line, mirrored in the UI. */
export const MIN_PIN_LENGTH = 6

interface VaultConfigV1 {
  v: 1
  saltB64: string
  iterations: number
  /** AES-GCM(KEK, raw DEK) — the wrapped data-encryption-key. */
  dekIvB64: string
  dekCtB64: string
  createdAt: string
}

export type VaultStatus = "none" | "locked" | "unlocked"

export class VaultLockedError extends Error {
  readonly code = "vault_locked"
  constructor() {
    super("Vault ist gesperrt — Offline-Daten sind ohne Entsperren nicht lesbar")
    this.name = "VaultLockedError"
  }
}

/** Lock-Zustand ist Kontrollfluss, kein Fehler — Aufrufer (Sync, Mount-
 *  Ketten) behandeln ihn still statt Banner/Unhandled Rejection. instanceof
 *  reicht nicht über Modul-Grenzen mit resetModules — das code-Feld ist der
 *  stabile Marker. */
export function isVaultLockError(err: unknown): boolean {
  if (err instanceof VaultLockedError) return true
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "vault_locked"
  )
}

let sessionDek: CryptoKey | null = null
/** undefined = not loaded yet; null = loaded, no vault configured. */
let configCache: VaultConfigV1 | null | undefined

const listeners = new Set<() => void>()

export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(): void {
  for (const listener of listeners) listener()
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("within-vault konnte nicht geöffnet werden"))
  })
}

// Als PROMISE memoisiert (gleiches Muster wie in idb.ts): beim Kaltstart fragen
// mehrere Adapter-Aufrufe gleichzeitig den Vault-Status ab — ohne Memo öffnet
// jeder eine eigene within-vault-Connection. Ein fehlgeschlagener Read setzt
// das Memo zurück, statt die Rejection für immer zu cachen.
let _configPromise: Promise<VaultConfigV1 | null> | null = null

function readConfig(): Promise<VaultConfigV1 | null> {
  if (configCache !== undefined) return Promise.resolve(configCache)
  _configPromise ??= (async () => {
    const db = await openVaultDb()
    try {
      const cfg = await new Promise<VaultConfigV1 | null>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, "readonly")
        const req = tx.objectStore(VAULT_STORE).get(CONFIG_KEY)
        req.onsuccess = () => resolve((req.result as VaultConfigV1 | undefined) ?? null)
        req.onerror = () => reject(req.error)
      })
      configCache = cfg
      return cfg
    } finally {
      db.close()
      _configPromise = null
    }
  })().catch((err) => {
    _configPromise = null
    throw err
  })
  return _configPromise
}

async function writeConfig(cfg: VaultConfigV1): Promise<void> {
  const db = await openVaultDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE, "readwrite")
      tx.objectStore(VAULT_STORE).put(cfg, CONFIG_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    configCache = cfg
  } finally {
    db.close()
  }
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const cfg = await readConfig()
  if (!cfg) return "none"
  return sessionDek ? "unlocked" : "locked"
}

/** Synchronous accessor for the hot adapter path. null = locked or no vault. */
export function getSessionDek(): CryptoKey | null {
  return sessionDek
}

export async function setupVault(pin: string): Promise<void> {
  if (pin.length < MIN_PIN_LENGTH) throw new Error("PIN zu kurz")
  if ((await readConfig()) !== null) throw new Error("Vault existiert bereits")

  const salt = randomBytes(16)
  const kek = await deriveKekFromPin(pin, salt, VAULT_KDF_ITERATIONS)
  const dekRaw = generateDekRaw()
  const wrapped = await encryptBytes(kek, dekRaw as BufferSource)

  await writeConfig({
    v: 1,
    saltB64: bytesToBase64(salt),
    iterations: VAULT_KDF_ITERATIONS,
    dekIvB64: bytesToBase64(wrapped.iv),
    dekCtB64: bytesToBase64(new Uint8Array(wrapped.data)),
    createdAt: new Date().toISOString(),
  })

  sessionDek = await importDek(dekRaw)
  dekRaw.fill(0)
  emit()
}

async function unwrapDekRaw(cfg: VaultConfigV1, pin: string): Promise<Uint8Array | null> {
  const kek = await deriveKekFromPin(pin, base64ToBytes(cfg.saltB64), cfg.iterations)
  try {
    const raw = await decryptBytes(kek, {
      iv: base64ToBytes(cfg.dekIvB64),
      data: base64ToBytes(cfg.dekCtB64).buffer as ArrayBuffer,
    })
    return new Uint8Array(raw)
  } catch {
    // GCM authentication failed — wrong PIN. Not an I/O error.
    return null
  }
}

export async function unlockVault(pin: string): Promise<boolean> {
  const cfg = await readConfig()
  if (!cfg) return false
  const dekRaw = await unwrapDekRaw(cfg, pin)
  if (!dekRaw) return false
  sessionDek = await importDek(dekRaw)
  dekRaw.fill(0)
  emit()
  return true
}

export function lockVault(): void {
  if (!sessionDek) return
  sessionDek = null
  emit()
}

export async function changeVaultPin(currentPin: string, newPin: string): Promise<boolean> {
  if (newPin.length < MIN_PIN_LENGTH) throw new Error("PIN zu kurz")
  const cfg = await readConfig()
  if (!cfg) return false
  const dekRaw = await unwrapDekRaw(cfg, currentPin)
  if (!dekRaw) return false

  const salt = randomBytes(16)
  const kek = await deriveKekFromPin(newPin, salt, VAULT_KDF_ITERATIONS)
  const wrapped = await encryptBytes(kek, dekRaw as BufferSource)
  await writeConfig({
    ...cfg,
    saltB64: bytesToBase64(salt),
    iterations: VAULT_KDF_ITERATIONS,
    dekIvB64: bytesToBase64(wrapped.iv),
    dekCtB64: bytesToBase64(new Uint8Array(wrapped.data)),
  })

  // Same DEK, new wrapping — the session stays unlocked if it was.
  sessionDek = await importDek(dekRaw)
  dekRaw.fill(0)
  emit()
  return true
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    // blocked: another tab holds a connection — the deletion completes once it
    // closes. Resolve anyway; the reload after reset re-runs setup regardless.
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

/**
 * "PIN vergessen"-Pfad: wipes ALL local data (encrypted stores, media cache,
 * legacy caches) and the vault config. The server keeps the source of truth —
 * after an online login the device re-syncs from scratch. Unsynced offline
 * edits are lost; the UI says so before calling this.
 */
export async function resetVaultAndLocalData(): Promise<void> {
  sessionDek = null
  configCache = undefined
  _configPromise = null
  await deleteDatabase("within-sync")
  await deleteDatabase(VAULT_DB)
  try {
    // Literals instead of MEDIA_CACHE_NAME: importing media-cache.ts here
    // would cycle (media-cache → idb → encrypted-adapter → vault). v1 is the
    // pre-migration plaintext cache, v2 the encrypted one.
    await caches.delete("within-media-v1")
    await caches.delete("within-media-v2")
  } catch {
    // Cache API unavailable (non-secure context) — nothing cached there either.
  }
  try {
    localStorage.removeItem("within.journals.cache")
  } catch {
    // localStorage unavailable — ignore.
  }
  emit()
}
