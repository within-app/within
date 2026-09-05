/**
 * Missing indexes
 *
 * Verifies that schema.sql contains the three new indexes required by the
 * code-review findings:
 *   idx_entries_geo       — partial index for geo-filtered map queries
 *   idx_entries_month_day — expression index for "on this day" queries
 *   idx_entries_location_name_trgm — trigram index for country scan
 *
 * No live DB needed — only parses the SQL text.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const schema = readFileSync(
  join(__dirname, "../src/lib/db/schema.sql"),
  "utf-8"
)

describe("schema.sql — missing indexes", () => {
  it("contains idx_entries_geo partial index on (journal_id, created_at DESC) WHERE lat/lng IS NOT NULL", () => {
    expect(schema).toContain("idx_entries_geo")
    expect(schema).toContain("location_lat IS NOT NULL")
    expect(schema).toContain("location_lng IS NOT NULL")
  })

  it("(superseded — Zeitzone P4): month_day_utc()/idx_entries_month_day are dropped idempotently, replaced by month_day_in() without a functional index", () => {
    expect(schema).toContain("DROP INDEX IF EXISTS idx_entries_month_day")
    expect(schema).toContain("DROP FUNCTION IF EXISTS month_day_utc(TIMESTAMPTZ)")
    expect(schema).toContain("month_day_in")
    expect(schema).not.toMatch(/CREATE INDEX IF NOT EXISTS idx_entries_month_day\b/)
  })

  it("contains pg_trgm extension and idx_entries_location_name_trgm gin index", () => {
    expect(schema).toContain("pg_trgm")
    expect(schema).toContain("idx_entries_location_name_trgm")
    expect(schema).toContain("gin_trgm_ops")
  })

  it("the remaining indexes use CREATE INDEX IF NOT EXISTS (idempotent)", () => {
    const matches = schema.match(/CREATE INDEX IF NOT EXISTS idx_entries_geo\b/g)
    expect(matches).toHaveLength(1)
    const matches3 = schema.match(/CREATE INDEX IF NOT EXISTS idx_entries_location_name_trgm\b/g)
    expect(matches3).toHaveLength(1)
  })
})
