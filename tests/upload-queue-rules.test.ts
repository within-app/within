/**
 * Foto an einen noch gequeuten Eintrag:
 *
 * Der PhotoUploader lud online IMMER direkt gegen /api/upload — auch wenn der
 * Ziel-Eintrag noch (oder wieder) in der editQueue lag und serverseitig gar
 * nicht existiert. Ohne entryId schreibt der Server die Datei ohne media-Row;
 * buildQueuedEdit verwirft payload.photos (SyncEntry kennt kein photos-Feld) —
 * die Datei wurde nie verknüpft: Foto-Kachel im Editor, aber kein Foto in
 * Timeline/Detail, Datei verwaist auf dem Pi.
 *
 * Regel: Ist der Ziel-Eintrag lokal gequeut, gehört die Datei in die
 * mediaOutbox (flushMedia verknüpft sie nach dem Push idempotent) — exakt wie
 * im Offline-Fall.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { isEntryQueuedLocally } from "@/lib/sync/queue-status"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { QueuedEdit } from "@/lib/sync/types"

function adapterWithQueue(queue: QueuedEdit[]): IDBAdapter {
  return { listQueue: async () => queue } as unknown as IDBAdapter
}

const QUEUED_EDIT: QueuedEdit = {
  entryId: "e1",
  operation: "update",
  payload: null,
  queuedAt: "2026-08-01T10:00:00.000Z",
}

describe("Upload-Ziel-Regeln (B05)", () => {
  it("isEntryQueuedLocally: findet den gequeuten Eintrag", async () => {
    expect(await isEntryQueuedLocally("e1", adapterWithQueue([QUEUED_EDIT]))).toBe(true)
    expect(await isEntryQueuedLocally("e2", adapterWithQueue([QUEUED_EDIT]))).toBe(false)
    expect(await isEntryQueuedLocally("e1", adapterWithQueue([]))).toBe(false)
  })

  it("isEntryQueuedLocally: Adapter-Fehler (z.B. IDB nicht verfügbar) → false statt Crash", async () => {
    const broken = { listQueue: async () => { throw new Error("idb down") } } as unknown as IDBAdapter
    expect(await isEntryQueuedLocally("e1", broken)).toBe(false)
  })
})
