/**
 * Offline editor enqueue tests.
 * Tests the buildQueuedEdit helper and enqueueOfflineEdit utility that the
 * entry editor uses when navigator.onLine is false (an open assumption).
 * Synthetic data only (Constraint D).
 */
import { describe, it, expect, vi } from "vitest"

import {
  buildQueuedEdit,
  type OfflineEditorPayload,
} from "../src/lib/sync/queue-edit"

const ENTRY_ID   = "20000000-0000-4000-8000-000000000088"
const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

const BASE_PAYLOAD: OfflineEditorPayload = {
  text: "Synthetic offline entry",
  journalId: JOURNAL_ID,
  createdAt: "2026-07-01T09:00:00.000Z",
  starred: false,
  tags: ["travel", "notes"],
  photos: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
}

describe("buildQueuedEdit — create operation", () => {
  it("builds a QueuedEdit with operation=create when no entryId provided", () => {
    const edit = buildQueuedEdit({ payload: BASE_PAYLOAD, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.operation).toBe("create")
  })

  it("generates a UUID for entryId when none is provided", () => {
    const edit = buildQueuedEdit({ payload: BASE_PAYLOAD, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.entryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("populates the SyncEntry payload with the correct fields", () => {
    const queuedAt = "2026-07-01T09:00:01.000Z"
    const edit = buildQueuedEdit({ payload: BASE_PAYLOAD, queuedAt })
    expect(edit.payload).not.toBeNull()
    expect(edit.payload!.text).toBe(BASE_PAYLOAD.text)
    expect(edit.payload!.journalId).toBe(JOURNAL_ID)
    expect(edit.payload!.tags).toEqual(["travel", "notes"])
    expect(edit.payload!.starred).toBe(false)
    expect(edit.queuedAt).toBe(queuedAt)
  })

  it("uses createdAt from payload as entry createdAt", () => {
    const edit = buildQueuedEdit({ payload: BASE_PAYLOAD, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.payload!.createdAt).toBe(BASE_PAYLOAD.createdAt)
  })

  it("generates a temporary revisionId UUID", () => {
    const edit = buildQueuedEdit({ payload: BASE_PAYLOAD, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.payload!.revisionId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("buildQueuedEdit — update operation", () => {
  it("builds a QueuedEdit with operation=update when entryId is provided", () => {
    const edit = buildQueuedEdit({
      entryId: ENTRY_ID,
      payload: BASE_PAYLOAD,
      queuedAt: "2026-07-01T09:00:01.000Z",
    })
    expect(edit.operation).toBe("update")
    expect(edit.entryId).toBe(ENTRY_ID)
  })

  it("preserves the provided entryId in the SyncEntry payload", () => {
    const edit = buildQueuedEdit({
      entryId: ENTRY_ID,
      payload: BASE_PAYLOAD,
      queuedAt: "2026-07-01T09:00:01.000Z",
    })
    expect(edit.payload!.id).toBe(ENTRY_ID)
  })
})

describe("buildQueuedEdit — field mapping", () => {
  it("maps locationName, locationLat, locationLng from payload", () => {
    const withLocation: OfflineEditorPayload = {
      ...BASE_PAYLOAD,
      locationName: "Berlin, Deutschland",
      locationLat: 52.52,
      locationLng: 13.405,
    }
    const edit = buildQueuedEdit({ payload: withLocation, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.payload!.locationName).toBe("Berlin, Deutschland")
    expect(edit.payload!.locationLat).toBe(52.52)
    expect(edit.payload!.locationLng).toBe(13.405)
  })

  it("maps weather fields from payload", () => {
    const withWeather: OfflineEditorPayload = {
      ...BASE_PAYLOAD,
      weatherDescription: "Sonnig",
      weatherTempCelsius: 22,
      weatherIcon: "sun",
    }
    const edit = buildQueuedEdit({ payload: withWeather, queuedAt: "2026-07-01T09:00:01.000Z" })
    expect(edit.payload!.weatherDescription).toBe("Sonnig")
    expect(edit.payload!.weatherTempCelsius).toBe(22)
    expect(edit.payload!.weatherIcon).toBe("sun")
  })
})
