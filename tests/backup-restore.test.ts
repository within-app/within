/**
 * Restore from a backup — pure state logic (src/lib/backup-restore.ts).
 *
 * The app writes a request row, the backup service answers with a
 * backup_runs row (kind = 'restore'). Between the two the database is dropped
 * and rebuilt, so a failing query means "running", not "error". Nothing after
 * the timeout means the backup service never picked the request up (e.g. the
 * backup container is not running) — that must surface as failed, never as
 * an endless spinner.
 */
import { describe, it, expect } from "vitest"
import {
  DUMP_NAME_RE,
  RESTORE_TIMEOUT_MS,
  parseDumpMeta,
  resolveRestoreState,
  type RestoreRunRow,
} from "../src/lib/backup-restore"

const T0 = new Date("2026-09-09T18:00:00.000Z")
const flight = { file: "within_20260909_020001.dump", requestedAt: T0 }
const after = (ms: number) => new Date(T0.getTime() + ms)
const row = (over: Partial<RestoreRunRow>): RestoreRunRow => ({
  status: "ok", backup_file: flight.file, run_at: after(4_000).toISOString(),
  error_msg: null, verify_entry_count: 12, verify_media_count: 3, ...over,
})

describe("DUMP_NAME_RE", () => {
  it("accepts only within_YYYYMMDD_HHMMSS.dump", () => {
    expect(DUMP_NAME_RE.test("within_20260909_020001.dump")).toBe(true)
    expect(DUMP_NAME_RE.test("../within_20260909_020001.dump")).toBe(false)
    expect(DUMP_NAME_RE.test("within_20260909_020001.dump.meta.json")).toBe(false)
    expect(DUMP_NAME_RE.test("within_2026090_020001.dump")).toBe(false)
    expect(DUMP_NAME_RE.test("x'; DROP TABLE entries; --")).toBe(false)
  })
})

describe("parseDumpMeta", () => {
  it("reads the counts sidecar", () => {
    expect(parseDumpMeta('{"entries":1700,"media":3000}\n')).toEqual({ entries: 1700, media: 3000 })
  })
  it("anything odd → unknown counts, never a crash", () => {
    expect(parseDumpMeta("not json")).toEqual({ entries: null, media: null })
    expect(parseDumpMeta('{"entries":"12","media":-1}')).toEqual({ entries: null, media: null })
  })
})

describe("resolveRestoreState", () => {
  it("no request in flight → idle", () => {
    expect(resolveRestoreState(null, row({}), T0)).toEqual({ state: "idle" })
  })

  it("request written, nothing answered yet → running", () => {
    expect(resolveRestoreState(flight, null, after(2_000))).toMatchObject({ state: "running", file: flight.file })
  })

  it("database unreachable mid-restore → still running, not an error", () => {
    expect(resolveRestoreState(flight, "unavailable", after(2_000)).state).toBe("running")
  })

  it("an OLDER restore row (from a previous restore) does not count", () => {
    const stale = row({ run_at: new Date(T0.getTime() - 60_000).toISOString() })
    expect(resolveRestoreState(flight, stale, after(2_000)).state).toBe("running")
  })

  it("ok row after the request → done with the restored counts", () => {
    expect(resolveRestoreState(flight, row({}), after(5_000))).toEqual({
      state: "done", file: flight.file, entries: 12, media: 3, finishedAt: after(4_000).toISOString(),
    })
  })

  it("error row after the request → failed with the message", () => {
    const r = resolveRestoreState(flight, row({ status: "error", error_msg: "dump file not found" }), after(5_000))
    expect(r).toEqual({ state: "failed", file: flight.file, error: "dump file not found", timedOut: false })
  })

  it("nothing after the timeout → failed (backup service never picked it up)", () => {
    expect(resolveRestoreState(flight, null, after(RESTORE_TIMEOUT_MS + 1)).state).toBe("failed")
    expect(resolveRestoreState(flight, null, after(RESTORE_TIMEOUT_MS + 1))).toMatchObject({ timedOut: true })
    expect(resolveRestoreState(flight, null, after(RESTORE_TIMEOUT_MS - 1)).state).toBe("running")
  })

  it("a late ok row still wins over the timeout", () => {
    expect(resolveRestoreState(flight, row({ run_at: after(RESTORE_TIMEOUT_MS + 5_000).toISOString() }), after(RESTORE_TIMEOUT_MS + 6_000)).state).toBe("done")
  })
})
