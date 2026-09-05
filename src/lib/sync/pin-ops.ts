/**
 * Pin-Sync Client-Seite (Anforderung: „Wenn ich auf dem Desktop
 * einen Eintrag unpinne, muss das auch mit meinem Handy syncen.")
 *
 * `pinnedEntries` bleibt der lokale Spiegel; der Server-Zustand ist
 * `entries.pinned_at`. Lokale Pin/Unpin-Absichten leben als Op-Queue unter
 * einem meta-Key (verschlüsselt via encrypted-adapter, kein neuer Store —
 * ein IDB-Schema-Upgrade ist genau das, was eine PWA über einen Deploy
 * hinweg bricht, s. idb.ts) und werden beim nächsten Sync gepusht.
 * Last-write-wins über die Server-Ankunftsreihenfolge.
 *
 * ROLLOUT-FAIL-SAFE (bekannte Fehlerklasse „Update löscht alle Pins"): Nach dem
 * Update ist pinned_at serverseitig überall NULL, die Geräte haben aber
 * Bestands-Pins. ensurePinSyncInitialized meldet die lokalen Pins beim
 * ersten Sync als Union hoch, BEVOR applyServerPinState NULL je als Unpin
 * interpretiert (Meta-Flag) — und eine noch ungepushte lokale Absicht
 * überstimmt den Server-Spiegel immer.
 */

import type { IDBAdapter } from "@/lib/sync/idb"

export const PIN_OPS_META_KEY = "pinOpsQueue"
export const PIN_SYNC_INIT_META_KEY = "pinSyncInitialized"

export interface PinOp {
  pinned: boolean
  queuedAt: string // ISO 8601
}

export type PinOpsQueue = Record<string, PinOp>

export async function readPinOps(idb: IDBAdapter): Promise<PinOpsQueue> {
  const raw = await idb.getMeta(PIN_OPS_META_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as PinOpsQueue
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writePinOps(idb: IDBAdapter, ops: PinOpsQueue): Promise<void> {
  await idb.setMeta(PIN_OPS_META_KEY, JSON.stringify(ops))
}

/** Letzte lokale Absicht zählt — ein neuer Op ersetzt den alten der ID. */
export async function queuePinOp(idb: IDBAdapter, entryId: string, pinned: boolean): Promise<void> {
  const ops = await readPinOps(idb)
  ops[entryId] = { pinned, queuedAt: new Date().toISOString() }
  await writePinOps(idb, ops)
}

/**
 * Räumt den Op nur, wenn er noch exakt dem gesendeten Stand entspricht —
 * eine WÄHREND des Flush-Requests gequeue-te neuere Absicht bleibt liegen
 * und wird beim nächsten Sync gepusht (gleiche Race-Klasse wie das
 * dequeueIfUnchanged des Entry-Push).
 */
export async function removePinOpIfUnchanged(
  idb: IDBAdapter,
  entryId: string,
  sent: PinOp
): Promise<void> {
  const ops = await readPinOps(idb)
  const current = ops[entryId]
  if (!current) return
  if (current.pinned !== sent.pinned || current.queuedAt !== sent.queuedAt) return
  delete ops[entryId]
  await writePinOps(idb, ops)
}

/** Op einer ID bedingungslos entfernen (Tombstone: Absicht gegenstandslos). */
export async function clearPinOp(idb: IDBAdapter, entryId: string): Promise<void> {
  const ops = await readPinOps(idb)
  if (!(entryId in ops)) return
  delete ops[entryId]
  await writePinOps(idb, ops)
}

/**
 * Union-Upload der Bestands-Pins, genau einmal pro Gerät: jeder lokale Pin
 * wird als pinned-Op gequeued (ohne eine bereits vorhandene — neuere —
 * Absicht zu überschreiben), dann wird das Init-Flag gesetzt. Erst ab dann
 * darf applyServerPinState ein Server-NULL als Unpin anwenden.
 */
export async function ensurePinSyncInitialized(idb: IDBAdapter): Promise<void> {
  if ((await idb.getMeta(PIN_SYNC_INIT_META_KEY)) !== null) return
  const ops = await readPinOps(idb)
  // Optional call: läuft in jedem sync() — Bestands-Test-Stubs implementieren
  // den Pin-Store nicht (gleiche Toleranz wie idb.deletePin?. in der Engine).
  for (const pin of (await idb.listPins?.()) ?? []) {
    ops[pin.entryId] ??= { pinned: true, queuedAt: pin.pinnedAt }
  }
  await writePinOps(idb, ops)
  await idb.setMeta(PIN_SYNC_INIT_META_KEY, new Date().toISOString())
}

/**
 * Pull-Anwendung des Server-Pin-Zustands für einen Eintrag.
 *
 * - `undefined` (Feed eines alten Servers ohne Pin-Sync): No-op.
 * - offene lokale Absicht: No-op — lokale Intention schlägt Server-Spiegel,
 *   bis der Op gepusht ist.
 * - gesetzt: Pin übernehmen. Ohne lokalen Pin wird adoptiert
 *   (mediaUrlsPending — der Feed trägt keine Medien-Metadaten;
 *   backfillPinnedMedia löst die URLs später auf).
 * - NULL: nur NACH der Erst-Initialisierung als Unpin anwenden —
 *   deletePin + Cache-Bytes freigeben (der Sinn des Unpins).
 */
export async function applyServerPinState(
  idb: IDBAdapter,
  entryId: string,
  serverPinnedAt: string | null | undefined,
  uncacheEntryMedia?: (entryId: string) => Promise<void>
): Promise<void> {
  if (serverPinnedAt === undefined) return

  const ops = await readPinOps(idb)
  if (ops[entryId]) return

  if (serverPinnedAt !== null) {
    const existing = await idb.getPin(entryId)
    if (existing) {
      if (existing.pinnedAt !== serverPinnedAt) {
        await idb.putPin({ ...existing, pinnedAt: serverPinnedAt })
      }
    } else {
      await idb.putPin({
        entryId,
        pinnedAt: serverPinnedAt,
        mediaUrls: [],
        mediaUrlsPending: true,
      })
    }
    return
  }

  if ((await idb.getMeta(PIN_SYNC_INIT_META_KEY)) === null) return
  if (await idb.getPin(entryId)) {
    await idb.deletePin(entryId)
    await uncacheEntryMedia?.(entryId)
  }
}
