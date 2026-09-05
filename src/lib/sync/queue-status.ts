/**
 * Queue-Status-Regeln für Upload-Ziele.
 *
 * Ein Eintrag, der noch (oder wieder) in der editQueue liegt, existiert
 * serverseitig nicht — ein Direkt-Upload dorthin speichert die Datei ohne
 * media-Row und verknüpft sie nie (buildQueuedEdit trägt kein photos-Feld).
 * Solche Dateien gehören in die mediaOutbox; flushMedia lädt sie nach dem
 * Push des Eintrags idempotent hoch.
 */
import type { IDBAdapter } from "@/lib/sync/idb"

/** True, solange der Eintrag lokal in der editQueue liegt. Fehler (IDB nicht
 *  verfügbar, Vault gesperrt) lesen sich als "nicht gequeut" — dann greift der
 *  bestehende Online-Pfad und der Server antwortet ehrlich. */
export async function isEntryQueuedLocally(id: string, adapter?: IDBAdapter): Promise<boolean> {
  try {
    const idb = adapter ?? (await import("@/lib/sync/idb")).realIDBAdapter
    return (await idb.listQueue()).some((q) => q.entryId === id)
  } catch {
    return false
  }
}
