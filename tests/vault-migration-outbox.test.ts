/**
 * runVaultMigration lief bei JEDEM
 * Unlock per getAll() über ALLE Stores — auch über mediaOutbox, dessen
 * Blobs bis zum 250-MB-Budget anwachsen. getAll deserialisiert jeden Blob in
 * ein einziges Array: genau der RAM-Spike, den
 * listOutboxMediaForEntry bereits verbietet (Handy-Tab-Kill beim Entsperren
 * nach einem Offline-Foto-Tag).
 *
 * Regel: mediaOutbox wird per getAllKeys + Einzel-Get migriert — maximal ein
 * Blob gleichzeitig im Speicher.
 *
 * Muster wie vault-encrypted-adapter.test.ts: fake-indexeddb, frische
 * IDBFactory + resetModules pro Test. Nur synthetische Daten.
 */
import "fake-indexeddb/auto"
import { IDBFactory, IDBObjectStore } from "fake-indexeddb"
import { describe, it, expect, beforeEach, vi } from "vitest"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  vi.restoreAllMocks()
})

const PIN = "test-pin-123456"

function makeOutboxItem(id: string): OutboxMedia {
  return {
    id,
    entryId: "20000000-0000-4000-8000-000000000001",
    blob: new Blob([new Uint8Array(64).fill(7)], { type: "image/jpeg" }),
    fileName: `synthetic-${id}.jpg`,
    mimeType: "image/jpeg",
    type: "photo",
    size: 64,
    queuedAt: "2026-08-01T10:00:00.000Z",
    attempts: 0,
  }
}

describe("Vault-Migration mediaOutbox (B09)", () => {
  it("migriert Outbox-Records ohne getAll auf dem mediaOutbox-Store", async () => {
    const idb = await import("../src/lib/sync/idb")
    const vault = await import("../src/lib/vault/vault")

    // Klartext-Bestand VOR dem Vault-Setup (Passthrough)
    await idb.rawIDBAdapter.putOutboxMedia!(makeOutboxItem("m1"))
    await idb.rawIDBAdapter.putOutboxMedia!(makeOutboxItem("m2"))

    await vault.setupVault(PIN)

    const getAllSpy = vi.spyOn(IDBObjectStore.prototype, "getAll")
    await idb.runVaultMigration()

    // RAM-Regel: der Blob-Store wird nie als Ganzes materialisiert.
    const outboxGetAlls = getAllSpy.mock.instances.filter(
      (store) => (store as unknown as { name: string }).name === "mediaOutbox"
    )
    expect(outboxGetAlls).toHaveLength(0)

    // Funktional: beide Records sind danach verschlüsselt und lesbar.
    const raw = (await idb.rawIDBAdapter.listOutboxMedia!()) as unknown as Array<
      Record<string, unknown>
    >
    expect(raw).toHaveLength(2)
    for (const record of raw) expect(record.__enc).toBe(1)

    const decoded = await idb.realIDBAdapter.listOutboxMedia!()
    expect(decoded.map((m) => m.id).sort()).toEqual(["m1", "m2"])
    expect(decoded[0].blob).toBeInstanceOf(Blob)
  })

  it("ist idempotent — zweiter Lauf lässt verschlüsselte Records unangetastet", async () => {
    const idb = await import("../src/lib/sync/idb")
    const vault = await import("../src/lib/vault/vault")

    await idb.rawIDBAdapter.putOutboxMedia!(makeOutboxItem("m1"))
    await vault.setupVault(PIN)
    await idb.runVaultMigration()
    const firstRaw = (await idb.rawIDBAdapter.listOutboxMedia!()) as unknown as Array<
      Record<string, unknown>
    >
    await idb.runVaultMigration()
    const secondRaw = (await idb.rawIDBAdapter.listOutboxMedia!()) as unknown as Array<
      Record<string, unknown>
    >
    // Envelope unverändert (kein Re-Encrypt bereits verschlüsselter Records)
    expect(new Uint8Array(secondRaw[0].data as ArrayBuffer)).toEqual(
      new Uint8Array(firstRaw[0].data as ArrayBuffer)
    )
  })
})
