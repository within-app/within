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

// Import after mock is set up
import { GET } from "../src/app/api/backup/status/route"
import { db } from "@/lib/db"

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
    vi.mocked(db.query).mockResolvedValue({ rows: [mockRow] } as never)
  })
  afterEach(() => vi.unstubAllEnvs())

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
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body).toEqual({ status: "no_runs_yet" })
  })

  it("returns 503 when DB query throws", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(db.query).mockRejectedValueOnce(new Error("connection refused"))
    const res = await GET()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body).toHaveProperty("error")
  })

  it("never returns mock data on DB failure in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.mocked(db.query).mockRejectedValueOnce(new Error("timeout"))
    const res = await GET()
    const body = (await res.json()) as Record<string, unknown>
    // Must be an error, not synthetic data
    expect(body).not.toHaveProperty("live_entry_count")
    expect(body).not.toHaveProperty("verify_entry_count")
  })
})
