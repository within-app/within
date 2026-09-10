/**
 * PUT /api/backup/pause — the trust boundary of the pause switch
 * (Settings → Backup → "Nächtliche Sicherung"). { paused: true } writes
 * app_settings.backup_paused_at, { paused: false } deletes it; anything else
 * is a 400 before any query. Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))

import { PUT } from "../src/app/api/backup/pause/route"
import { db } from "@/lib/db"

function put(body: unknown) {
  return PUT(new NextRequest("http://localhost/api/backup/pause", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  vi.mocked(db.query).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("PUT /api/backup/pause", () => {
  it("rejects a body without a boolean paused (400, no query)", async () => {
    expect((await put({ paused: "yes" })).status).toBe(400)
    expect((await put({})).status).toBe(400)
    expect(db.query).not.toHaveBeenCalled()
  })

  it("paused: true → upserts backup_paused_at and returns the timestamp", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ updated_at: new Date("2026-09-09T20:00:00.000Z") }] } as never)
    const res = await put({ paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pausedAt: "2026-09-09T20:00:00.000Z" })
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO app_settings/)
    expect(params).toContain("backup_paused_at")
  })

  it("paused: false → deletes the key and returns null", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)
    const res = await put({ paused: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pausedAt: null })
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/DELETE FROM app_settings/)
    expect(params).toContain("backup_paused_at")
  })

  it("503 without DATABASE_URL and when the query fails", async () => {
    vi.stubEnv("DATABASE_URL", "")
    expect((await put({ paused: true })).status).toBe(503)
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockRejectedValue(new Error("down"))
    expect((await put({ paused: true })).status).toBe(503)
  })
})
