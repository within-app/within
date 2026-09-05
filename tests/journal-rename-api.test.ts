/**
 * Journal-Rename — PATCH /api/journals/[id]
 *
 * Name und/oder Farbe eines Journals ändern. Validierung wie CreateJournalSchema
 * (partial, mindestens ein Feld), Fehler-Responses mit `error` + stabilem `code`.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}))

import { db } from "@/lib/db"

const JOURNAL_ID = "01234567-89ab-cdef-0123-456789abcdef"

function patchRequest(body: string, id: string = JOURNAL_ID): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/journals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ id }) },
  ]
}

describe("PATCH /api/journals/[id]", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("rejects invalid JSON with a stable error code", async () => {
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest("{nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_json")
  })

  it("rejects an empty body (no name, no color)", async () => {
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({})))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("validation_error")
  })

  it("rejects an empty name", async () => {
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "   " })))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("validation_error")
  })

  it("rejects an invalid color value", async () => {
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ color: "rot" })))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("validation_error")
  })

  it("returns 503 with a stable code when DATABASE_URL is missing", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("DATABASE_URL", "")
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "Synth" })))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("no_db_access")
  })

  it("returns 404 with a stable code when the journal does not exist", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "Synth" })))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("journal_not_found")
  })

  it("updates the name only — parameterised SQL, no color in SET", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: JOURNAL_ID, name: "Synth Renamed", color: "#007AFF" }],
      rowCount: 1,
    } as never)
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "Synth Renamed" })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: JOURNAL_ID, name: "Synth Renamed", color: "#007AFF" })

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/UPDATE journals SET/i)
    expect(sql).toMatch(/name = \$1/i)
    expect(sql).not.toMatch(/color =/i)
    expect(sql).not.toContain("Synth Renamed") // parameterised, not interpolated
    expect(params).toEqual(["Synth Renamed", JOURNAL_ID])
  })

  it("updates name and color together and echoes the updated journal", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: JOURNAL_ID, name: "Synth", color: "#34C759" }],
      rowCount: 1,
    } as never)
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "Synth", color: "#34C759" })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: JOURNAL_ID, name: "Synth", color: "#34C759" })

    const [, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual(["Synth", "#34C759", JOURNAL_ID])
  })

  it("returns 500 with a stable code when the DB query fails", async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error("boom"))
    const { PATCH } = await import("../src/app/api/journals/[id]/route")
    const res = await PATCH(...patchRequest(JSON.stringify({ name: "Synth" })))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe("journal_update_failed")
  })
})
