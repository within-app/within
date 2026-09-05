/**
 * FIND F1 regression — replaceEntryTags (lib/db/tags.ts, vormals _upsertTags) must DELETE before INSERT.
 * Additive-only tag upsert silently retains removed tags after a sync push.
 * Synthetic data only (Constraint D).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

import { db } from "@/lib/db"
import { upsertEntries } from "../src/lib/db/sync"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"
const ENTRY_ID   = "20000000-0000-4000-8000-000000000099"

function makeSyncEntry(tags: string[], updatedAt = "2026-06-20T00:00:00.000Z") {
  return {
    id: ENTRY_ID,
    journalId: JOURNAL_ID,
    text: "Synthetic entry for tag-delete test",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt,
    revisionId: "30000000-0000-4000-8000-000000000099",
    starred: false,
    tags,
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
    deletedAt: null,
    thumbnailDataUrl: null,
  }
}

describe("replaceEntryTags via upsertEntries — FIND F1 delete-before-insert", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.mocked(db.query).mockReset()
    mockClient = { query: vi.fn(), release: vi.fn() }
    vi.mocked(db.connect).mockResolvedValue(mockClient as never)
  })

  it("issues DELETE FROM entry_tags before re-inserting tags", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: new Date() }] }
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      if (sql.includes("INSERT INTO tags")) return { rows: [{ id: "tag-id-1" }, { id: "tag-id-2" }] }
      return { rows: [] }
    })

    await upsertEntries([makeSyncEntry(["foo", "bar"])])

    const deleteIdx = sqls.findIndex((s) => s.includes("DELETE FROM entry_tags"))
    const insertIdx = sqls.findIndex((s) => s.includes("INSERT INTO entry_tags"))
    expect(deleteIdx, "DELETE FROM entry_tags must be issued").toBeGreaterThan(-1)
    expect(insertIdx, "INSERT INTO entry_tags must follow DELETE").toBeGreaterThan(deleteIdx)
  })

  it("issues DELETE even when new tags list is empty, clearing all prior tags", async () => {
    const sqls: string[] = []
    mockClient.query.mockImplementation(async (sql: string) => {
      sqls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: new Date() }] }
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      return { rows: [] }
    })

    await upsertEntries([makeSyncEntry([])])

    const deleteTagsSql = sqls.find((s) => s.includes("DELETE FROM entry_tags"))
    expect(deleteTagsSql, "DELETE must be issued even for empty tags to clear stale associations").toBeTruthy()
  })

  it("DELETE targets the specific entry_id, not all rows", async () => {
    const calls: Array<[string, unknown[]]> = []
    mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params ?? []])
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] }
      if (sql.includes("SELECT NOW()")) return { rows: [{ server_now: new Date() }] }
      if (sql.includes("FROM entries e WHERE e.id")) return { rows: [] }
      if (sql.includes("INSERT INTO tags")) return { rows: [{ id: "tag-id-1" }] }
      return { rows: [] }
    })

    await upsertEntries([makeSyncEntry(["only-tag"])])

    const deleteCall = calls.find(([sql]) => sql.includes("DELETE FROM entry_tags"))
    expect(deleteCall).toBeTruthy()
    if (deleteCall) {
      const [, params] = deleteCall
      expect(params).toContain(ENTRY_ID)
    }
  })
})
