/**
 * Unit tests for the offline IDB → calendar/stats/map conversion helpers.
 * idbToStats uses new Date() internally — streak and
 * onThisDayCount tests pin the clock with vi.setSystemTime() to be
 * deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  idbToCalendarData,
  idbToEntryDetail,
  idbToStats,
  idbToMapMarkers,
} from "@/lib/sync/idb-to-views"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"
import type { SyncEntry } from "@/lib/sync/types"

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

// ── idbToCalendarData ────────────────────────────────────────────────────────

describe("idbToCalendarData", () => {
  it("counts entries per day", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({ id: "b", createdAt: "2026-07-10T18:00:00.000Z" }),
      makeEntry({ id: "c", createdAt: "2026-07-11T09:00:00.000Z" }),
    ]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].count).toBe(2)
    expect(cal["2026-07-11"].count).toBe(1)
  })

  it("filters by journalId", () => {
    const entries = [
      makeEntry({ id: "a", journalId: "j1", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({ id: "b", journalId: "j2", createdAt: "2026-07-10T11:00:00.000Z" }),
    ]
    const cal = idbToCalendarData(entries, "j1")
    expect(cal["2026-07-10"].count).toBe(1)
  })

  it("returns empty object for empty input", () => {
    expect(idbToCalendarData([], null)).toEqual({})
  })

  it("includes all journals when journalId is null", () => {
    const entries = [
      makeEntry({ id: "a", journalId: "j1", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({ id: "b", journalId: "j2", createdAt: "2026-07-10T11:00:00.000Z" }),
    ]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].count).toBe(2)
  })

  // ── Tageszellen-Thumbnail: offline wie online ─────────────────────────────

  it("fills thumbnail from the entry's timeline thumbnail (data: URL)", () => {
    const entries = [
      makeEntry({
        id: "a",
        createdAt: "2026-07-10T10:00:00.000Z",
        thumbnailDataUrl: "data:image/webp;base64,SYNTH_A",
      }),
    ]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].thumbnail).toBe("data:image/webp;base64,SYNTH_A")
  })

  it("leaves thumbnail undefined when no entry of the day has one", () => {
    const entries = [makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z" })]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].thumbnail).toBeUndefined()
  })

  it("newest entry of the day WITH a thumbnail wins (entries without one don't block)", () => {
    const entries = [
      makeEntry({
        id: "old",
        createdAt: "2026-07-10T08:00:00.000Z",
        thumbnailDataUrl: "data:image/webp;base64,SYNTH_OLD",
      }),
      makeEntry({
        id: "mid",
        createdAt: "2026-07-10T12:00:00.000Z",
        thumbnailDataUrl: "data:image/webp;base64,SYNTH_MID",
      }),
      // Neuester Eintrag des Tages hat KEIN Thumb — der neueste MIT Thumb gewinnt.
      makeEntry({ id: "new", createdAt: "2026-07-10T18:00:00.000Z" }),
    ]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].count).toBe(3)
    expect(cal["2026-07-10"].thumbnail).toBe("data:image/webp;base64,SYNTH_MID")
  })

  it("thumbnail respects the journal filter", () => {
    const entries = [
      makeEntry({
        id: "a",
        journalId: "j1",
        createdAt: "2026-07-10T10:00:00.000Z",
      }),
      makeEntry({
        id: "b",
        journalId: "j2",
        createdAt: "2026-07-10T11:00:00.000Z",
        thumbnailDataUrl: "data:image/webp;base64,SYNTH_J2",
      }),
    ]
    const cal = idbToCalendarData(entries, "j1")
    expect(cal["2026-07-10"].thumbnail).toBeUndefined()
  })

  it("skips tombstoned entries for count and thumbnail (like the other IDB views)", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({
        id: "dead",
        createdAt: "2026-07-10T12:00:00.000Z",
        deletedAt: "2026-07-11T00:00:00.000Z",
        thumbnailDataUrl: "data:image/webp;base64,SYNTH_DEAD",
      }),
    ]
    const cal = idbToCalendarData(entries, null)
    expect(cal["2026-07-10"].count).toBe(1)
    expect(cal["2026-07-10"].thumbnail).toBeUndefined()
  })

  // ── App-Zone (Zeitzone P3) ──────────────────────────────────────────────

  describe("App-Zone statt UTC", () => {
    afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

    it("Rechenbeispiel: Abendeintrag in UTC−5 zählt zum Vortag, nicht zum UTC-Tag", () => {
      setAppTimeZone("Etc/GMT+5")
      const entries = [makeEntry({ id: "a", createdAt: "2026-09-05T01:00:00.000Z" })]
      const cal = idbToCalendarData(entries, null)
      expect(cal["2026-09-04"]?.count).toBe(1)
      expect(cal["2026-09-05"]).toBeUndefined()
    })

    it("Monatsgrenze: 1. Oktober 03:00Z zählt in UTC−5 noch zum 30. September", () => {
      setAppTimeZone("Etc/GMT+5")
      const entries = [makeEntry({ id: "a", createdAt: "2026-10-01T03:00:00.000Z" })]
      const cal = idbToCalendarData(entries, null)
      expect(cal["2026-09-30"]?.count).toBe(1)
      expect(cal["2026-10-01"]).toBeUndefined()
    })
  })
})

// ── idbToStats ───────────────────────────────────────────────────────────────

describe("idbToStats", () => {
  const PINNED_DATE = new Date("2026-07-10T12:00:00.000Z")

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(PINNED_DATE)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("totalEntries counts all entries when journalId is null", () => {
    const entries = [
      makeEntry({ id: "a", journalId: "j1" }),
      makeEntry({ id: "b", journalId: "j2" }),
    ]
    expect(idbToStats(entries, null).totalEntries).toBe(2)
  })

  it("totalEntries filters by journalId", () => {
    const entries = [
      makeEntry({ id: "a", journalId: "j1" }),
      makeEntry({ id: "b", journalId: "j2" }),
    ]
    expect(idbToStats(entries, "j1").totalEntries).toBe(1)
  })

  it("totalMedia is null — unknown offline, not a fake 0 (not stored in IDB)", () => {
    const entries = [makeEntry({ id: "a" })]
    expect(idbToStats(entries, null).totalMedia).toBeNull()
  })

  it("totalDays counts unique calendar days", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({ id: "b", createdAt: "2026-07-10T18:00:00.000Z" }),
      makeEntry({ id: "c", createdAt: "2026-07-09T09:00:00.000Z" }),
    ]
    expect(idbToStats(entries, null).totalDays).toBe(2)
  })

  it("totalCountries extracts last comma-segment of locationName", () => {
    const entries = [
      makeEntry({ id: "a", locationName: "Berlin, Deutschland" }),
      makeEntry({ id: "b", locationName: "München, Deutschland" }),
      makeEntry({ id: "c", locationName: "Paris, France" }),
      makeEntry({ id: "d", locationName: "No comma here" }),
    ]
    // "Deutschland" and "France" = 2 unique countries; no-comma entry excluded
    expect(idbToStats(entries, null).totalCountries).toBe(2)
  })

  it("totalCountries is 0 when no entry has a comma in locationName", () => {
    const entries = [makeEntry({ id: "a", locationName: "Berlin" })]
    expect(idbToStats(entries, null).totalCountries).toBe(0)
  })

  // FAILS without vi.setSystemTime() — new Date() ≠ PINNED_DATE
  it("streak is 1 when only today has an entry", () => {
    const today = makeEntry({ id: "t", createdAt: "2026-07-10T08:00:00.000Z" })
    expect(idbToStats([today], null).streak).toBe(1)
  })

  it("streak is 0 when no entry exists today", () => {
    const old = makeEntry({ id: "o", createdAt: "2026-07-08T08:00:00.000Z" })
    expect(idbToStats([old], null).streak).toBe(0)
  })

  it("streak counts consecutive days including today", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T08:00:00.000Z" }),
      makeEntry({ id: "b", createdAt: "2026-07-09T08:00:00.000Z" }),
      makeEntry({ id: "c", createdAt: "2026-07-08T08:00:00.000Z" }),
    ]
    expect(idbToStats(entries, null).streak).toBe(3)
  })

  it("streak breaks on a gap day", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T08:00:00.000Z" }),
      // gap: 2026-07-09 missing
      makeEntry({ id: "c", createdAt: "2026-07-08T08:00:00.000Z" }),
    ]
    expect(idbToStats(entries, null).streak).toBe(1)
  })

  // FAILS without vi.setSystemTime() — onThisDayCount uses new Date()
  it("onThisDayCount counts entries matching today's month+day across all years", () => {
    const entries = [
      makeEntry({ id: "a", createdAt: "2026-07-10T10:00:00.000Z" }),
      makeEntry({ id: "b", createdAt: "2025-07-10T10:00:00.000Z" }),
      makeEntry({ id: "c", createdAt: "2026-07-09T10:00:00.000Z" }), // different day
    ]
    expect(idbToStats(entries, null).onThisDayCount).toBe(2)
  })

  // ── App-Zone (Zeitzone P4) ──────────────────────────────────────────────

  describe("App-Zone statt UTC", () => {
    afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

    it("Streak über Mitternacht: drei Abende 20:00 Ortszeit in UTC−5 ergeben Streak 3", () => {
      setAppTimeZone("Etc/GMT+5")
      // Kurz nach dem dritten Abend-Eintrag (6.9. 20:00 Ortszeit) — "heute" bleibt der 6.9.
      vi.setSystemTime(new Date("2026-09-07T02:00:00.000Z"))
      const entries = [
        makeEntry({ id: "a", createdAt: "2026-09-05T01:00:00.000Z" }), // 4.9. 20:00 Ortszeit
        makeEntry({ id: "b", createdAt: "2026-09-06T01:00:00.000Z" }), // 5.9. 20:00 Ortszeit
        makeEntry({ id: "c", createdAt: "2026-09-07T01:00:00.000Z" }), // 6.9. 20:00 Ortszeit
      ]
      expect(idbToStats(entries, null).streak).toBe(3)
    })

    it("onThisDayCount folgt der App-Zone, nicht UTC (Silvester-Grenzfall)", () => {
      setAppTimeZone("Etc/GMT+5")
      vi.setSystemTime(new Date("2026-01-01T04:00:00.000Z")) // "heute" = 31.12. Ortszeit
      const entries = [
        // Vorjahres-Silvester zur selben Ortszeit-Stunde — gleicher MM-DD in der App-Zone.
        makeEntry({ id: "a", createdAt: "2025-01-01T04:00:00.000Z" }),
      ]
      expect(idbToStats(entries, null).onThisDayCount).toBe(1)
    })
  })
})

// ── idbToMapMarkers ──────────────────────────────────────────────────────────

describe("idbToMapMarkers", () => {
  it("only includes entries with lat and lng", () => {
    const entries = [
      makeEntry({ id: "a", locationLat: 52.52, locationLng: 13.405 }),
      makeEntry({ id: "b" }), // no coords
    ]
    const markers = idbToMapMarkers(entries, null)
    expect(markers).toHaveLength(1)
    expect(markers[0].id).toBe("a")
  })

  it("filters by journalId", () => {
    const entries = [
      makeEntry({ id: "a", journalId: "j1", locationLat: 52.52, locationLng: 13.405 }),
      makeEntry({ id: "b", journalId: "j2", locationLat: 48.85, locationLng: 2.35 }),
    ]
    const markers = idbToMapMarkers(entries, "j1")
    expect(markers).toHaveLength(1)
    expect(markers[0].id).toBe("a")
  })

  it("sets journalColor to empty string (unavailable offline)", () => {
    const entries = [makeEntry({ id: "a", locationLat: 52.52, locationLng: 13.405 })]
    expect(idbToMapMarkers(entries, null)[0].journalColor).toBe("")
  })

  it("extracts title from markdown heading", () => {
    const entries = [
      makeEntry({
        id: "a",
        text: "# Trip to Berlin\nGreat day.",
        locationLat: 52.52,
        locationLng: 13.405,
      }),
    ]
    expect(idbToMapMarkers(entries, null)[0].title).toBe("Trip to Berlin")
  })

  it("falls back to 'Ohne Titel' when text is empty", () => {
    const entries = [
      makeEntry({
        id: "a",
        text: "",
        locationLat: 52.52,
        locationLng: 13.405,
      }),
    ]
    expect(idbToMapMarkers(entries, null)[0].title).toBe("Ohne Titel")
  })

  it("maps lat and lng from the entry", () => {
    const entries = [
      makeEntry({ id: "a", locationLat: 48.8566, locationLng: 2.3522 }),
    ]
    const marker = idbToMapMarkers(entries, null)[0]
    expect(marker.lat).toBe(48.8566)
    expect(marker.lng).toBe(2.3522)
  })

  it("returns empty array when no entries have coordinates", () => {
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })]
    expect(idbToMapMarkers(entries, null)).toEqual([])
  })
})


// ── idbToEntryDetail ────────────────────────────────────────────────────────

describe("idbToEntryDetail", () => {
  it("maps scalar fields from SyncEntry", () => {
    const entry = makeEntry({
      id: "e1", journalId: "j1", text: "# Title\n\nBody text",
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T11:00:00.000Z",
      revisionId: "rev-1", starred: true,
    })
    const detail = idbToEntryDetail(entry)
    expect(detail.id).toBe("e1")
    expect(detail.journalId).toBe("j1")
    expect(detail.text).toBe("# Title\n\nBody text")
    expect(detail.createdAt).toBe("2026-07-20T10:00:00.000Z")
    expect(detail.starred).toBe(true)
    expect(detail.media).toEqual([])
    expect(detail.journalName).toBe("")
    expect(detail.journalColor).toBe("")
  })

  it("converts string tags to Tag objects with id=name", () => {
    const entry = makeEntry({ id: "e2", tags: ["trip", "food"] })
    const detail = idbToEntryDetail(entry)
    expect(detail.tags).toEqual([
      { id: "trip", name: "trip" },
      { id: "food", name: "food" },
    ])
  })

  it("builds LocationInfo from locationName + coords", () => {
    const entry = makeEntry({
      id: "e3",
      locationName: "Berlin, Germany",
      locationLat: 52.52,
      locationLng: 13.405,
    })
    const detail = idbToEntryDetail(entry)
    expect(detail.location).toEqual({
      name: "Berlin, Germany",
      latitude: 52.52,
      longitude: 13.405,
    })
  })

  it("returns undefined location when locationName is null", () => {
    const entry = makeEntry({ id: "e4" })
    expect(idbToEntryDetail(entry).location).toBeUndefined()
  })

  it("builds LocationInfo from coordinates alone — GPS picker stores no name", () => {
    const entry = makeEntry({
      id: "e4b",
      locationLat: 53.52599,
      locationLng: 10.30889,
    })
    const detail = idbToEntryDetail(entry)
    expect(detail.location).toEqual({
      name: null,
      latitude: 53.52599,
      longitude: 10.30889,
    })
  })

  it("returns undefined location when only one coordinate is present", () => {
    const entry = makeEntry({ id: "e4c", locationLat: 53.52599 })
    expect(idbToEntryDetail(entry).location).toBeUndefined()
  })

  it("builds WeatherInfo from weather fields", () => {
    const entry = makeEntry({
      id: "e5",
      weatherDescription: "partly cloudy",
      weatherTempCelsius: 18,
      weatherIcon: "partly-cloudy",
    })
    const detail = idbToEntryDetail(entry)
    expect(detail.weather).toEqual({
      description: "partly cloudy",
      temperatureCelsius: 18,
      icon: "partly-cloudy",
    })
  })

  it("falls back to 'cloudy' icon when weatherIcon is null", () => {
    const entry = makeEntry({
      id: "e6",
      weatherDescription: "overcast",
      weatherTempCelsius: 12,
      weatherIcon: null,
    })
    expect(idbToEntryDetail(entry).weather?.icon).toBe("cloudy")
  })

  it("returns undefined weather when weatherDescription is null", () => {
    const entry = makeEntry({ id: "e7" })
    expect(idbToEntryDetail(entry).weather).toBeUndefined()
  })
})
