/**
 * Versionsfreies Öffnen der IndexedDB.
 *
 * Eine PWA fährt über einen Deploy hinweg alte und neue Bundles parallel: die
 * Shell kann aus dem Service-Worker-Cache kommen, während die Datenbank auf der
 * Platte schon von einem neueren Bundle hochgezogen wurde. Mit fest verdrahteter
 * Versionsnummer wirft `open()` dann VersionError und reißt sämtliche
 * IDB-Operationen mit — leere Timeline, Offline-Speichern schlägt fehl.
 *
 * Getestet wird gegen fake-indexeddb, also gegen eine echte IDB-Implementierung.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

const DB_NAME = "within-sync"

const KEY_PATHS: Record<string, string> = {
  entries:        "id",
  editQueue:      "entryId",
  conflictCopies: "id",
  meta:           "key",
  pinnedEntries:  "entryId",
  mediaLRU:       "url",
  mediaOutbox:    "id",
  journals:       "id",
}
const REQUIRED = [
  "entries", "editQueue", "conflictCopies", "meta", "pinnedEntries", "mediaLRU",
  "mediaOutbox",
]

/** Frische IDB-Instanz + frisch geladenes Modul (der Adapter cached die Verbindung). */
async function freshAdapter() {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  const mod = await import("../src/lib/sync/idb")
  return mod.realIDBAdapter
}

/** Legt eine Datenbank in einer bestimmten Version mit bestimmten Stores an. */
function seedDB(version: number, stores: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: KEY_PATHS[name] })
        }
      }
    }
    req.onsuccess = () => { req.result.close(); resolve() }
    req.onerror = () => reject(req.error)
  })
}

function openPlain(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

describe("IDB öffnet versionsunabhängig", () => {
  beforeEach(() => { vi.resetModules() })

  it("legt bei einer frischen Installation alle benötigten Stores an", async () => {
    const idb = await freshAdapter()
    await idb.setMeta("lastSync", "2026-07-27T00:00:00.000Z")

    const db = await openPlain()
    for (const name of REQUIRED) expect([...db.objectStoreNames]).toContain(name)
    db.close()
  })

  it("REGRESSION: arbeitet auf einer Datenbank, die bereits auf einer höheren Version steht", async () => {
    // Der reale Fall: ein neueres Bundle hat die DB auf v4 gehoben, danach läuft
    // wieder älterer Code. Mit `open(DB_NAME, 3)` gäbe das VersionError.
    globalThis.indexedDB = new IDBFactory()
    await seedDB(9, [...REQUIRED, "journals"])

    vi.resetModules()
    const { realIDBAdapter } = await import("../src/lib/sync/idb")

    await expect(realIDBAdapter.setMeta("lastSync", "x")).resolves.toBeUndefined()
    expect(await realIDBAdapter.getMeta("lastSync")).toBe("x")

    const db = await openPlain()
    expect(db.version).toBe(9) // kein unnötiges Upgrade
    db.close()
  })

  it("zieht fehlende Stores per Upgrade nach, ohne vorhandene Daten zu verlieren", async () => {
    globalThis.indexedDB = new IDBFactory()
    await seedDB(1, ["entries", "meta"]) // alter Stand ohne pinnedEntries/mediaLRU

    // Datensatz ablegen, der das Upgrade überleben muss
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME)
      req.onsuccess = () => {
        const db = req.result
        const t = db.transaction("meta", "readwrite")
        t.objectStore("meta").put({ key: "lastSync", value: "bewahrt" })
        t.oncomplete = () => { db.close(); resolve() }
        t.onerror = () => reject(t.error)
      }
      req.onerror = () => reject(req.error)
    })

    vi.resetModules()
    const { realIDBAdapter } = await import("../src/lib/sync/idb")
    await realIDBAdapter.putPin({ entryId: "e1", pinnedAt: "2026-07-27T00:00:00.000Z", mediaUrls: [] })

    expect(await realIDBAdapter.getMeta("lastSync")).toBe("bewahrt")
    const db = await openPlain()
    for (const name of REQUIRED) expect([...db.objectStoreNames]).toContain(name)
    expect(db.version).toBe(2) // genau ein Upgrade-Schritt
    db.close()
  })

  it("legt keinen eigenen journals-Store an — der Cache lebt im meta-Store", async () => {
    const idb = await freshAdapter()
    await idb.putJournals?.([
      { id: "10000000-0000-4000-8000-000000000001", name: "Tagebuch", color: "#334155", entryCount: 3 },
    ])

    expect(await idb.getJournals?.()).toHaveLength(1)
    const db = await openPlain()
    expect([...db.objectStoreNames]).not.toContain("journals")
    db.close()
  })

  it("liefert eine leere Liste statt zu werfen, wenn der Cache beschädigt ist", async () => {
    const idb = await freshAdapter()
    await idb.setMeta("journalsCache", "{kein json")

    expect(await idb.getJournals?.()).toEqual([])
  })
})
