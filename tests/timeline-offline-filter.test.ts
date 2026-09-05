/**
 * Timeline-Filter „Offline verfügbar".
 *
 * Datenquelle ist der lokale pinnedEntries-Store (IDB) — nur der
 * funktioniert im Flugmodus und ist die Wahrheit dieses Geräts. Der
 * Timeline-View reicht die Pin-IDs als Set an die IDB-Filterung durch;
 * der Server wird für diesen Filter NIE gefragt.
 *
 * Synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { syncEntriesToDateGroups } from "@/lib/sync/idb-to-timeline"
import type { SyncEntry } from "@/lib/sync/types"
import { isFilterActive, countPanelFilters } from "@/lib/timeline/filter-utils"
import { DEFAULT_FILTERS } from "@/types/journal"
import { timelineMessages } from "@/lib/i18n/messages/sections/timeline"

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

function ids(groups: ReturnType<typeof syncEntriesToDateGroups>): string[] {
  return groups.flatMap((g) => g.entries.map((e) => e.id))
}

describe("syncEntriesToDateGroups — pinnedIds (Filter 'Offline verfügbar')", () => {
  const entries = [
    makeEntry({ id: "pinned-1", createdAt: "2026-08-20T10:00:00.000Z" }),
    makeEntry({ id: "pinned-2", createdAt: "2026-08-19T10:00:00.000Z", journalId: "journal-2" }),
    makeEntry({ id: "unpinned", createdAt: "2026-08-21T10:00:00.000Z" }),
  ]

  it("zeigt exakt die gepinnten Einträge", () => {
    const groups = syncEntriesToDateGroups(entries, {
      pinnedIds: new Set(["pinned-1", "pinned-2"]),
    })
    expect(ids(groups)).toEqual(["pinned-1", "pinned-2"])
  })

  it("leeres Pin-Set ⇒ leere Timeline (kein Durchfallen auf ungefiltert)", () => {
    const groups = syncEntriesToDateGroups(entries, { pinnedIds: new Set() })
    expect(ids(groups)).toEqual([])
  })

  it("ohne pinnedIds bleibt das Verhalten unverändert", () => {
    const groups = syncEntriesToDateGroups(entries, {})
    expect(ids(groups)).toEqual(["unpinned", "pinned-1", "pinned-2"])
  })

  it("kombiniert mit dem Journal-Filter", () => {
    const groups = syncEntriesToDateGroups(entries, {
      journalId: "journal-2",
      pinnedIds: new Set(["pinned-1", "pinned-2"]),
    })
    expect(ids(groups)).toEqual(["pinned-2"])
  })

  it("kombiniert mit Suche, Stern und Tags", () => {
    const rich = [
      makeEntry({ id: "match", text: "Bergwanderung", starred: true, tags: ["draussen"] }),
      makeEntry({ id: "wrong-text", text: "Stadtbummel", starred: true, tags: ["draussen"] }),
      makeEntry({ id: "unstarred", text: "Bergwanderung", starred: false, tags: ["draussen"] }),
      makeEntry({ id: "not-pinned", text: "Bergwanderung", starred: true, tags: ["draussen"] }),
    ]
    const groups = syncEntriesToDateGroups(rich, {
      q: "bergwanderung",
      starred: true,
      tags: ["draussen"],
      pinnedIds: new Set(["match", "wrong-text", "unstarred"]),
    })
    expect(ids(groups)).toEqual(["match"])
  })

  it("Tombstone verschwindet auch mit Pin-Rest aus dem Filter (Lösch-Pfad)", () => {
    const groups = syncEntriesToDateGroups(
      [makeEntry({ id: "dead", deletedAt: "2026-08-22T00:00:00.000Z" })],
      { pinnedIds: new Set(["dead"]) }
    )
    expect(ids(groups)).toEqual([])
  })
})

describe("isFilterActive — pinned zählt als aktiver Filter", () => {
  it("pinned: true ⇒ aktiv (Empty-State zeigt 'Filter zurücksetzen')", () => {
    expect(isFilterActive({ ...DEFAULT_FILTERS, pinned: true }, "")).toBe(true)
  })

  it("Default bleibt inaktiv", () => {
    expect(isFilterActive({ ...DEFAULT_FILTERS }, "")).toBe(false)
  })
})

describe("countPanelFilters — Badge am Filter-Button", () => {
  it("zählt starred, tags, mediaType und pinned einzeln", () => {
    expect(countPanelFilters(DEFAULT_FILTERS)).toBe(0)
    expect(countPanelFilters({ ...DEFAULT_FILTERS, pinned: true })).toBe(1)
    expect(
      countPanelFilters({
        starred: true,
        tags: ["a"],
        mediaType: "photo",
        before: null,
        pinned: true,
      })
    ).toBe(4)
  })

  it("before zählt nicht zum Panel-Badge (eigener Chip)", () => {
    expect(countPanelFilters({ ...DEFAULT_FILTERS, before: "2026-07" })).toBe(0)
  })
})

describe("i18n: Filter-Label in allen drei UI-Sprachen", () => {
  it("pinnedOnly existiert in de/en/fr und ist pro Sprache übersetzt", () => {
    expect(timelineMessages.de.toolbar.pinnedOnly).toBe("Offline verfügbar")
    expect(timelineMessages.en.toolbar.pinnedOnly).toBe("Available offline")
    expect(timelineMessages.fr.toolbar.pinnedOnly).toBe("Disponible hors ligne")
  })
})

describe("Quell-Kontrakt: Toolbar bindet den Offline-Filter ein", () => {
  const toolbarSrc = readFileSync(
    join(__dirname, "../src/components/timeline/timeline-toolbar.tsx"),
    "utf8"
  )

  it("toggelt activeFilters.pinned und beschriftet mit tb.pinnedOnly", () => {
    expect(toolbarSrc).toContain("pinned: !activeFilters.pinned")
    expect(toolbarSrc).toContain("tb.pinnedOnly")
  })

  it("Badge zählt über die zentrale Regel countPanelFilters (pinned inklusive)", () => {
    expect(toolbarSrc).toContain("countPanelFilters(")
  })
})

describe("Quell-Kontrakt: Timeline-View bedient den Filter aus dem lokalen Pin-Store", () => {
  const viewSrc = readFileSync(
    join(__dirname, "../src/components/timeline/timeline-view.tsx"),
    "utf8"
  )

  it("liest listPins und reicht pinnedIds an die IDB-Filterung durch — der Server wird für den Filter nie gefragt", () => {
    expect(viewSrc).toContain("listPins")
    expect(viewSrc).toContain("pinnedIds")
  })
})
