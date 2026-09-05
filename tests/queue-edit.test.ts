/**
 * Offline autosave must not duplicate new entries.
 *
 * buildQueuedEdit is a pure function — the correct deduplication contract is:
 *   1. Without entryId → generates a UUID, operation = "create"
 *   2. With entryId    → reuses it, operation = "update"
 *
 * The bug was in saveOffline (entry-editor.tsx): it never passed
 * savedEntryIdRef.current, so every 30-second autosave generated a fresh UUID
 * and wrote a separate IDB queue row. On reconnect each row upserted a DB row.
 *
 * The fix: saveOffline now uses savedEntryIdRef.current as entryId and
 * stores the generated id back into the ref on the first call.
 *
 * NOTE: Component-level verification of the ref-tracking behavior requires
 * React Testing Library (browser env). These unit tests cover the underlying
 * pure function contract; the component fix is verified by manual QA and the
 * deduplication contract below.
 */
import { describe, it, expect, vi } from "vitest"
import { buildQueuedEdit } from "../src/lib/sync/queue-edit"

const basePayload = {
  text: "Offline test entry",
  journalId: "j-offline",
  createdAt: "2026-07-17T12:00:00.000Z",
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

const queuedAt = "2026-07-17T12:00:00.000Z"

describe("buildQueuedEdit — contract", () => {
  it("generates a UUID and sets operation=create when no entryId is supplied", () => {
    const edit = buildQueuedEdit({ payload: basePayload, queuedAt })
    expect(typeof edit.entryId).toBe("string")
    expect(edit.entryId.length).toBeGreaterThan(0)
    expect(edit.operation).toBe("create")
  })

  it("reuses the supplied entryId and sets operation=update", () => {
    const id = "existing-entry-abc"
    const edit = buildQueuedEdit({ entryId: id, payload: basePayload, queuedAt })
    expect(edit.entryId).toBe(id)
    expect(edit.operation).toBe("update")
  })

  it("two calls without entryId produce distinct queue keys (root cause of the duplicate bug)", () => {
    const e1 = buildQueuedEdit({ payload: basePayload, queuedAt })
    const e2 = buildQueuedEdit({ payload: basePayload, queuedAt })
    // Pure-function behaviour: each call without entryId generates a new UUID.
    // The BUG was that saveOffline called this twice without threading the first
    // call's entryId back through savedEntryIdRef → two separate IDB rows.
    expect(e1.entryId).not.toBe(e2.entryId)
  })

  it("ref-tracking pattern: second offline save reuses the first save's entryId (fixed behaviour)", () => {
    // Simulate what the fixed saveOffline does:
    //   first call  → entryId undefined → generates UUID, store in savedEntryIdRef.current
    //   second call → passes savedEntryIdRef.current as entryId → same queue key
    const firstEdit = buildQueuedEdit({ payload: basePayload, queuedAt })
    const trackedId = firstEdit.entryId  // savedEntryIdRef.current = edit.entryId

    const secondEdit = buildQueuedEdit({ entryId: trackedId, payload: basePayload, queuedAt })
    expect(secondEdit.entryId).toBe(trackedId)
    expect(secondEdit.operation).toBe("update")
    // IDB editQueue uses keyPath="entryId" with put() (upsert), so both writes
    // land on the same row — exactly one entry in the queue and one in the DB.
  })

  it("payload fields are written to the SyncEntry", () => {
    const edit = buildQueuedEdit({ payload: basePayload, queuedAt })
    const p = edit.payload!
    expect(p.text).toBe(basePayload.text)
    expect(p.journalId).toBe(basePayload.journalId)
    expect(p.starred).toBe(false)
  })

  it("falls back to Math.random UUID when crypto.randomUUID throws (non-secure context)", () => {
    // Simulates a non-HTTPS environment where isSecureContext may be false
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new DOMException("Not supported in this context", "NotSupportedError")
    })
    try {
      const edit = buildQueuedEdit({ payload: basePayload, queuedAt })
      expect(typeof edit.entryId).toBe("string")
      expect(edit.entryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(typeof edit.payload!.revisionId).toBe("string")
      expect(edit.payload!.revisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
