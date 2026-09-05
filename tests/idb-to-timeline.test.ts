/**
 * Unit tests for the offline IDB → timeline conversion helper.
 */

import { describe, it, expect, afterEach } from "vitest"
import { syncEntriesToDateGroups } from "@/lib/sync/idb-to-timeline"
import type { SyncEntry } from "@/lib/sync/types"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"

function makeEntry(overrides: Partial<SyncEntry> & { id: string }): SyncEntry {
  return {
    id: overrides.id,
    journalId: overrides.journalId ?? "journal-1",
    text: overrides.text ?? "Synthetic test entry",
    createdAt: overrides.createdAt ?? "2026-07-10T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-10T10:00:00.000Z",
    revisionId: overrides.revisionId ?? "rev-" + overrides.id,
    starred: overrides.starred ?? false,
    tags: overrides.tags ?? [],
    locationName: overrides.locationName ?? null,
    locationLat: overrides.locationLat ?? null,
    locationLng: overrides.locationLng ?? null,
    weatherDescription: overrides.weatherDescription ?? null,
    weatherTempCelsius: overrides.weatherTempCelsius ?? null,
    weatherIcon: overrides.weatherIcon ?? null,
    deletedAt: overrides.deletedAt ?? null,
    thumbnailDataUrl: overrides.thumbnailDataUrl ?? null,
  }
}

const ENTRY_A = makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z", text: "Entry A" })
const ENTRY_B = makeEntry({ id: "b", createdAt: "2026-07-10T09:00:00.000Z", text: "Entry B" })
const ENTRY_C = makeEntry({ id: "c", createdAt: "2026-07-09T12:00:00.000Z", text: "Entry C" })

describe("syncEntriesToDateGroups", () => {
  it("groups entries by day and sorts newest-first", () => {
    const groups = syncEntriesToDateGroups([ENTRY_C, ENTRY_B, ENTRY_A])
    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe("2026-07-10")
    expect(groups[1].date).toBe("2026-07-09")
    // Within 2026-07-10 — A (10:00) before B (09:00)
    expect(groups[0].entries[0].id).toBe("a")
    expect(groups[0].entries[1].id).toBe("b")
  })

  it("returns empty array for empty input", () => {
    expect(syncEntriesToDateGroups([])).toEqual([])
  })

  it("extracts title from markdown heading", () => {
    const entry = makeEntry({ id: "h", text: "# My Heading\nBody text here." })
    const [group] = syncEntriesToDateGroups([entry])
    expect(group.entries[0].title).toBe("My Heading")
    expect(group.entries[0].previewText).toContain("Body text")
  })

  it("filters by journalId", () => {
    const other = makeEntry({ id: "o", journalId: "journal-2" })
    const groups = syncEntriesToDateGroups([ENTRY_A, other], { journalId: "journal-1" })
    const allIds = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(allIds).toContain("a")
    expect(allIds).not.toContain("o")
  })

  it("filters by starred", () => {
    const starred = makeEntry({ id: "s", starred: true })
    const groups = syncEntriesToDateGroups([ENTRY_A, starred], { starred: true })
    const allIds = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(allIds).toEqual(["s"])
  })

  it("filters by search query (case-insensitive)", () => {
    const groups = syncEntriesToDateGroups([ENTRY_A, ENTRY_B], { q: "entry a" })
    const allIds = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(allIds).toContain("a")
    expect(allIds).not.toContain("b")
  })

  it("filters by tags (all required tags must match)", () => {
    const tagged = makeEntry({ id: "t", tags: ["work", "important"] })
    const groups = syncEntriesToDateGroups([ENTRY_A, tagged], { tags: ["work"] })
    const allIds = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(allIds).toEqual(["t"])
  })

  it("excludes tombstoned entries (deletedAt set)", () => {
    const tombstone = makeEntry({ id: "del", deletedAt: "2026-07-17T00:00:00.000Z" })
    const groups = syncEntriesToDateGroups([ENTRY_A, tombstone])
    const allIds = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(allIds).not.toContain("del")
    expect(allIds).toContain("a")
  })

  it("sets safe defaults for UI-only fields", () => {
    const [group] = syncEntriesToDateGroups([ENTRY_A])
    const entry = group.entries[0]
    expect(entry.journalColor).toBe("")
    expect(entry.photoCount).toBe(0)
    expect(entry.hasAudio).toBe(false)
    expect(entry.hasVideo).toBe(false)
    expect(entry.thumbnail).toBeUndefined()
  })

  it("includes weather when present in SyncEntry", () => {
    const withWeather = makeEntry({
      id: "w",
      weatherDescription: "Sunny",
      weatherTempCelsius: 22,
      weatherIcon: "sunny",
    })
    const [group] = syncEntriesToDateGroups([withWeather])
    expect(group.entries[0].weather).toEqual({
      description: "Sunny",
      temperatureCelsius: 22,
      icon: "sunny",
    })
  })

  describe("Rechenbeispiel Zeitzone P2 — Gruppierung folgt der App-Zone", () => {
    afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

    it("ein Abendeintrag in UTC−5 gehört zur Gruppe des Vortages", () => {
      setAppTimeZone("Etc/GMT+5")
      // 4. September 20:00 Ortszeit → gespeichert 2026-09-05T01:00Z
      const entry = makeEntry({ id: "a", createdAt: "2026-09-05T01:00:00.000Z" })
      const groups = syncEntriesToDateGroups([entry])
      expect(groups.map((g) => g.date)).toEqual(["2026-09-04"])
    })

    it("in UTC gehört derselbe Zeitpunkt zur Gruppe des nächsten Tages", () => {
      const entry = makeEntry({ id: "a", createdAt: "2026-09-05T01:00:00.000Z" })
      const groups = syncEntriesToDateGroups([entry])
      expect(groups.map((g) => g.date)).toEqual(["2026-09-05"])
    })
  })
})
