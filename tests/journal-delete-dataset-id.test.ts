/**
 * DELETE /api/journals/[id] wechselt die Datenbestand-Kennung.
 *
 * Journale werden hart gelöscht (kein Tombstone-Pfad): andere Geräte bekämen
 * über den Delta-Sync nie ein Signal und behielten die Einträge. Deshalb setzt
 * der Handler nach dem Löschen app_settings.dataset_id neu — in derselben
 * Transaktion, damit kein Gerät ein halbes Bild sieht.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const captured: Array<{ sql: string; params?: unknown[] }> = []
const client = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    captured.push({ sql: sql.trim(), params })
    if (sql.includes("DELETE FROM journals")) return { rowCount: 1, rows: [] }
    if (sql.includes("DELETE FROM media")) return { rows: [] }
    return { rows: [] }
  }),
  release: vi.fn(),
}
vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => client),
  },
}))
vi.mock("@/lib/db/tags", () => ({
  deleteOrphanTags: vi.fn(async () => {}),
  orphanTagIds: vi.fn(async () => []),
}))
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const JOURNAL_ID = "01234567-89ab-cdef-0123-456789abcdef"

function deleteRequest(id: string = JOURNAL_ID): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/journals/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  ]
}

describe("DELETE /api/journals/[id] — dataset_id", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    captured.length = 0
    client.query.mockClear()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("setzt dataset_id nach DELETE FROM journals und vor COMMIT neu (parametrisiert, neue UUID aus der DB)", async () => {
    const { DELETE } = await import("../src/app/api/journals/[id]/route")
    const res = await DELETE(...deleteRequest())
    expect(res.status).toBe(200)

    const sqls = captured.map((c) => c.sql)
    const iDelete = sqls.findIndex((s) => s.includes("DELETE FROM journals"))
    const iRotate = captured.findIndex((c) => c.sql.includes("app_settings") && JSON.stringify(c.params ?? []).includes("dataset_id"))
    const iCommit = sqls.findIndex((s) => s === "COMMIT")
    expect(iDelete).toBeGreaterThanOrEqual(0)
    expect(iRotate).toBeGreaterThan(iDelete)
    expect(iCommit).toBeGreaterThan(iRotate)
    expect(captured[iRotate].sql).toMatch(/gen_random_uuid\(\)/)
    expect(captured[iRotate].sql).toMatch(/ON CONFLICT/)
  })

  it("Journal nicht gefunden → Rollback, keine neue Kennung", async () => {
    client.query.mockImplementationOnce(async (sql: string, params?: unknown[]) => {
      captured.push({ sql: sql.trim(), params }); return { rows: [] }
    })
    // BEGIN, DELETE media → rows [], DELETE journals → rowCount 0
    client.query
      .mockImplementationOnce(async (sql: string, params?: unknown[]) => { captured.push({ sql: sql.trim(), params }); return { rows: [] } })
      .mockImplementationOnce(async (sql: string, params?: unknown[]) => { captured.push({ sql: sql.trim(), params }); return { rows: [] } })
      .mockImplementationOnce(async (sql: string, params?: unknown[]) => { captured.push({ sql: sql.trim(), params }); return { rowCount: 0, rows: [] } })
    const { DELETE } = await import("../src/app/api/journals/[id]/route")
    const res = await DELETE(...deleteRequest())
    expect(res.status).toBe(404)
    expect(captured.some((c) => JSON.stringify(c.params ?? []).includes("dataset_id"))).toBe(false)
  })
})
