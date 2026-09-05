/**
 * Vault crypto primitives — offline data-at-rest encryption (Sicherheitskonzept
 * Offline-Daten, P1).
 *
 * Pure WebCrypto, no IDB, no DOM: everything here is unit-testable in Node,
 * where `globalThis.crypto.subtle` exists since Node 20.
 *
 * Key hierarchy (envelope principle):
 *   - DEK (random AES-256-GCM key) encrypts every record.
 *   - KEK derived from the app PIN via PBKDF2-SHA-256 wraps the DEK.
 * The KDF is PBKDF2, not Argon2 — intentionally minimal: WebCrypto-native, no
 * WASM dependency. Compensated by a high iteration count and a minimum PIN
 * length enforced at the UI.
 */

export const VAULT_KDF_ITERATIONS = 600_000

/** AES-GCM's recommended IV size (96 bit). */
const IV_BYTES = 12

export interface EncryptedBytes {
  iv: Uint8Array
  data: ArrayBuffer
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function generateDekRaw(): Uint8Array {
  return randomBytes(32)
}

/** Derive the PIN-bound key-encryption-key. Same PIN + salt ⇒ same key. */
export async function deriveKekFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/** Import the raw DEK for session use. Non-extractable: the unlocked key can
 *  be used but never exported out of the WebCrypto layer again. */
export async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

export async function encryptBytes(
  key: CryptoKey,
  plain: BufferSource
): Promise<EncryptedBytes> {
  const iv = randomBytes(IV_BYTES)
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plain
  )
  return { iv, data }
}

/** Throws (OperationError) on a wrong key or tampered ciphertext — GCM
 *  authenticates, so "decrypt worked" doubles as the PIN check. */
export async function decryptBytes(
  key: CryptoKey,
  enc: EncryptedBytes
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: enc.iv as BufferSource },
    key,
    enc.data
  )
}

export async function encryptJson(
  key: CryptoKey,
  value: unknown
): Promise<EncryptedBytes> {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(value)))
}

export async function decryptJson<T>(
  key: CryptoKey,
  enc: EncryptedBytes
): Promise<T> {
  const plain = await decryptBytes(key, enc)
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

/** Chunked to stay clear of the argument-count limit of String.fromCharCode
 *  on multi-KB payloads (encrypted meta values). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
