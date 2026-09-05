/**
 * IDB-Adapter-Hygiene, gegen fake-indexeddb.
 *
 * listOutboxMediaForEntry liest per Cursor statt getAll — getAll
 * deserialisiert JEDEN Outbox-Record inklusive Blob (bis zum 250-MB-Budget)
 * in ein Array, nur um nach entryId zu filtern.
 *
 * deleteMeta existiert, damit entryMedia:<id>-Schlüssel beim Löschen
 * eines Eintrags verschwinden statt monoton zu wachsen.
 *
 * Vorsorge (offen): getDB memoisiert das Promise — parallele Erstaufrufe
 * beim Kaltstart öffnen die DB genau einmal, statt mit dem Missing-Store-
 * Upgrade-Pfad zu kollidieren (zweite Connection ohne onversionchange blockt
 * das Upgrade → leere Timeline für die Session).
 *
 * Synthetische Daten.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import type { OutboxMedia } from "../src/lib/sync/media-outbox"

/** Frische IDB-Instanz + frisch geladenes Modul (der Adapter cached die Verbindung). */
async function freshAdapter() {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  const mod = await import("../src/lib/sync/idb")
  return mod.realIDBAdapter
}

function makeItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
  return {
    id: "outbox-1",
    entryId: "entry-1",
    blob: new Blob(["synthetic"], { type: "image/jpeg" }),
    fileName: "synthetic.jpg",
    mimeType: "image/jpeg",
    type: "photo",
    size: 9,
    queuedAt: "2026-07-27T10:00:00.000Z",
    attempts: 0,
    ...over,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("deleteMeta", () => {
  it("löscht genau den einen Schlüssel", async () => {
    const idb = await freshAdapter()
    await idb.setMeta("entryMedia:entry-1", "a")
    await idb.setMeta("entryMedia:entry-2", "b")

    await idb.deleteMeta!("entryMedia:entry-1")

    expect(await idb.getMeta("entryMedia:entry-1")).toBeNull()
    expect(await idb.getMeta("entryMedia:entry-2")).toBe("b")
  })

  it("ist idempotent — ein fehlender Schlüssel wirft nicht", async () => {
    const idb = await freshAdapter()
    await expect(idb.deleteMeta!("entryMedia:nie-da")).resolves.toBeUndefined()
  })
})

describe("listOutboxMediaForEntry", () => {
  it("liefert nur die Records des Eintrags", async () => {
    const idb = await freshAdapter()
    await idb.putOutboxMedia!(makeItem())
    await idb.putOutboxMedia!(makeItem({ id: "outbox-2", entryId: "entry-2" }))
    await idb.putOutboxMedia!(makeItem({ id: "outbox-3" }))

    const result = await idb.listOutboxMediaForEntry!("entry-1")

    expect(result.map((i) => i.id).sort()).toEqual(["outbox-1", "outbox-3"])
  })

  it("materialisiert NICHT den ganzen Store per getAll", async () => {
    const idb = await freshAdapter()
    await idb.putOutboxMedia!(makeItem())

    const getAllSpy = vi.spyOn(IDBObjectStore.prototype, "getAll")
    await idb.listOutboxMediaForEntry!("entry-1")

    expect(getAllSpy).not.toHaveBeenCalled()
  })

  it("liefert [] für einen Eintrag ohne wartende Dateien", async () => {
    const idb = await freshAdapter()
    expect(await idb.listOutboxMediaForEntry!("entry-x")).toEqual([])
  })
})

describe("getDB-Memoisierung", () => {
  it("parallele Erstaufrufe öffnen die DB nicht mehrfach", async () => {
    globalThis.indexedDB = new IDBFactory()
    vi.resetModules()
    const openSpy = vi.spyOn(globalThis.indexedDB, "open")
    const { realIDBAdapter: idb } = await import("../src/lib/sync/idb")

    await Promise.all([
      idb.getMeta("a"),
      idb.getMeta("b"),
      idb.listOutboxMedia!(),
    ])

    // Frische DB: ein versionsloses Öffnen + ein Upgrade-Öffnen (fehlende
    // Stores → Version+1). Ohne Memoisierung: bis zu zwei pro Aufrufer.
    // Seit dem Vault-Wrapper öffnet daneben within-vault (Config-Check) —
    // nach DB-Name getrennt zählen, beide sind memoisiert.
    const syncOpens = openSpy.mock.calls.filter(([name]) => name === "within-sync")
    expect(syncOpens.length).toBeLessThanOrEqual(2)
    const vaultOpens = openSpy.mock.calls.filter(([name]) => name === "within-vault")
    expect(vaultOpens.length).toBeLessThanOrEqual(1)
  })
})
