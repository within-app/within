/**
 * Save-logic offline path contract.
 *
 * Verifies that _performSave correctly routes through the saveOffline
 * callback when offline, and reports the right result/error in each case.
 *
 * These are pure-function tests — no browser APIs involved.
 */
import { describe, it, expect, vi } from "vitest"
import { saveAndClose, saveSilently } from "../src/lib/editor/save-logic"

const basePayload = {
  text: "Offline test entry",
  journalId: "j-offline",
  createdAt: "2026-07-26T12:00:00.000Z",
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

describe("save-logic offline path", () => {
  it("saveAndClose: calls saveOffline and returns ok=true when offline + saveOffline succeeds", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const navigate    = vi.fn()

    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      isOnline: () => false,
      saveOffline,
    })

    expect(saveOffline).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(navigate).toHaveBeenCalledOnce()
  })

  it("saveAndClose: returns offline error when saveOffline throws", async () => {
    const saveOffline = vi.fn().mockRejectedValue(new Error("IDB failed"))
    const navigate    = vi.fn()

    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      isOnline: () => false,
      saveOffline,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Offline-Speicherung fehlgeschlagen – bitte erneut versuchen")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("saveSilently: calls saveOffline without navigating when offline + saveOffline succeeds", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const navigate    = vi.fn()

    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      isOnline: () => false,
      saveOffline,
    })

    expect(saveOffline).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("falls back to saveOffline on TypeError while onLine=true (Android false-positive)", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const navigate    = vi.fn()
    const fetchFn     = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))

    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      fetchFn,
      isOnline: () => true,
      saveOffline,
    })

    expect(fetchFn).toHaveBeenCalled()
    expect(saveOffline).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it("no saveOffline provided offline: returns 'nicht verfügbar' error", async () => {
    const navigate = vi.fn()

    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      isOnline: () => false,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Offline-Speicherung nicht verfügbar")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("saveAndClose: navigate is isolated — a throwing navigate propagates, not masked as save-error", async () => {
    // Structural invariant: navigate() must NOT be inside the same try-catch as
    // saveOffline(). If navigate throws (e.g., a stale React closure in some
    // environments), the error should propagate to the caller rather than being
    // silently swallowed as "Offline-Speicherung fehlgeschlagen".
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const navigate    = vi.fn().mockImplementation(() => { throw new Error("navigate-failed") })

    await expect(
      saveAndClose(basePayload, {
        entryId: null,
        savedEntryId: null,
        navigate,
        isOnline: () => false,
        saveOffline,
      })
    ).rejects.toThrow("navigate-failed")

    // saveOffline was still called (the save itself succeeded)
    expect(saveOffline).toHaveBeenCalledOnce()
  })
})
