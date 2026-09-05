/**
 * Vault P2 (Sicherheitskonzept Offline-Daten §5.4) — Umschlag-Format für
 * verschlüsselte Einträge im Medien-Cache (`within-media-v2`).
 *
 * Zwei Schreiber teilen sich dieses Format: der Service Worker (Auto-Cache
 * beim Online-Ansehen) und der Pin-Flow der Seite (media-cache.ts). Der SW
 * kann als statisches public/-Script keine Module importieren — public/sw.js
 * hält deshalb eine minimale Kopie der Umschlag-Logik. Die Format-Kompatibilität
 * beider Hälften wird in tests/sw-media-encryption.test.ts kreuzgeprüft.
 *
 * Umschlag: Body = roher AES-GCM-Ciphertext (inkl. Auth-Tag), IV und
 * Original-Content-Type stehen in Headern. Der Session-DEK des Vaults ist
 * auch der Medien-Schlüssel — GCM mit frischer Zufalls-IV pro Eintrag macht
 * die Mitnutzung sicher, und ein zweiter Schlüssel bräuchte ein zweites
 * Wrapping ohne Sicherheitsgewinn.
 */

import { bytesToBase64, base64ToBytes, encryptBytes, decryptBytes } from "@/lib/vault/crypto"

/** Marker-Header: Wert = Umschlag-Version. Fehlt er, ist der Eintrag Klartext. */
export const MEDIA_ENC_HEADER = "x-within-enc"
export const MEDIA_ENC_VERSION = "v1"
export const MEDIA_ENC_IV_HEADER = "x-within-enc-iv"
export const MEDIA_ENC_CT_HEADER = "x-within-enc-ct"

/**
 * SW-Herkunfts-Marker (HTTP-Cache-Fix 23.08.): Seit die Medien-Route selbst
 * `private, no-store` sendet, kann der Pin-Guard SW-Antworten nicht
 * mehr am Cache-Control erkennen. Der SW markiert alles, was nicht frisch
 * vom Netz kommt — Platzhalter und Cache-Entschlüsselung —, mit diesem
 * Header; frische Netz-Antworten bleiben unmarkiert. Die SW-Kopie der
 * Literale lebt in public/sw.js (kein Modul-Import möglich), Kompatibilität
 * fixiert tests/sw-media-encryption.test.ts.
 */
export const SW_SERVED_HEADER = "x-within-sw"
export const SW_SERVED_PLACEHOLDER = "placeholder"
export const SW_SERVED_CACHE_DECRYPT = "cache-decrypt"

export function isEncryptedMediaResponse(res: Response): boolean {
  return res.headers.get(MEDIA_ENC_HEADER) === MEDIA_ENC_VERSION
}

/** Verpackt eine Medien-Response als Cache-Storage-tauglichen Ciphertext. */
export async function encryptMediaResponse(key: CryptoKey, res: Response): Promise<Response> {
  const plain = await res.arrayBuffer()
  const enc = await encryptBytes(key, plain)
  return new Response(enc.data, {
    status: 200,
    headers: {
      [MEDIA_ENC_HEADER]: MEDIA_ENC_VERSION,
      [MEDIA_ENC_IV_HEADER]: bytesToBase64(enc.iv),
      [MEDIA_ENC_CT_HEADER]: res.headers.get("content-type") ?? "application/octet-stream",
      "Content-Type": "application/octet-stream",
    },
  })
}

/**
 * Entschlüsselt einen Umschlag zurück in die Serve-Form. `null` bei falschem
 * Schlüssel oder manipuliertem Ciphertext (GCM-Auth schlägt fehl) — der
 * Aufrufer verwirft den Eintrag dann. `no-store`, damit keine weitere
 * Schicht den Klartext persistiert.
 */
export async function decryptMediaResponse(key: CryptoKey, res: Response): Promise<Response | null> {
  const iv = res.headers.get(MEDIA_ENC_IV_HEADER)
  if (!isEncryptedMediaResponse(res) || !iv) return null
  try {
    const plain = await decryptBytes(key, {
      iv: base64ToBytes(iv),
      data: await res.arrayBuffer(),
    })
    return new Response(plain, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get(MEDIA_ENC_CT_HEADER) ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return null
  }
}
