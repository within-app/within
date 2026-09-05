/**
 * listEntries — includeMedia (full=true der Lese-Ansicht "An diesem Tag")
 *
 * Verifiziert:
 * 1. includeMedia: true hängt die media_json-Aggregation (json_agg, nach
 *    order_index sortiert) an den paginierten SELECT an.
 * 2. Ohne includeMedia bleibt der SELECT unverändert schlank — normale
 *    Timeline-Requests bezahlen die Aggregation nicht.
 * 3. Der onThisDay-Parameter wird unverändert an beide Queries durchgereicht
 *    (beliebiges MM-DD, nicht nur "heute").
 *
 * Synthetische Daten — kein DB-Zugriff (gemockter Query-Layer).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"
import { listEntries } from "../src/lib/db/entries"

const DEFAULTS = {
  journalId: null,
  date: null,
  onThisDay: null,
  year: null,
  before: null,
  searchQuery: null,
  tags: null,
  starred: null,
  mediaType: null,
  page: 1,
  perPage: 20,
}

function captureQueries() {
  const sqls: string[] = []
  const values: unknown[][] = []
  vi.mocked(db.query).mockImplementation(async (sql: unknown, params?: unknown) => {
    sqls.push(sql as string)
    values.push((params as unknown[]) ?? [])
    if (sqls.length === 1) return { rows: [{ total: 0 }] }
    return { rows: [] }
  })
  return { sqls, values }
}

describe("listEntries — includeMedia", () => {
  beforeEach(() => vi.mocked(db.query).mockReset())

  it("includeMedia: true ergänzt media_json (json_agg nach order_index) im SELECT", async () => {
    const { sqls } = captureQueries()
    await listEntries({ ...DEFAULTS, includeMedia: true })
    const selectSql = sqls[1]
    expect(selectSql).toContain("media_json")
    expect(selectSql).toContain("json_agg")
    expect(selectSql).toContain("ORDER BY m.order_index")
    // COUNT-Query bleibt unangetastet
    expect(sqls[0]).not.toContain("media_json")
  })

  it("ohne includeMedia bleibt der SELECT schlank", async () => {
    const { sqls } = captureQueries()
    await listEntries(DEFAULTS)
    expect(sqls[1]).not.toContain("media_json")
    expect(sqls[1]).not.toContain("json_agg")
  })

  it("reicht ein beliebiges onThisDay-MM-DD an COUNT- und SELECT-Query durch", async () => {
    const { values } = captureQueries()
    await listEntries({ ...DEFAULTS, onThisDay: "12-24", includeMedia: true })
    // COUNT: $3 = onThisDay; SELECT: $5 = onThisDay (Positionen aus entries.ts)
    expect(values[0]).toContain("12-24")
    expect(values[1]).toContain("12-24")
  })
})
