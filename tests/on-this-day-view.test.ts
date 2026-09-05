/**
 * "An diesem Tag" — Vollbild-Lese-Ansicht (Session 2026-08-05)
 *
 * Verifiziert:
 * 1. Tages-Anker-Helfer: Kalendertag der App-Zone (Einstieg = heutiger Tag,
 *    Standardzone UTC, wie month_day_in serverseitig und idbToStats
 *    clientseitig), Blättern über Monats-/Jahresgrenzen, Schalttag-Verhalten
 *    (29.02. nur im Schaltjahr-Anker).
 * 2. loadOnThisDayFull: ein Request pro Tag (onThisDay + full=true), Sortierung
 *    neuestes-Jahr-oben, IDB-Fallback mit Medien-Cache-Merge, null wenn beides
 *    scheitert.
 * 3. idbToOnThisDayFull: MM-DD-Vergleich in der App-Zone (Mitternachts-
 *    Grenzfall), Volltext bleibt erhalten, Journal-Filter.
 * 4. emptyText: Leerzustands-Text für den Blätter-Leerlauf.
 *
 * Synthetische Daten — keine echten Zugänge, kein Netz, keine DB.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  todayAnchor,
  stepDay,
  monthDayOf,
  dayLabel,
  emptyText,
  loadOnThisDayFull,
} from "@/components/on-this-day/on-this-day-view"
import { idbToOnThisDayFull } from "@/lib/sync/idb-to-views"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"
import type { SyncEntry } from "@/lib/sync/types"
import type { Media, PaginatedTimeline, FullTimelineEntry } from "@/types/journal"

// ── Factories ────────────────────────────────────────────────────────────────

function makeSyncEntry(overrides: Partial<SyncEntry> & { id: string }): SyncEntry {
  return {
    id: overrides.id,
    journalId: overrides.journalId ?? "journal-1",
    text: overrides.text ?? "# Titel\n\nSynthetischer Testeintrag",
    createdAt: overrides.createdAt ?? "2026-08-05T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-05T10:00:00.000Z",
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

function makeFullEntry(id: string, createdAt: string): FullTimelineEntry {
  return {
    id,
    journalId: "journal-1",
    journalColor: "#007AFF",
    createdAt,
    title: "Titel " + id,
    previewText: "Preview",
    photoCount: 0,
    hasAudio: false,
    hasVideo: false,
    starred: false,
    tags: [],
    text: "# Titel " + id + "\n\nVolltext",
    media: [],
  }
}

// ── Tages-Anker-Helfer ───────────────────────────────────────────────────────

describe("todayAnchor / monthDayOf — Kalendertag der App-Zone", () => {
  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("ohne gesetzte Zone bleibt es beim UTC-Kalendertag (Standardzone, Mitternachts-Grenzfall)", () => {
    // 2026-08-05T22:30Z ist in Europe/Berlin bereits der 6. August —
    // die On-this-day-Semantik bleibt trotzdem beim UTC-Tag 08-05.
    const anchor = todayAnchor(new Date("2026-08-05T22:30:00.000Z"))
    expect(monthDayOf(anchor)).toBe("08-05")
  })

  it("mit gesetzter App-Zone folgt der Anker der Zone statt UTC (Rechenbeispiel Silvester)", () => {
    setAppTimeZone("Etc/GMT+5")
    // 2026-01-01T04:00Z ist in UTC−5 noch der Vorabend (31.12. 23:00 Ortszeit).
    const anchor = todayAnchor(new Date("2026-01-01T04:00:00.000Z"))
    expect(monthDayOf(anchor)).toBe("12-31")
  })

  it("padded MM-DD einstellig", () => {
    const anchor = todayAnchor(new Date("2026-01-03T12:00:00.000Z"))
    expect(monthDayOf(anchor)).toBe("01-03")
  })
})

describe("stepDay — Blättern über Grenzen", () => {
  it("rollt rückwärts über den Jahreswechsel (01.01. → 31.12.)", () => {
    expect(monthDayOf(stepDay("2026-01-01", -1))).toBe("12-31")
  })

  it("rollt vorwärts über den Jahreswechsel (31.12. → 01.01.)", () => {
    expect(monthDayOf(stepDay("2026-12-31", 1))).toBe("01-01")
  })

  it("Schaltjahr-Anker: 28.02. → 29.02.", () => {
    expect(monthDayOf(stepDay("2024-02-28", 1))).toBe("02-29")
  })

  it("Nicht-Schaltjahr-Anker: 28.02. → 01.03. (29.02. existiert nicht)", () => {
    expect(monthDayOf(stepDay("2026-02-28", 1))).toBe("03-01")
  })
})

describe("emptyText — Leerzustand beim Blättern", () => {
  it("nennt den Tag im Klartext", () => {
    const anchor = "2026-08-03"
    expect(emptyText(anchor)).toBe("Keine Einträge am 3. August")
    expect(dayLabel(anchor)).toBe("3. August")
  })
})

// ── loadOnThisDayFull ────────────────────────────────────────────────────────

function paginatedResponse(groups: { date: string; entries: FullTimelineEntry[] }[], total?: number): PaginatedTimeline {
  const totalEntries = total ?? groups.reduce((n, g) => n + g.entries.length, 0)
  return {
    dateGroups: groups.map((g) => ({ date: g.date, formattedDate: g.date, entries: g.entries })),
    totalEntries,
    currentPage: 1,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  }
}

describe("loadOnThisDayFull — network first", () => {
  it("stellt EINEN Request mit onThisDay, full=true und journalId", async () => {
    const fetchImpl = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => paginatedResponse([]),
    }))
    await loadOnThisDayFull("08-05", "j1", { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = fetchImpl.mock.calls[0][0]
    expect(url).toContain("onThisDay=08-05")
    expect(url).toContain("full=true")
    expect(url).toContain("journalId=j1")
  })

  it("flacht dateGroups zu neuestes-Jahr-oben ab", async () => {
    const groups = [
      { date: "2026-08-05", entries: [makeFullEntry("a", "2026-08-05T09:00:00.000Z")] },
      { date: "2024-08-05", entries: [makeFullEntry("b", "2024-08-05T20:00:00.000Z")] },
      { date: "2023-08-05", entries: [makeFullEntry("c", "2023-08-05T07:00:00.000Z")] },
    ]
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => paginatedResponse(groups) }))
    const result = await loadOnThisDayFull("08-05", null, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).not.toBeNull()
    expect(result!.offline).toBe(false)
    expect(result!.entries.map((e) => e.id)).toEqual(["a", "b", "c"])
    expect(result!.entries[0].text).toContain("Volltext")
  })

  it("meldet die Server-Gesamtzahl (perPage-Deckel nicht stillschweigend)", async () => {
    const groups = [{ date: "2026-08-05", entries: [makeFullEntry("a", "2026-08-05T09:00:00.000Z")] }]
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => paginatedResponse(groups, 150) }))
    const result = await loadOnThisDayFull("08-05", null, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result!.totalEntries).toBe(150)
    expect(result!.entries).toHaveLength(1)
  })
})

describe("loadOnThisDayFull — IDB-Fallback", () => {
  const failingFetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch

  it("liest offline aus IDB und mischt den Medien-Cache pro Eintrag dazu", async () => {
    const idbEntries = [
      makeSyncEntry({ id: "alt", createdAt: "2024-08-05T08:00:00.000Z", text: "# Alt\n\nText 2024" }),
      makeSyncEntry({ id: "neu", createdAt: "2026-08-05T09:00:00.000Z", text: "# Neu\n\nText 2026" }),
      makeSyncEntry({ id: "anderer-tag", createdAt: "2026-08-04T09:00:00.000Z" }),
    ]
    const cachedMedia: Media[] = [
      { id: "m1", entryId: "neu", type: "photo", filePath: "/media/x.jpg", order: 0 },
    ]
    const result = await loadOnThisDayFull("08-05", null, {
      fetchImpl: failingFetch,
      getAllEntries: async () => idbEntries,
      readCachedMedia: async (entryId) => (entryId === "neu" ? cachedMedia : []),
    })
    expect(result).not.toBeNull()
    expect(result!.offline).toBe(true)
    // Neuestes Jahr oben, voller Text, gecachte Medien gemerged
    expect(result!.entries.map((e) => e.id)).toEqual(["neu", "alt"])
    expect(result!.entries[0].text).toBe("# Neu\n\nText 2026")
    expect(result!.entries[0].media).toEqual(cachedMedia)
    expect(result!.entries[1].media).toEqual([])
  })

  it("liefert null, wenn Netz UND IDB scheitern", async () => {
    const result = await loadOnThisDayFull("08-05", null, {
      fetchImpl: failingFetch,
      getAllEntries: async () => {
        throw new Error("IDB unavailable")
      },
    })
    expect(result).toBeNull()
  })
})

// ── idbToOnThisDayFull ───────────────────────────────────────────────────────

describe("idbToOnThisDayFull", () => {
  afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

  it("vergleicht MM-DD in der App-Zone (Standardzone UTC) — lokaler Gerätetag zählt nicht (Mitternachts-Grenzfall)", () => {
    const entries = [
      // 2023-08-04T22:00Z ist in Europe/Berlin der 5. August — UTC sagt 08-04: raus.
      makeSyncEntry({ id: "lokal-fuenfter", createdAt: "2023-08-04T22:00:00.000Z" }),
      // 2023-08-05T23:30Z ist lokal der 6. August — UTC sagt 08-05: rein.
      makeSyncEntry({ id: "utc-fuenfter", createdAt: "2023-08-05T23:30:00.000Z" }),
    ]
    const result = idbToOnThisDayFull(entries, "08-05", null)
    expect(result.map((e) => e.id)).toEqual(["utc-fuenfter"])
  })

  it("mit gesetzter App-Zone folgt die MM-DD-Zuordnung der Zone, nicht UTC (Rechenbeispiel)", () => {
    setAppTimeZone("Etc/GMT+5")
    // 2026-09-05T01:00Z ist in UTC−5 der Abend des 4. September.
    const entries = [makeSyncEntry({ id: "abend", createdAt: "2026-09-05T01:00:00.000Z" })]
    expect(idbToOnThisDayFull(entries, "09-04", null).map((e) => e.id)).toEqual(["abend"])
    expect(idbToOnThisDayFull(entries, "09-05", null)).toEqual([])
  })

  it("sortiert neuestes Jahr zuerst und behält den Volltext", () => {
    const entries = [
      makeSyncEntry({ id: "b", createdAt: "2024-08-05T20:00:00.000Z", text: "Text B" }),
      makeSyncEntry({ id: "a", createdAt: "2026-08-05T09:00:00.000Z", text: "Text A" }),
    ]
    const result = idbToOnThisDayFull(entries, "08-05", null)
    expect(result.map((e) => e.id)).toEqual(["a", "b"])
    expect(result[0].text).toBe("Text A")
    expect(result[0].media).toEqual([])
  })

  it("respektiert den Journal-Filter", () => {
    const entries = [
      makeSyncEntry({ id: "a", journalId: "j1", createdAt: "2026-08-05T09:00:00.000Z" }),
      makeSyncEntry({ id: "b", journalId: "j2", createdAt: "2025-08-05T09:00:00.000Z" }),
    ]
    expect(idbToOnThisDayFull(entries, "08-05", "j1").map((e) => e.id)).toEqual(["a"])
  })
})
