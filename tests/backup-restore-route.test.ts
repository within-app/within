/**
 * /api/backup/restore — the trust boundary of the restore button.
 *
 * POST: the confirmation level is decided server-side from the live counts
 * (fresh install → one click; data present → typed word + password), the dump
 * must exist, one restore at a time. GET: the state machine over request row
 * and restore row, and the post-restore steps (migrations, password sync,
 * default journal) run exactly once when "done" is first seen.
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
vi.mock("@/lib/password", () => ({
  getPasswordHash: vi.fn(),
  syncPasswordFromEnv: vi.fn(async () => "unchanged"),
}))
vi.mock("@/lib/db/migrate", () => ({ runMigrations: vi.fn(async () => undefined) }))
vi.mock("@/lib/journals/default-journal", () => ({ ensureDefaultJournal: vi.fn(async () => false) }))
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async (pw: string) => pw === "correct-horse") } }))

import { GET, POST } from "../src/app/api/backup/restore/route"
import { db } from "@/lib/db"
import { getPasswordHash } from "@/lib/password"
import { runMigrations } from "@/lib/db/migrate"
import { syncPasswordFromEnv } from "@/lib/password"
import { setInFlight, getInFlight } from "../src/lib/backup-restore"

const DUMP = "within_20260909_020001.dump"
let dir: string

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/backup/restore", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
}

/** db.query dispatcher keyed by a substring of the SQL. */
function answer(map: Record<string, unknown>) {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "within-restore-"))
  mkdirSync(join(dir, "db"))
  writeFileSync(join(dir, "db", DUMP), "dump")
  vi.stubEnv("BACKUP_DIR", dir)
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  setInFlight(null)
  vi.mocked(db.query).mockReset()
  vi.mocked(runMigrations).mockClear()
  vi.mocked(syncPasswordFromEnv).mockClear()
  vi.mocked(getPasswordHash).mockResolvedValue("$2b$hash")
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const T_REQ = new Date("2026-09-09T18:00:00.000Z")

describe("POST /api/backup/restore", () => {
  it("rejects a filename that is not a dump name (400, before any query)", async () => {
    const res = await post({ file: "../etc/passwd" })
    expect(res.status).toBe(400)
    expect(db.query).not.toHaveBeenCalled()
  })

  it("404 for a dump that is not in the backup folder", async () => {
    const res = await post({ file: "within_20260101_020001.dump" })
    expect(res.status).toBe(404)
    expect(db.query).not.toHaveBeenCalled()
  })

  it("fresh install (no entries, no media) → one click is enough → 202 + request row", async () => {
    answer({ "COUNT(*)": [{ entries: 0, media: 0 }], "INSERT INTO app_settings": [{ updated_at: T_REQ }] })
    const res = await post({ file: DUMP })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ state: "running", file: DUMP, requestedAt: T_REQ.toISOString() })
    const insert = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO app_settings"))
    expect(insert?.[1]).toEqual(["restore_request", DUMP])
    expect(getInFlight()).toMatchObject({ file: DUMP })
  })

  it("data present → the typed word is required (400, no request written)", async () => {
    answer({ "COUNT(*)": [{ entries: 5, media: 0 }] })
    const res = await post({ file: DUMP, password: "correct-horse" })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("restore_confirm_required")
    expect(getInFlight()).toBeNull()
  })

  it("data present → wrong password is refused (401, no request written)", async () => {
    answer({ "COUNT(*)": [{ entries: 0, media: 2 }] })
    const res = await post({ file: DUMP, password: "nope", confirm: "RESTORE" })
    expect(res.status).toBe(401)
    expect(getInFlight()).toBeNull()
  })

  it("data present → word + password → 202", async () => {
    answer({ "COUNT(*)": [{ entries: 5, media: 2 }], "INSERT INTO app_settings": [{ updated_at: T_REQ }] })
    const res = await post({ file: DUMP, password: "correct-horse", confirm: "RESTORE" })
    expect(res.status).toBe(202)
  })

  it("one restore at a time → 409 while in flight", async () => {
    setInFlight({ file: DUMP, requestedAt: T_REQ })
    const res = await post({ file: DUMP })
    expect(res.status).toBe(409)
  })
})

describe("GET /api/backup/restore", () => {
  it("nothing in flight, no request row → idle with the last restore for the log line", async () => {
    const last = { status: "ok", backup_file: DUMP, run_at: "2026-09-01T10:00:00.000Z", error_msg: null, verify_entry_count: 3, verify_media_count: 1 }
    answer({ "FROM app_settings": [], "kind = 'restore'": [last] })
    const body = await (await GET()).json()
    expect(body.state).toBe("idle")
    expect(body.lastRestore).toMatchObject({ backup_file: DUMP })
  })

  it("request row present but no in-flight memory (app restarted) → running, re-armed", async () => {
    answer({ "FROM app_settings": [{ value: DUMP, updated_at: new Date() }], "kind = 'restore'": [] })
    const body = await (await GET()).json()
    expect(body.state).toBe("running")
    expect(getInFlight()).toMatchObject({ file: DUMP })
  })

  it("in flight + database being rebuilt (query fails) → running", async () => {
    setInFlight({ file: DUMP, requestedAt: new Date() })
    answer({ "kind = 'restore'": new Error("terminating connection due to administrator command") })
    expect((await (await GET()).json()).state).toBe("running")
    expect(runMigrations).not.toHaveBeenCalled()
  })

  it("not in flight + database down → honest 503, not a fake running", async () => {
    answer({ "FROM app_settings": new Error("ECONNREFUSED") })
    expect((await GET()).status).toBe(503)
  })

  it("restore row after the request → done, post-restore steps run once, flag cleared", async () => {
    const requestedAt = new Date(Date.now() - 10_000)
    setInFlight({ file: DUMP, requestedAt })
    const done = { status: "ok", backup_file: DUMP, run_at: new Date().toISOString(), error_msg: null, verify_entry_count: 42, verify_media_count: 7 }
    answer({ "kind = 'restore'": [done] })
    const body = await (await GET()).json()
    expect(body).toMatchObject({ state: "done", entries: 42, media: 7 })
    expect(runMigrations).toHaveBeenCalledTimes(1)
    expect(syncPasswordFromEnv).toHaveBeenCalledTimes(1)
    expect(getInFlight()).toBeNull()
    // Next poll: idle (the request row is gone), no second migration run.
    answer({ "FROM app_settings": [], "kind = 'restore'": [done] })
    expect((await (await GET()).json()).state).toBe("idle")
    expect(runMigrations).toHaveBeenCalledTimes(1)
  })

  it("post-restore steps failing → failed, never a silent done", async () => {
    setInFlight({ file: DUMP, requestedAt: new Date(Date.now() - 10_000) })
    vi.mocked(runMigrations).mockRejectedValueOnce(new Error("relation entries is broken"))
    answer({ "kind = 'restore'": [{ status: "ok", backup_file: DUMP, run_at: new Date().toISOString(), error_msg: null, verify_entry_count: 1, verify_media_count: 0 }] })
    const body = await (await GET()).json()
    expect(body.state).toBe("failed")
    expect(body.error).toContain("relation entries is broken")
    expect(getInFlight()).toBeNull()
  })

  it("error row after the request → failed with the script's message, no migrations", async () => {
    setInFlight({ file: DUMP, requestedAt: new Date(Date.now() - 10_000) })
    answer({ "kind = 'restore'": [{ status: "error", backup_file: DUMP, run_at: new Date().toISOString(), error_msg: "dump file not found", verify_entry_count: null, verify_media_count: null }] })
    const body = await (await GET()).json()
    expect(body).toMatchObject({ state: "failed", error: "dump file not found" })
    expect(runMigrations).not.toHaveBeenCalled()
    expect(getInFlight()).toBeNull()
  })
})
