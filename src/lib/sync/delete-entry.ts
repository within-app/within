/**
 * Entry-Löschung mit Offline-Fallback (Befund: offline löschen
 * ging nicht — beide Delete-Handler fetchten direkt und landeten offline im
 * catch, obwohl die Edit-Queue die Operation `delete` kennt).
 *
 * Online:  DELETE /api/entries/[id]. 404 zählt als Erfolg — der Eintrag hat
 *          den Server nie erreicht (offline erstellt und wieder gelöscht) oder
 *          ist bereits tombstoned; beides ist idempotent erledigt. Ein noch
 *          gequeuter Create/Update wird dequeued, sonst würde der nächste Push
 *          den gerade gelöschten Eintrag serverseitig wieder anlegen.
 * Offline: Tombstone in die Edit-Queue (operation "delete", ersetzt über den
 *          keyPath entryId einen evtl. gequeuten Create/Update) — der nächste
 *          Push spielt das DELETE nach (engine.push).
 * Beide Pfade räumen die lokalen Reste auf: IDB-Spiegel, Media-Cache-Meta,
 * wartende Outbox-Dateien.
 */

import type { IDBAdapter } from "@/lib/sync/idb"
import { deleteCachedEntryMedia } from "@/lib/sync/entry-media-cache"

export type DeleteEntryResult = "deleted" | "queued" | "failed"

/** UI-Entscheidung nach dem Löschversuch. "failed" (Server erreichbar,
 *  aber 5xx/403) muss sichtbar scheitern — Dialog-zu-und-nichts-sagen las
 *  sich wie Erfolg, obwohl der Eintrag stehen blieb. */
export function deleteOutcomeUi(result: DeleteEntryResult): {
  leaveView: boolean
  showError: boolean
} {
  if (result === "failed") return { leaveView: false, showError: true }
  return { leaveView: true, showError: false }
}

export async function deleteEntryWithOfflineFallback(
  entryId: string,
  idb: IDBAdapter,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<DeleteEntryResult> {
  let res: Response | null = null
  try {
    res = await fetchFn(`/api/entries/${entryId}`, { method: "DELETE" })
  } catch {
    res = null // Netzwerkfehler → Offline-Pfad
  }

  // Server erreichbar, aber Fehler (5xx/403/…): NICHT queuen — der Eintrag
  // bleibt sichtbar und der Nutzer sieht, dass das Löschen nicht durchkam.
  if (res && !res.ok && res.status !== 404) return "failed"

  if (res) {
    await idb.dequeueEdit(entryId)
  } else {
    await idb.enqueueEdit({
      entryId,
      operation: "delete",
      payload: null,
      queuedAt: new Date().toISOString(),
    })
  }

  await idb.deleteEntry(entryId)
  await deleteCachedEntryMedia(idb, entryId)
  // Pin-Record + verschlüsselte Cache-Bytes des gelöschten Eintrags
  // freigeben — gepinnte Zeilen heilt die Eviction nie selbst.
  try {
    await idb.deletePin(entryId)
    const { uncacheEntryMedia } = await import("@/lib/offline/media-cache")
    await uncacheEntryMedia(entryId)
  } catch (err) {
    console.error("[within/delete] pin cleanup after delete failed:", err)
  }
  try {
    if (idb.listOutboxMediaForEntry && idb.deleteOutboxMedia) {
      for (const item of await idb.listOutboxMediaForEntry(entryId)) {
        await idb.deleteOutboxMedia(item.id)
      }
    }
  } catch (err) {
    console.error("[within/delete] outbox cleanup after delete failed:", err)
  }

  return res ? "deleted" : "queued"
}
