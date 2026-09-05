/**
 * Vault P2 — Umschlag-Format für verschlüsselte Medien-Cache-Einträge
 * (src/lib/offline/media-encryption.ts, Seiten-Hälfte des Formats; die
 * SW-Hälfte in public/sw.js wird in sw-media-encryption.test.ts gegen
 * dieses Modul kreuzgeprüft).
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { generateDekRaw, importDek } from "../src/lib/vault/crypto"
import {
  MEDIA_ENC_HEADER,
  MEDIA_ENC_VERSION,
  decryptMediaResponse,
  encryptMediaResponse,
  isEncryptedMediaResponse,
} from "../src/lib/offline/media-encryption"

const PLAINTEXT = new TextEncoder().encode("synthetic-photo-bytes")

function photoResponse(): Response {
  return new Response(PLAINTEXT.slice(), {
    status: 200,
    headers: { "Content-Type": "image/webp" },
  })
}

describe("media-encryption Umschlag", () => {
  it("Roundtrip: encrypt → decrypt liefert Klartext und Original-Content-Type", async () => {
    const key = await importDek(generateDekRaw())
    const enc = await encryptMediaResponse(key, photoResponse())

    expect(enc.headers.get(MEDIA_ENC_HEADER)).toBe(MEDIA_ENC_VERSION)
    expect(enc.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(isEncryptedMediaResponse(enc)).toBe(true)

    const dec = await decryptMediaResponse(key, enc)
    expect(dec).not.toBeNull()
    expect(new Uint8Array(await dec!.arrayBuffer())).toEqual(PLAINTEXT)
    expect(dec!.headers.get("Content-Type")).toBe("image/webp")
    // Entschlüsselter Klartext darf von keiner weiteren Schicht persistiert werden.
    expect(dec!.headers.get("Cache-Control")).toContain("no-store")
  })

  it("Ciphertext enthält den Klartext nicht", async () => {
    const key = await importDek(generateDekRaw())
    const enc = await encryptMediaResponse(key, photoResponse())
    const bytes = new Uint8Array(await enc.arrayBuffer())
    expect(new TextDecoder().decode(bytes)).not.toContain("synthetic-photo-bytes")
  })

  it("falscher Schlüssel: decrypt liefert null (GCM-Auth schlägt fehl), keine Exception", async () => {
    const keyA = await importDek(generateDekRaw())
    const keyB = await importDek(generateDekRaw())
    const enc = await encryptMediaResponse(keyA, photoResponse())
    expect(await decryptMediaResponse(keyB, enc)).toBeNull()
  })

  it("unverschlüsselte Response wird nicht als Umschlag erkannt", () => {
    expect(isEncryptedMediaResponse(photoResponse())).toBe(false)
  })

  it("jede Verschlüsselung nutzt eine frische IV", async () => {
    const key = await importDek(generateDekRaw())
    const a = await encryptMediaResponse(key, photoResponse())
    const b = await encryptMediaResponse(key, photoResponse())
    expect(a.headers.get("x-within-enc-iv")).not.toBe(b.headers.get("x-within-enc-iv"))
  })
})
