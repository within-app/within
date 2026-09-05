/**
 * Vault + verschlüsselnder Adapter gegen echte (fake-)IndexedDB.
 *
 * Muster wie idb-adapter-hygiene.test.ts: pro Test frische IDBFactory +
 * vi.resetModules + dynamischer Import, weil idb.ts die Connection und
 * vault.ts Config/Session-Key modul-lokal memoisieren.
 *
 * Nur synthetische Daten. PIN-Setup nutzt die Produktions-Iterationszahl —
 * wenige Setups pro Datei halten die Laufzeit im Rahmen.
 */
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { SyncEntry } from "../src/lib/sync/types"

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
})

async function freshModules() {
  const idb = await import("../src/lib/sync/idb")
  const vault = await import("../src/lib/vault/vault")
  return { idb, vault }
}

function makeEntry(id: string): SyncEntry {
  return {
    id,
    journalId: "j1",
    text: "synthetischer Tagebuchtext",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    revisionId: "r1",
    starred: false,
    tags: ["synthetisch"],
    locationName: "Teststadt",
    locationLat: 53.55,
    locationLng: 10.0,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

const PIN = "test-pin-123456"

describe("encrypted adapter + vault", () => {
  it("ohne Vault: Passthrough wie bisher (Legacy-Verhalten vor dem Setup)", async () => {
    const { idb } = await freshModules()
    await idb.realIDBAdapter.putEntry(makeEntry("e1"))
    const raw = await idb.rawIDBAdapter.getAllEntries()
    expect(raw).toHaveLength(1)
    // Kein Envelope — Klartext, exakt das Verhalten vor P1.
    expect((raw[0] as unknown as { __enc?: number }).__enc).toBeUndefined()
    expect(raw[0].text).toBe("synthetischer Tagebuchtext")
  })

  it("mit Vault: Einträge liegen als Envelope ohne Klartext in IDB", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)

    await idb.realIDBAdapter.putEntry(makeEntry("e1"))

    const raw = (await idb.rawIDBAdapter.getAllEntries()) as unknown as Array<
      Record<string, unknown>
    >
    expect(raw).toHaveLength(1)
    expect(raw[0].__enc).toBe(1)
    expect(raw[0].id).toBe("e1") // keyPath bleibt adressierbar
    expect(raw[0].text).toBeUndefined()
    expect(raw[0].locationLat).toBeUndefined()
    const storedJson = JSON.stringify(raw[0])
    expect(storedJson).not.toContain("synthetischer Tagebuchtext")
    expect(storedJson).not.toContain("Teststadt")

    // Lesen über den Wrapper liefert den Klartext zurück.
    const roundtrip = await idb.realIDBAdapter.getEntry("e1")
    expect(roundtrip).toEqual(makeEntry("e1"))
  })

  it("gesperrt: Zugriffe rejecten mit VaultLockedError, Entsperren heilt", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)
    await idb.realIDBAdapter.putEntry(makeEntry("e1"))

    vault.lockVault()
    await expect(idb.realIDBAdapter.getEntry("e1")).rejects.toBeInstanceOf(vault.VaultLockedError)
    await expect(idb.realIDBAdapter.putEntry(makeEntry("e2"))).rejects.toBeInstanceOf(
      vault.VaultLockedError
    )
    await expect(idb.realIDBAdapter.getMeta("lastSync")).rejects.toBeInstanceOf(
      vault.VaultLockedError
    )

    await expect(vault.unlockVault("falsche-pin-999")).resolves.toBe(false)
    await expect(vault.getVaultStatus()).resolves.toBe("locked")

    await expect(vault.unlockVault(PIN)).resolves.toBe(true)
    await expect(idb.realIDBAdapter.getEntry("e1")).resolves.toEqual(makeEntry("e1"))
  })

  it("Meta-Werte werden verschlüsselt gespeichert und transparent gelesen", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)

    await idb.realIDBAdapter.setMeta("lastSync", "2026-01-02T00:00:00.000Z")
    const rawValue = await idb.rawIDBAdapter.getMeta("lastSync")
    expect(rawValue).toMatch(/^enc1:/)
    await expect(idb.realIDBAdapter.getMeta("lastSync")).resolves.toBe(
      "2026-01-02T00:00:00.000Z"
    )
  })

  it("Outbox-Blob: Bytes verschlüsselt, entryId bleibt Klartext für den Cursor-Filter", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)

    const bytes = new Uint8Array([10, 20, 30, 40])
    await idb.realIDBAdapter.putOutboxMedia!({
      id: "m1",
      entryId: "e1",
      blob: new Blob([bytes], { type: "image/jpeg" }),
      fileName: "synthetisch.jpg",
      mimeType: "image/jpeg",
      type: "photo",
      size: bytes.length,
      queuedAt: "2026-01-01T10:00:00.000Z",
      attempts: 0,
    })

    const raw = (await idb.rawIDBAdapter.listOutboxMedia!()) as unknown as Array<
      Record<string, unknown>
    >
    expect(raw[0].__enc).toBe(1)
    expect(raw[0].entryId).toBe("e1") // Klartext-Seitenfeld (Cursor-Zugriff)
    expect(raw[0].blob).toBeUndefined()
    expect(raw[0].fileName).toBeUndefined()
    expect(raw[0].blobData).toBeInstanceOf(ArrayBuffer)

    const items = await idb.realIDBAdapter.listOutboxMediaForEntry!("e1")
    expect(items).toHaveLength(1)
    expect(items[0].fileName).toBe("synthetisch.jpg")
    const back = new Uint8Array(await items[0].blob.arrayBuffer())
    expect([...back]).toEqual([...bytes])
  })

  it("Migration: vorhandene Klartext-Daten werden in place verschlüsselt", async () => {
    const { idb, vault } = await freshModules()

    // Bestandsgerät: Daten liegen VOR dem Vault-Setup im Klartext.
    await idb.rawIDBAdapter.putEntry(makeEntry("alt-1"))
    await idb.rawIDBAdapter.setMeta("lastSync", "2026-01-01T00:00:00.000Z")

    await vault.setupVault(PIN)
    await idb.runVaultMigration()

    const rawEntries = (await idb.rawIDBAdapter.getAllEntries()) as unknown as Array<
      Record<string, unknown>
    >
    expect(rawEntries[0].__enc).toBe(1)
    expect(JSON.stringify(rawEntries[0])).not.toContain("synthetischer Tagebuchtext")
    expect(await idb.rawIDBAdapter.getMeta("lastSync")).toMatch(/^enc1:/)

    // Wrapper liest weiterhin Klartext.
    await expect(idb.realIDBAdapter.getEntry("alt-1")).resolves.toEqual(makeEntry("alt-1"))
    await expect(idb.realIDBAdapter.getMeta("lastSync")).resolves.toBe(
      "2026-01-01T00:00:00.000Z"
    )

    // Idempotent: zweiter Lauf ändert nichts und wirft nicht.
    await expect(idb.runVaultMigration()).resolves.toBeUndefined()
  })

  it("Klartext-Toleranz: unmigrierter Datensatz bleibt bei entsperrtem Vault lesbar", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)
    // Direkt am Wrapper vorbei geschrieben (simuliert unterbrochene Migration).
    await idb.rawIDBAdapter.putEntry(makeEntry("plain-1"))
    await expect(idb.realIDBAdapter.getEntry("plain-1")).resolves.toEqual(makeEntry("plain-1"))
  })

  it("PIN ändern: alte PIN sperrt aus, neue entsperrt, Daten bleiben lesbar", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)
    await idb.realIDBAdapter.putEntry(makeEntry("e1"))

    await expect(vault.changeVaultPin("falsch", "neue-pin-123456")).resolves.toBe(false)
    await expect(vault.changeVaultPin(PIN, "neue-pin-123456")).resolves.toBe(true)

    vault.lockVault()
    await expect(vault.unlockVault(PIN)).resolves.toBe(false)
    await expect(vault.unlockVault("neue-pin-123456")).resolves.toBe(true)
    await expect(idb.realIDBAdapter.getEntry("e1")).resolves.toEqual(makeEntry("e1"))
  })

  it("Journals-Cache läuft verschlüsselt über den Meta-Store", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)

    const journals = [{ id: "j1", name: "Synthetisches Journal", color: "#007AFF" }]
    await idb.realIDBAdapter.putJournals!(journals as never)
    expect(await idb.rawIDBAdapter.getMeta("journalsCache")).toMatch(/^enc1:/)
    await expect(idb.realIDBAdapter.getJournals!()).resolves.toEqual(journals)
  })
})

describe("korrupte Envelopes (B08)", () => {
  // Bis B08 rejectete decodeMany via Promise.all beim ERSTEN unlesbaren Record —
  // ein einziges korruptes Envelope (Multi-Tab-Reset mit altem Session-DEK,
  // Storage-Korruption) machte die komplette Offline-Timeline dauerhaft leer.
  it("ein korruptes Envelope macht den Store nicht unlesbar — intakte Records bleiben lesbar", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)
    await idb.realIDBAdapter.putEntry(makeEntry("e1"))
    await idb.realIDBAdapter.putEntry(makeEntry("e2"))

    // e2 korrumpieren: Ciphertext-Byte kippen (GCM-Auth schlägt fehl)
    const raws = (await idb.rawIDBAdapter.getAllEntries()) as unknown as Array<
      Record<string, unknown> & { id: string; data: ArrayBuffer }
    >
    const victim = raws.find((r) => r.id === "e2")!
    const tampered = new Uint8Array(victim.data.slice(0))
    tampered[0] ^= 0xff
    await idb.rawIDBAdapter.putEntry({ ...victim, data: tampered.buffer } as never)

    const all = await idb.realIDBAdapter.getAllEntries()
    expect(all.map((e) => e.id)).toEqual(["e1"])
    await expect(idb.realIDBAdapter.getEntry("e2")).resolves.toBeUndefined()

    // Gesperrt bleibt weiterhin ein harter Fehler — Korruptions-Toleranz darf
    // das Fail-closed-Verhalten nicht aufweichen.
    vault.lockVault()
    await expect(idb.realIDBAdapter.getAllEntries()).rejects.toBeInstanceOf(vault.VaultLockedError)
  })

  it("ein korrupter Meta-Wert liest sich als null (voller Re-Sync statt Dauerfehler)", async () => {
    const { idb, vault } = await freshModules()
    await vault.setupVault(PIN)
    await idb.realIDBAdapter.setMeta("lastSync", "2026-08-01T10:00:00.000Z")

    const stored = await idb.rawIDBAdapter.getMeta("lastSync")
    expect(stored).toMatch(/^enc1:/)
    // Ciphertext-Teil manipulieren
    const parts = stored!.split(":")
    parts[2] = parts[2].slice(0, -4) + (parts[2].endsWith("AAAA") ? "BBBB" : "AAAA")
    await idb.rawIDBAdapter.setMeta("lastSync", parts.join(":"))

    await expect(idb.realIDBAdapter.getMeta("lastSync")).resolves.toBeNull()
  })
})
