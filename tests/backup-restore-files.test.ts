/**
 * Listing the backup folder for the restore picker (src/lib/backup-restore-files.ts)
 * against a temp directory shaped like /backup: db/ with dumps and the counts
 * sidecar backup-verify.sh writes. Synthetic files only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { destUsage, dumpExists, listDumps } from "../src/lib/backup-restore-files"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "within-backup-"))
  mkdirSync(join(dir, "db"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("listDumps", () => {
  it("newest first, with size and the sidecar counts when present", async () => {
    writeFileSync(join(dir, "db", "within_20260908_020001.dump"), "old")
    writeFileSync(join(dir, "db", "within_20260909_020001.dump"), "newer-dump")
    writeFileSync(join(dir, "db", "within_20260909_020001.dump.meta.json"), '{"entries":7,"media":2}')
    writeFileSync(join(dir, "db", "within_20260909_020001.dump.part"), "aborted run")
    writeFileSync(join(dir, "db", "notes.txt"), "ignored")

    const dumps = await listDumps(dir)
    expect(dumps?.map((d) => d.file)).toEqual(["within_20260909_020001.dump", "within_20260908_020001.dump"])
    expect(dumps?.[0]).toMatchObject({ sizeBytes: 10, entries: 7, media: 2 })
    expect(dumps?.[1]).toMatchObject({ sizeBytes: 3, entries: null, media: null })
    expect(new Date(dumps![0].takenAt).getTime()).toBeGreaterThan(0)
  })

  it("empty db/ → empty list (mounted, nothing to pick)", async () => {
    expect(await listDumps(dir)).toEqual([])
  })

  it("no db/ folder → null (backup folder not mounted)", async () => {
    rmSync(join(dir, "db"), { recursive: true })
    expect(await listDumps(dir)).toBeNull()
  })
})

describe("dumpExists", () => {
  it("true only for an existing, well-named dump inside db/", async () => {
    writeFileSync(join(dir, "db", "within_20260909_020001.dump"), "x")
    writeFileSync(join(dir, "secret.dump"), "x")
    expect(await dumpExists("within_20260909_020001.dump", dir)).toBe(true)
    expect(await dumpExists("within_20260901_020001.dump", dir)).toBe(false)
    expect(await dumpExists("../secret.dump", dir)).toBe(false)
  })
})

describe("destUsage", () => {
  it("used and total bytes of the filesystem behind the backup folder (statfs)", async () => {
    const u = await destUsage(dir)
    expect(u).not.toBeNull()
    expect(u!.totalBytes).toBeGreaterThan(0)
    expect(u!.usedBytes).toBeGreaterThan(0)
    expect(u!.usedBytes).toBeLessThanOrEqual(u!.totalBytes)
  })
  it("null when the folder is missing (not mounted)", async () => {
    expect(await destUsage(join(dir, "nope"))).toBeNull()
  })
})
