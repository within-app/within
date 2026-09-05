/**
 * Übersicht-Zahlen veraltet (Auftrag 2026-07-27) — Client-Seite:
 *
 * 1. loadOverviewStats (extrahiert aus OverviewView): Netz zuerst, IDB-
 *    Fallback, null wenn beides scheitert. Der useEffect in OverviewView
 *    hängt an [journalId, refreshNonce]; das Nonce-Verhalten selbst deckt
 *    der e2e-Fall overview-stale-stats.spec.ts ab.
 * 2. StatCell: undefined = Skeleton (lädt), null = "–" (offline unbekannt,
 *    keine falsche 0), Zahl = formatiert.
 *
 * Synthetic data only.
 */

import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { loadOverviewStats, StatCell } from "@/components/overview/overview-view"
import type { JournalStats } from "@/types/journal"
import type { SyncEntry } from "@/lib/sync/types"

const SERVER_STATS: JournalStats = {
  streak: 2,
  totalEntries: 5,
  totalMedia: 3,
  totalDays: 4,
  totalCountries: 1,
  onThisDayCount: 1,
}

function makeSyncEntry(overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    id: "e1",
    journalId: "j1",
    text: "synthetic",
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    revisionId: "r1",
    starred: false,
    tags: [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    ...overrides,
  } as SyncEntry
}

describe("loadOverviewStats — network first, IDB fallback", () => {
  it("returns server stats and scopes the request to the journal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => SERVER_STATS })
    const result = await loadOverviewStats("j1", { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual(SERVER_STATS)
    expect(fetchImpl).toHaveBeenCalledWith("/api/stats?journalId=j1")
  })

  it("omits the journalId param for the all-journals view", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => SERVER_STATS })
    await loadOverviewStats(null, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledWith("/api/stats?")
  })

  it("falls back to IDB-derived stats when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await loadOverviewStats("j1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAllEntries: async () => [makeSyncEntry(), makeSyncEntry({ id: "e2", journalId: "j2" })],
    })
    expect(result).not.toBeNull()
    expect(result!.totalEntries).toBe(1) // journal-scoped
    expect(result!.totalMedia).toBeNull() // unknown offline, not 0
  })

  it("fällt bei einem 503-Fehler-Body auf IDB zurück statt den Error-Body als Stats zu liefern", async () => {
    // Regression: ohne res.ok-Check wurde der {error}-Body als JournalStats
    // gesetzt und der Render crashte auf stats.streak.toLocaleString().
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Datenbank nicht erreichbar" }),
    })
    const result = await loadOverviewStats("j1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAllEntries: async () => [makeSyncEntry()],
    })
    expect(result).not.toBeNull()
    expect(result!.totalEntries).toBe(1)
    expect((result as unknown as Record<string, unknown>).error).toBeUndefined()
  })

  it("returns null when network and IDB both fail", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await loadOverviewStats(null, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAllEntries: async () => {
        throw new Error("IDB unavailable")
      },
    })
    expect(result).toBeNull()
  })
})

describe("StatCell — loading vs unknown vs value", () => {
  it("renders a skeleton while loading (undefined)", () => {
    const html = renderToStaticMarkup(<StatCell label="Medien" value={undefined} />)
    expect(html).toContain("animate-pulse")
    expect(html).not.toContain("–")
  })

  it("renders – for unknown (null), not a fake 0", () => {
    const html = renderToStaticMarkup(<StatCell label="Medien" value={null} />)
    expect(html).toContain("–")
    expect(html).not.toContain("animate-pulse")
    expect(html).not.toMatch(/>0</)
  })

  it("renders the formatted number", () => {
    const html = renderToStaticMarkup(<StatCell label="Einträge" value={1234} />)
    expect(html).toContain("1.234")
  })
})
