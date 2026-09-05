/**
 * Stiller PUT gegen eine Client-UUID: Nach einem Offline-Speichern hält der Editor die client-generierte
 * UUID. Wieder online traf „Fertig" ein PUT gegen eine Zeile, die es noch
 * nicht gibt — 0 Zeilen aktualisiert, Antwort trotzdem ok, der letzte Stand
 * ging verloren. Solange der Eintrag in der Edit-Queue liegt, muss der Save
 * durch die Queue laufen (isQueuedLocally), nicht per PUT. Pure-function
 * tests, Muster wie save-logic-offline.test.ts.
 */

import { describe, it, expect, vi } from "vitest"
import { saveAndClose, saveSilently } from "../src/lib/editor/save-logic"

const ENTRY_ID = "20000000-0000-4000-8000-000000000001"

const basePayload = {
  text: "Queued entry test",
  journalId: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-04T12:00:00.000Z",
  starred: false,
  tags: [],
  photos: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
}

describe("save-logic — queued entry routes through the queue, not PUT", () => {
  it("saves via saveOffline and skips the PUT while the entry is queued", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const fetchFn = vi.fn()
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline,
      isQueuedLocally: async (id) => id === ENTRY_ID,
    })
    expect(result.ok).toBe(true)
    expect(saveOffline).toHaveBeenCalledTimes(1)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("saveAndClose navigates after a queue-routed save", async () => {
    const navigate = vi.fn()
    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate,
      fetchFn: vi.fn() as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline: vi.fn().mockResolvedValue(undefined),
      isQueuedLocally: async () => true,
    })
    expect(result.ok).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it("uses the normal PUT once the queue no longer holds the entry", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    const saveOffline = vi.fn()
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline,
      isQueuedLocally: async () => false,
    })
    expect(result.ok).toBe(true)
    expect(saveOffline).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(`/api/entries/${ENTRY_ID}`)
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "PUT" })
  })

  it("stays backwards-compatible without isQueuedLocally", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline: vi.fn(),
    })
    expect(result.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("reports the offline-save error when the queue-routed save fails", async () => {
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate: () => {},
      fetchFn: vi.fn() as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline: vi.fn().mockRejectedValue(new DOMException("full", "QuotaExceededError")),
      isQueuedLocally: async () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Offline-Speicherung fehlgeschlagen")
    expect(result.error).toContain("QuotaExceededError")
  })

  it("falls through to PUT when isQueuedLocally itself throws", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: ENTRY_ID,
      navigate: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      isOnline: () => true,
      saveOffline: vi.fn(),
      isQueuedLocally: async () => { throw new Error("IDB blocked") },
    })
    expect(result.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
