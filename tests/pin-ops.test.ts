/**
 * Pin-Sync Client-Seite — pin-ops.ts.
 *
 * Lokale Pin/Unpin-Absichten leben als Op-Queue im (verschlüsselten)
 * meta-Store und werden beim nächsten Sync zum Server gepusht; der Pull
 * wendet den Server-Zustand an — außer eine lokale Absicht ist noch
 * ungepusht (lokale Intention schlägt Server-Spiegel bis zum Flush).
 *
 * ROLLOUT-FAIL-SAFE (Pflicht-Test, B14-Fehlerklasse „Update löscht alle
 * Pins"): Nach dem Update ist pinned_at serverseitig überall NULL, die
 * Geräte haben aber Bestands-Pins. Der Client meldet beim ersten Sync seine
 * lokalen Pins als Union hoch, BEVOR NULL je als Unpin interpretiert wird
 * (Meta-Flag pinSyncInitialized).
 *
 * Nur synthetische Daten.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import type { IDBAdapter, PinnedEntry } from "../src/lib/sync/idb"
import {
  PIN_OPS_META_KEY,
  PIN_SYNC_INIT_META_KEY,
  readPinOps,
  queuePinOp,
  removePinOpIfUnchanged,
  ensurePinSyncInitialized,
  applyServerPinState,
} from "../src/lib/sync/pin-ops"

const ENTRY_A = "20000000-0000-4000-8000-000000000001"
const ENTRY_B = "20000000-0000-4000-8000-000000000002"

function makeStub() {
  const meta = new Map<string, string>()
  const pins = new Map<string, PinnedEntry>()
  const uncached: string[] = []
  const idb = {
    getMeta: async (k: string) => meta.get(k) ?? null,
    setMeta: async (k: string, v: string) => { meta.set(k, v) },
    putPin: async (p: PinnedEntry) => { pins.set(p.entryId, p) },
    getPin: async (id: string) => pins.get(id),
    deletePin: async (id: string) => { pins.delete(id) },
    listPins: async () => [...pins.values()],
  } as unknown as IDBAdapter
  const uncache = async (entryId: string) => { uncached.push(entryId) }
  return { idb, meta, pins, uncached, uncache }
}

describe("Op-Queue (queuePinOp / readPinOps / removePinOpIfUnchanged)", () => {
  let s: ReturnType<typeof makeStub>
  beforeEach(() => { s = makeStub() })

  it("queued und liest Ops; ein zweiter Op ersetzt den ersten (letzte lokale Absicht zählt)", async () => {
    await queuePinOp(s.idb, ENTRY_A, true)
    await queuePinOp(s.idb, ENTRY_A, false)
    const ops = await readPinOps(s.idb)
    expect(Object.keys(ops)).toEqual([ENTRY_A])
    expect(ops[ENTRY_A].pinned).toBe(false)
  })

  it("kaputtes meta-JSON degradiert zu leerer Queue (kein Crash)", async () => {
    await s.idb.setMeta(PIN_OPS_META_KEY, "{not json")
    expect(await readPinOps(s.idb)).toEqual({})
  })

  it("removePinOpIfUnchanged entfernt nur den gesendeten Stand — eine neuere Absicht bleibt (B02-Klasse)", async () => {
    await queuePinOp(s.idb, ENTRY_A, true)
    const sent = (await readPinOps(s.idb))[ENTRY_A]
    // Nutzer entpinnt, WÄHREND der Flush-Request läuft:
    await queuePinOp(s.idb, ENTRY_A, false)
    await removePinOpIfUnchanged(s.idb, ENTRY_A, sent)
    const ops = await readPinOps(s.idb)
    expect(ops[ENTRY_A]?.pinned).toBe(false)

    // Unverändert → wird entfernt.
    const sent2 = ops[ENTRY_A]
    await removePinOpIfUnchanged(s.idb, ENTRY_A, sent2)
    expect(await readPinOps(s.idb)).toEqual({})
  })
})

describe("ensurePinSyncInitialized — Rollout-Union-Fail-safe", () => {
  let s: ReturnType<typeof makeStub>
  beforeEach(() => { s = makeStub() })

  it("meldet Bestands-Pins genau einmal als Ops an (Union), setzt das Flag", async () => {
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    await ensurePinSyncInitialized(s.idb)
    const ops = await readPinOps(s.idb)
    expect(ops[ENTRY_A]?.pinned).toBe(true)
    expect(await s.idb.getMeta(PIN_SYNC_INIT_META_KEY)).not.toBeNull()

    // Zweiter Lauf: kein Re-Queue (sonst würde ein späterer Remote-Unpin
    // bei jedem Sync wieder überschrieben).
    await queuePinOp(s.idb, ENTRY_A, false)
    await ensurePinSyncInitialized(s.idb)
    expect((await readPinOps(s.idb))[ENTRY_A].pinned).toBe(false)
  })

  it("überschreibt keine bereits vorhandene (neuere) Absicht beim Init", async () => {
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [] })
    await queuePinOp(s.idb, ENTRY_A, false) // Nutzer hat direkt vor dem Update entpinnt
    await ensurePinSyncInitialized(s.idb)
    expect((await readPinOps(s.idb))[ENTRY_A].pinned).toBe(false)
  })
})

describe("applyServerPinState — Pull-Anwendung", () => {
  let s: ReturnType<typeof makeStub>
  beforeEach(() => { s = makeStub() })

  const init = () => ensurePinSyncInitialized(s.idb)

  it("ROLLOUT-FAIL-SAFE: pinned_at NULL räumt Bestands-Pins NICHT weg, solange nicht initialisiert", async () => {
    // Exakt die B14-Fehlerklasse „Update löscht alle Pins": Server-NULL darf
    // vor der Erst-Initialisierung (Union-Upload) nie als Unpin gelten.
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    await applyServerPinState(s.idb, ENTRY_A, null, s.uncache)
    expect(s.pins.has(ENTRY_A)).toBe(true)
    expect(s.uncached).toEqual([])
  })

  it("nach Init: pinned_at NULL → deletePin + Cache-Bytes freigeben (der Sinn des Unpins)", async () => {
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    await init()
    // Union-Op aus dem Init simuliert gepusht:
    await removePinOpIfUnchanged(s.idb, ENTRY_A, (await readPinOps(s.idb))[ENTRY_A])

    await applyServerPinState(s.idb, ENTRY_A, null, s.uncache)
    expect(s.pins.has(ENTRY_A)).toBe(false)
    expect(s.uncached).toEqual([ENTRY_A])
  })

  it("pinned_at gesetzt + kein lokaler Pin → adoptiert (mediaUrlsPending, Medien-Backfill folgt)", async () => {
    await init()
    await applyServerPinState(s.idb, ENTRY_B, "2026-08-23T10:00:00.000Z", s.uncache)
    const pin = s.pins.get(ENTRY_B)
    expect(pin).toBeDefined()
    expect(pin?.pinnedAt).toBe("2026-08-23T10:00:00.000Z")
    expect(pin?.mediaUrls).toEqual([])
    expect(pin?.mediaUrlsPending).toBe(true)
  })

  it("pinned_at gesetzt + lokaler Pin vorhanden → mediaUrls bleiben, pinnedAt wird übernommen", async () => {
    await init()
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: ["/media/a.jpg"] })
    await applyServerPinState(s.idb, ENTRY_A, "2026-08-23T10:00:00.000Z", s.uncache)
    const pin = s.pins.get(ENTRY_A)
    expect(pin?.mediaUrls).toEqual(["/media/a.jpg"])
    expect(pin?.pinnedAt).toBe("2026-08-23T10:00:00.000Z")
    expect(pin?.mediaUrlsPending).toBeUndefined()
  })

  it("pendende lokale Absicht schlägt Server-Spiegel: keine Anwendung, solange der Op ungepusht ist", async () => {
    await init()
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [] })
    await queuePinOp(s.idb, ENTRY_A, true) // frisch gepinnt, noch nicht gepusht
    // Server kennt den Pin noch nicht (NULL) — darf ihn NICHT wegräumen:
    await applyServerPinState(s.idb, ENTRY_A, null, s.uncache)
    expect(s.pins.has(ENTRY_A)).toBe(true)
  })

  it("pinnedAt undefined (alter Server ohne Pin-Sync) → No-op, auch nach Init", async () => {
    await init()
    s.pins.set(ENTRY_A, { entryId: ENTRY_A, pinnedAt: "2026-08-01T00:00:00.000Z", mediaUrls: [] })
    await applyServerPinState(s.idb, ENTRY_A, undefined, s.uncache)
    expect(s.pins.has(ENTRY_A)).toBe(true)
    expect(s.uncached).toEqual([])
  })
})

describe("Quell-Kontrakt: UI und Sync-Hook sind an die Op-Queue angeschlossen", () => {
  it("useOfflinePin queued Pin- UND Unpin-Ops und stößt den Sync an", () => {
    const src = readFileSync(join(__dirname, "../src/hooks/useOfflinePin.ts"), "utf8")
    expect(src).toContain("queuePinOp")
    expect(src).toContain("triggerSync")
  })

  it("useSync stößt nach jedem Sync den Medien-Backfill adoptierter Pins an", () => {
    const src = readFileSync(join(__dirname, "../src/hooks/useSync.ts"), "utf8")
    expect(src).toContain("backfillPinnedMedia")
  })
})
