/**
 * i18n PR3 — save-logic returns stable errorKeys alongside the German legacy
 * text, so the editor can render the failure in the active UI language.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { saveSilently, type SavePayload } from "@/lib/editor/save-logic"

const PAYLOAD: SavePayload = {
  text: "synthetic",
  journalId: "00000000-0000-0000-0000-000000000001",
  createdAt: "2024-01-15T10:00:00.000Z",
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

describe("save-logic errorKey", () => {
  it("offline without saveOffline → offlineUnavailable (legacy text kept)", async () => {
    const result = await saveSilently(PAYLOAD, {
      entryId: null,
      savedEntryId: null,
      navigate: () => {},
      isOnline: () => false,
    })
    expect(result.errorKey).toBe("offlineUnavailable")
    expect(result.error).toBe("Offline-Speicherung nicht verfügbar")
  })

  it("offline save throws → offlineFailed with the cause as errorDetail", async () => {
    const result = await saveSilently(PAYLOAD, {
      entryId: null,
      savedEntryId: null,
      navigate: () => {},
      isOnline: () => false,
      saveOffline: () => Promise.reject(new DOMException("full", "QuotaExceededError")),
    })
    expect(result.errorKey).toBe("offlineFailed")
    expect(result.errorDetail).toBe(" (QuotaExceededError)")
    expect(result.error).toContain("Offline-Speicherung fehlgeschlagen (QuotaExceededError)")
  })

  it("server 500 → saveFailed", async () => {
    const result = await saveSilently(PAYLOAD, {
      entryId: "e-1",
      savedEntryId: null,
      navigate: () => {},
      isOnline: () => true,
      fetchFn: async () => new Response("boom", { status: 500 }),
    })
    expect(result.errorKey).toBe("saveFailed")
    expect(result.error).toBe("Speichern fehlgeschlagen – bitte erneut versuchen")
  })
})
