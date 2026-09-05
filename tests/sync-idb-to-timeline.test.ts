/**
 * Unit tests for syncEntriesToDateGroups thumbnail propagation.
 * Verifies that thumbnailDataUrl stored in a SyncEntry flows through to the
 * TimelineEntry.thumbnail field used by the offline timeline.
 */

import { describe, it, expect } from "vitest"
import { syncEntriesToDateGroups } from "../src/lib/sync/idb-to-timeline"
import type { SyncEntry } from "../src/lib/sync/types"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

function makeSyncEntry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    journalId: JOURNAL_ID,
    text: "Synthetic entry for timeline tests",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false,
    tags: [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    thumbnailDataUrl: null,
    deletedAt: null,
    ...overrides,
  }
}

const FAKE_DATA_URL = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAABwAQCdASoBAAEAAkA4JZACdAEO/gHOAAA="

describe("syncEntriesToDateGroups — thumbnail propagation", () => {
  it("sets thumbnail to undefined when thumbnailDataUrl is null", () => {
    const entry = makeSyncEntry({ thumbnailDataUrl: null })
    const groups = syncEntriesToDateGroups([entry])
    expect(groups).toHaveLength(1)
    expect(groups[0].entries[0].thumbnail).toBeUndefined()
  })

  it("sets thumbnail to the data URL when thumbnailDataUrl is present", () => {
    const entry = makeSyncEntry({ thumbnailDataUrl: FAKE_DATA_URL })
    const groups = syncEntriesToDateGroups([entry])
    expect(groups[0].entries[0].thumbnail).toBe(FAKE_DATA_URL)
  })

  it("returns thumbnail as undefined for entries without photos, data URL for entries with photos", () => {
    const withPhoto = makeSyncEntry({
      id: "20000000-0000-4000-8000-000000000001",
      createdAt: "2026-07-01T10:00:00.000Z",
      thumbnailDataUrl: FAKE_DATA_URL,
    })
    const withoutPhoto = makeSyncEntry({
      id: "20000000-0000-4000-8000-000000000002",
      createdAt: "2026-07-01T09:00:00.000Z",
      thumbnailDataUrl: null,
    })
    const groups = syncEntriesToDateGroups([withPhoto, withoutPhoto])
    expect(groups).toHaveLength(1)
    const entries = groups[0].entries
    const photoEntry = entries.find((e) => e.id === withPhoto.id)!
    const noPhotoEntry = entries.find((e) => e.id === withoutPhoto.id)!
    expect(photoEntry.thumbnail).toBe(FAKE_DATA_URL)
    expect(noPhotoEntry.thumbnail).toBeUndefined()
  })

  it("preserves other TimelineEntry fields correctly alongside thumbnail", () => {
    const entry = makeSyncEntry({
      text: "# My Title\n\nBody text here",
      starred: true,
      tags: ["travel"],
      thumbnailDataUrl: FAKE_DATA_URL,
    })
    const groups = syncEntriesToDateGroups([entry])
    const te = groups[0].entries[0]
    expect(te.title).toBe("My Title")
    expect(te.starred).toBe(true)
    expect(te.tags).toEqual(["travel"])
    expect(te.thumbnail).toBe(FAKE_DATA_URL)
  })
})
