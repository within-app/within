import { describe, it, expect } from "vitest"
import {
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  decryptJson,
  deriveKekFromPin,
  encryptBytes,
  encryptJson,
  generateDekRaw,
  importDek,
  randomBytes,
} from "../src/lib/vault/crypto"

// Niedrige Iterationszahl nur für Tests — die Produktions-Konstante
// (VAULT_KDF_ITERATIONS) würde jeden Testlauf um Sekunden verlängern.
const TEST_ITERATIONS = 1_000

describe("vault crypto", () => {
  it("verschlüsselt und entschlüsselt JSON verlustfrei (Roundtrip)", async () => {
    const dek = await importDek(generateDekRaw())
    const value = { id: "e1", text: "synthetischer Eintrag", tags: ["a", "b"], lat: 53.5 }
    const enc = await encryptJson(dek, value)
    expect(enc.iv).toHaveLength(12)
    await expect(decryptJson(dek, enc)).resolves.toEqual(value)
  })

  it("Ciphertext enthält den Klartext nicht", async () => {
    const dek = await importDek(generateDekRaw())
    const enc = await encryptJson(dek, { text: "geheimer-marker-123" })
    const asString = new TextDecoder().decode(enc.data)
    expect(asString).not.toContain("geheimer-marker-123")
  })

  it("falscher Schlüssel schlägt fehl (GCM authentifiziert)", async () => {
    const dekA = await importDek(generateDekRaw())
    const dekB = await importDek(generateDekRaw())
    const enc = await encryptJson(dekA, { secret: true })
    await expect(decryptJson(dekB, enc)).rejects.toThrow()
  })

  it("gleiche PIN + Salt ⇒ gleicher KEK; anderes Salt ⇒ anderer KEK", async () => {
    const salt = randomBytes(16)
    const kek1 = await deriveKekFromPin("123456", salt, TEST_ITERATIONS)
    const kek2 = await deriveKekFromPin("123456", salt, TEST_ITERATIONS)
    const enc = await encryptBytes(kek1, new Uint8Array([1, 2, 3]))
    // kek2 kann entschlüsseln, was kek1 verschlüsselt hat → identischer Schlüssel.
    const plain = new Uint8Array(await decryptBytes(kek2, enc))
    expect([...plain]).toEqual([1, 2, 3])

    const kekOther = await deriveKekFromPin("123456", randomBytes(16), TEST_ITERATIONS)
    await expect(decryptBytes(kekOther, enc)).rejects.toThrow()
  })

  it("falsche PIN ⇒ Entschlüsselung des gewrappten DEK schlägt fehl", async () => {
    const salt = randomBytes(16)
    const kek = await deriveKekFromPin("richtige-pin", salt, TEST_ITERATIONS)
    const wrapped = await encryptBytes(kek, generateDekRaw() as BufferSource)
    const wrong = await deriveKekFromPin("falsche-pin", salt, TEST_ITERATIONS)
    await expect(decryptBytes(wrong, wrapped)).rejects.toThrow()
  })

  it("Base64-Roundtrip, auch über die Chunk-Grenze (>32 KiB)", () => {
    const small = new Uint8Array([0, 1, 255, 128])
    expect([...base64ToBytes(bytesToBase64(small))]).toEqual([...small])

    // getRandomValues ist auf 65 536 Bytes begrenzt — deterministisch füllen.
    const big = new Uint8Array(70_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const back = base64ToBytes(bytesToBase64(big))
    expect(back).toHaveLength(big.length)
    expect(back[0]).toBe(big[0])
    expect(back[69_999]).toBe(big[69_999])
  })
})

describe("isVaultLockError (B10)", () => {
  // Bis B10 landete ein Auto-Lock mitten im Sync als rohes deutsches
  // Fehler-Banner im UI (unabhängig von der Sprache), und der /login-Mount
  // bei gesperrtem Vault produzierte eine Unhandled Rejection in der Konsole
  // — beides Normalbetrieb, kein Fehlerfall.
  it("erkennt VaultLockedError (Instanz und code-Feld)", async () => {
    const { VaultLockedError, isVaultLockError } = await import("../src/lib/vault/vault")
    expect(isVaultLockError(new VaultLockedError())).toBe(true)
    expect(isVaultLockError({ code: "vault_locked" })).toBe(true)
  })
  it("andere Fehler bleiben Fehler", async () => {
    const { isVaultLockError } = await import("../src/lib/vault/vault")
    expect(isVaultLockError(new Error("boom"))).toBe(false)
    expect(isVaultLockError(null)).toBe(false)
    expect(isVaultLockError(undefined)).toBe(false)
  })
})
