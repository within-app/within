/**
 * First start: an installation without any journal gets exactly one, so the
 * first entry can be saved. Idempotent — nothing happens once a journal
 * exists. Synthetic, mocked query layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"
import { ensureDefaultJournal, DEFAULT_JOURNAL_NAME } from "@/lib/journals/default-journal"

const query = vi.mocked(db.query)
beforeEach(() => query.mockReset())

describe("ensureDefaultJournal", () => {
  it("creates the journal with a single guarded INSERT when none exists", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "j1" }] } as never)
    expect(await ensureDefaultJournal()).toBe(true)
    const [sql, params] = query.mock.calls[0] as unknown as [string, string[]]
    expect(sql).toMatch(/INSERT INTO journals/)
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM journals\)/)
    expect(params[0]).toBe(DEFAULT_JOURNAL_NAME)
  })
  it("does nothing when a journal already exists (INSERT … WHERE NOT EXISTS returns no row)", async () => {
    query.mockResolvedValueOnce({ rows: [] } as never)
    expect(await ensureDefaultJournal()).toBe(false)
  })
})
