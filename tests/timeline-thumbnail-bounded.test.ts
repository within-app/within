/**
 * Regression — "Query only what you serve":
 * die Timeline-Query (listEntries) darf als thumbnail NUR thumbnail_path
 * selektieren, nie einen COALESCE(thumbnail_path, file_path)-Full-Res-Fallback.
 * Eine unbounded Spalte × bis zu 100 Zeilen pro Seite OOMt den Pi 4 —
 * exakt dieser Fallback stand bereits einmal in der Sync-Query (Fix d7e859d)
 * und erneut in der Timeline-Query.
 *
 * Synthetic data only — no real journal content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockQuery = vi.fn()
vi.mock("@/lib/db", () => ({ db: { query: mockQuery } }))

const { listEntries } = await import("@/lib/db/entries")

const BASE_PARAMS = {
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
  perPage: 10,
  includeMedia: false,
}

describe("listEntries — thumbnail column stays bounded", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] })
  })

  it("selects thumbnail_path without a file_path full-res fallback", async () => {
    await listEntries(BASE_PARAMS)

    const listSql = mockQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("AS thumbnail"))
    expect(listSql).toBeDefined()
    expect(listSql).toContain("SELECT thumbnail_path FROM media")
    expect(listSql).not.toContain("COALESCE(thumbnail_path, file_path)")
  })
})
