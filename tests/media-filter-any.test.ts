/**
 * Sidebar-Eintrag "Medien" filtert alle Anlagetypen, nicht nur Fotos.
 *
 * Rote Ausgangslage: der Eintrag hiess nach dem Rename "Medien", setzte aber
 * weiter `mediaType: "photo"` — Einträge mit Video oder Audio fielen aus der
 * Liste, obwohl die Beschriftung sie versprach.
 *
 * Nur synthetische Daten.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { EntryQuerySchema } from "../src/lib/schemas/entry.schema"
import { isFilterActive } from "../src/lib/timeline/filter-utils"
import { DEFAULT_FILTERS } from "../src/types/journal"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"

// ── Query-Schema ──────────────────────────────────────────────────────────────

describe("EntryQuerySchema — mediaType", () => {
  it("nimmt 'any' an", () => {
    expect(EntryQuerySchema.safeParse({ mediaType: "any" }).success).toBe(true)
  })

  it("nimmt die drei konkreten Typen weiterhin an", () => {
    for (const t of ["photo", "audio", "video"]) {
      expect(EntryQuerySchema.safeParse({ mediaType: t }).success).toBe(true)
    }
  })

  it("weist Unbekanntes weiterhin ab", () => {
    expect(EntryQuerySchema.safeParse({ mediaType: "alles" }).success).toBe(false)
  })
})

// ── SQL-Prädikat ──────────────────────────────────────────────────────────────

describe("listEntries — Medien-Prädikat", () => {
  const baseParams = {
    journalId: null, date: null, onThisDay: null, year: null, before: null,
    searchQuery: null, tags: null, starred: null,
    page: 1, perPage: 25,
  }

  beforeEach(() => vi.mocked(db.query).mockReset())

  async function capture(mediaType: string | null): Promise<string[]> {
    const sql: string[] = []
    vi.mocked(db.query).mockImplementation(async (q: unknown) => {
      sql.push(q as string)
      return { rows: [{ total: 0 }] } as never
    })
    const { listEntries } = await import("../src/lib/db/entries")
    await listEntries({ ...baseParams, mediaType })
    return sql
  }

  it("lässt bei 'any' jede Anlage gelten, nicht nur type = 'photo'", async () => {
    const [countSql, rowsSql] = await capture("any")
    for (const sql of [countSql, rowsSql]) {
      // Der Typ-Vergleich muss durch den 'any'-Zweig kurzgeschlossen werden.
      expect(sql).toMatch(/=\s*'any'\s+OR\s+m2\.type\s*=/)
      expect(sql).toContain("FROM media m2")
    }
  })

  it("reicht 'any' unverändert als Parameter durch", async () => {
    await capture("any")
    const countArgs = vi.mocked(db.query).mock.calls[0][1] as unknown[]
    // Position 8 im count-Query: [journalId, date, onThisDay, year, q, tags, starred, mediaType, before]
    expect(countArgs[7]).toBe("any")
  })

  it("filtert bei einem konkreten Typ weiterhin auf genau diesen", async () => {
    await capture("video")
    const countArgs = vi.mocked(db.query).mock.calls[0][1] as unknown[]
    expect(countArgs[7]).toBe("video")
  })
})

// ── Verdrahtung in der UI ─────────────────────────────────────────────────────

describe("REGRESSION: der Sidebar-Eintrag heisst, was er tut", () => {
  const source = readFileSync(
    join(__dirname, "..", "src/components/journal-sidebar.tsx"),
    "utf8"
  )

  it("setzt 'any' statt 'photo'", () => {
    expect(source).toContain('mediaType: "any"')
    expect(source).not.toContain('mediaType: "photo"')
  })

  it("markiert den Eintrag genau dann als aktiv, wenn 'any' gesetzt ist", () => {
    expect(source).toContain('activeFilters.mediaType === "any"')
  })

  it("zählt 'any' als aktiven Filter, damit der Leerzustand richtig reagiert", () => {
    expect(isFilterActive({ ...DEFAULT_FILTERS, mediaType: "any" }, "")).toBe(true)
    expect(isFilterActive({ ...DEFAULT_FILTERS }, "")).toBe(false)
  })
})
