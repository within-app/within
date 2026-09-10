/**
 * GET /api/backup/status
 *
 * Verifies:
 * - Returns 503 when DATABASE_URL is absent (honest error, no mock fallback)
 * - Returns 503 when DB query throws (no mock fallback in production)
 * - Returns last backup_run row when one exists
 * - Returns {status: "no_runs_yet"} when table is empty
 *
 * Synthetic data only — no real credentials or DB connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockRow = {
  id: 1,
  run_at: "2026-07-19T04:00:00.000Z",
  status: "ok",
  backup_file: "within_20260719_020000.dump",
  live_entry_count: 1700,
  verify_entry_count: 1700,
  live_media_count: 3000,
  verify_media_count: 3000,
  error_msg: null,
}

// Factory must not reference outer variables (hoisting constraint)
vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
  },
}))
vi.mock("@/lib/backup-restore-files", () => ({
  destUsage: vi.fn(async () => ({ usedBytes: 77 * 1024 * 1024, totalBytes: 7.3 * 1024 ** 3 })),
}))

// Import after mock is set up
import { GET } from "../src/app/api/backup/status/route"
import { db } from "@/lib/db"

/** db.query dispatcher keyed by a substring of the SQL (same as backup-restore-route.test.ts). */
function answer(map: Record<string, unknown>) {
  vi.mocked(db.query).mockReset()
  vi.mocked(db.query).mockImplementation((async (sql: string) => {
    for (const [needle, value] of Object.entries(map)) {
      if (sql.includes(needle)) {
        if (value instanceof Error) throw value
        return { rows: value }
      }
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`)
  }) as never)
}

describe("GET /api/backup/status — no DATABASE_URL", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns 503 when DATABASE_URL is not set", async () => {
    vi.stubEnv("DATABASE_URL", "")
    const res = await GET()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })
})

describe("GET /api/backup/status — with DATABASE_URL", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    answer({ "FROM backup_runs": [mockRow], "FROM app_settings": [] })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("never shows a 'skipped' row (pause) as the last run", async () => {
    await GET()
    const sql = vi.mocked(db.query).mock.calls.map((c) => String(c[0])).find((q) => q.includes("FROM backup_runs"))!
    expect(sql).toContain("status <> 'skipped'")
  })

  it("adds pausedAt (null when the key is absent) and the destination usage", async () => {
    const body = (await (await GET()).json()) as { pausedAt: string | null; dest: { usedBytes: number; totalBytes: number } }
    expect(body.pausedAt).toBeNull()
    expect(body.dest).toEqual({ usedBytes: 77 * 1024 * 1024, totalBytes: 7.3 * 1024 ** 3 })
  })

  it("pausedAt carries app_settings.backup_paused_at", async () => {
    answer({ "FROM backup_runs": [mockRow], "FROM app_settings": [{ value: "2026-09-09T20:00:00.000Z" }] })
    const body = (await (await GET()).json()) as { pausedAt: string | null }
    expect(body.pausedAt).toBe("2026-09-09T20:00:00.000Z")
  })

  it("returns 200 with last backup_run when one exists", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof mockRow
    expect(body.status).toBe("ok")
    expect(body.live_entry_count).toBe(1700)
    expect(body.verify_entry_count).toBe(1700)
    expect(body.live_media_count).toBe(3000)
    expect(body.backup_file).toBe("within_20260719_020000.dump")
  })

  it("returns {status: 'no_runs_yet'} when backup_runs table is empty", async () => {
    answer({ "FROM backup_runs": [], "FROM app_settings": [] })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body).toMatchObject({ status: "no_runs_yet", pausedAt: null })
  })

  it("returns 503 when DB query throws", async () => {
    vi.stubEnv("NODE_ENV", "production")
    answer({ "FROM backup_runs": new Error("connection refused") })
    const res = await GET()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })

  it("never returns mock data on DB failure in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    answer({ "FROM backup_runs": new Error("timeout") })
    const res = await GET()
    const body = (await res.json()) as Record<string, unknown>
    // Must be an error, not synthetic data
    expect(body).not.toHaveProperty("live_entry_count")
    expect(body).not.toHaveProperty("verify_entry_count")
  })
})
