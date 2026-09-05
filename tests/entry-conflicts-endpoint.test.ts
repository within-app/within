/**
 * GET /api/entries/[id]/conflicts — Konfliktkopien lesbar machen
 * (Entscheidung 2026-08-06): sync_conflict_copies wurde von PUT + Sync-Upsert
 * beschrieben, aber von keinem Endpoint gelesen — die gesicherten
 * Verliererversionen waren unsichtbar.
 *
 * Synthetic data only — no real journal content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const mockQuery = vi.fn()
vi.mock("@/lib/db", () => ({ db: { query: mockQuery } }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ENTRY_ID = "00000000-0000-4000-8000-000000000042"

function makeReq() {
  return new NextRequest(new URL(`http://localhost:3000/api/entries/${ENTRY_ID}/conflicts`))
}

function makeParams() {
  return { params: Promise.resolve({ id: ENTRY_ID }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("GET /api/entries/[id]/conflicts", () => {
  it("liefert die Kopien des Eintrags, neueste zuerst, gemappt auf camelCase", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "c1",
          revision_id: "r1",
          text: "Synthetic conflict copy",
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-06-01T10:00:00Z"),
          starred: false,
          location_name: null,
          tags: ["synthetic"],
          saved_at: new Date("2024-06-01T10:00:05Z"),
        },
      ],
    })

    const { GET } = await import("../src/app/api/entries/[id]/conflicts/route")
    const res = await GET(makeReq(), makeParams())

    expect(res.status).toBe(200)
    const body = await res.json() as { conflicts: Array<Record<string, unknown>> }
    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0]).toMatchObject({
      id: "c1",
      revisionId: "r1",
      text: "Synthetic conflict copy",
      tags: ["synthetic"],
      savedAt: "2024-06-01T10:00:05.000Z",
    })
    // Query ist auf den Entry gescoped und begrenzt
    const [sql, params] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain("FROM sync_conflict_copies")
    expect(String(sql)).toContain("ORDER BY saved_at DESC")
    expect(String(sql)).toContain("LIMIT 20")
    expect(params).toEqual([ENTRY_ID])
  })

  it("liefert eine leere Liste, wenn keine Kopien existieren", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { GET } = await import("../src/app/api/entries/[id]/conflicts/route")
    const res = await GET(makeReq(), makeParams())

    expect(res.status).toBe(200)
    const body = await res.json() as { conflicts: unknown[] }
    expect(body.conflicts).toEqual([])
  })

  it("antwortet 500 mit Fehlercode, wenn die Query fehlschlägt", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"))

    const { GET } = await import("../src/app/api/entries/[id]/conflicts/route")
    const res = await GET(makeReq(), makeParams())

    expect(res.status).toBe(500)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("conflicts_load_failed")
  })
})
