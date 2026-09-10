/**
 * Backup controls (PR F) — the shell side, really executed against a temp
 * folder shaped like /backup. psql/pg_dump/pg_restore/ionice/mountpoint are
 * PATH stubs (same idea as docker-entrypoint.test.ts): psql logs every call so
 * the backup_runs row each guard writes can be asserted.
 *
 *  1. space guard in backup-full.sh: need = 2 × last dump + media to transfer
 *     + 100 MB; frees the oldest dumps (with their .meta.json) down to a floor
 *     of 3, and aborts with a failed row when that is still not enough
 *  2. marker file .within-backup-stick, checked in backup-full.sh,
 *     backup-verify.sh and restore.sh only when BACKUP_REQUIRE_MARKER=true
 *  3. loop.sh skips the nightly chain while app_settings.backup_paused_at is
 *     set and records a 'skipped' row
 *
 * Synthetic files only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

const SCRIPTS = resolve(__dirname, "../scripts/backup")
const MiB = 1024 * 1024

let dir: string
let dest: string
let media: string
let bin: string
let psqlLog: string

function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "within-backup-controls-"))
  dest = join(dir, "backup")
  media = join(dir, "media")
  bin = join(dir, "bin")
  psqlLog = join(dir, "psql.log")
  mkdirSync(join(dest, "db"), { recursive: true })
  mkdirSync(media)
  mkdirSync(bin)
  stub("psql", `printf '%s\\n' "$*" >> "$STUB_PSQL_LOG"
case "$*" in
  *server_version_num*) echo 160004 ;;
  *backup_paused_at*) echo "\${STUB_PAUSED_AT:-}" ;;
esac`)
  stub("pg_dump", `for a in "$@"; do case "$a" in --file=*) head -c ${MiB} /dev/zero > "\${a#--file=}" ;; esac; done`)
  stub("pg_restore", "exit 0")
  stub("ionice", 'shift 4; exec "$@"')
  stub("mountpoint", "exit 0")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(script: string, env: Record<string, string>, args: string[] = [], timeout?: number) {
  const res = spawnSync("bash", [join(SCRIPTS, script), ...args], {
    env: {
      NODE_ENV: "test",
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      ENV_FILE: join(dir, "none.env"),
      DATABASE_URL: "postgresql://t:t@localhost:5432/t",
      BACKUP_DEST: dest,
      BACKUP_MEDIA_SRC: media,
      STUB_PSQL_LOG: psqlLog,
      ...env,
    },
    encoding: "utf8",
    timeout,
  })
  const log = existsSync(psqlLog) ? readFileSync(psqlLog, "utf8") : ""
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, psql: log }
}

function seedDumps(names: string[]) {
  for (const n of names) {
    writeFileSync(join(dest, "db", n), Buffer.alloc(MiB))
    writeFileSync(join(dest, "db", `${n}.meta.json`), '{"entries":1,"media":0}')
  }
}
const dumps = () => readdirSync(join(dest, "db")).filter((n) => n.endsWith(".dump")).sort()

describe("backup-full.sh — space guard", () => {
  it("frees the oldest dumps (with sidecar) until the estimate fits, then backs up", () => {
    seedDumps([
      "within_20260901_020000.dump", "within_20260902_020000.dump", "within_20260903_020000.dump",
      "within_20260904_020000.dump", "within_20260905_020000.dump",
    ])
    writeFileSync(join(media, "photo.bin"), Buffer.alloc(2 * MiB))
    writeFileSync(join(dest, ".within-backup-stick"), "") // marker present → the guard passes
    // need = 2 × 1 MiB (last dump) + 2 MiB (media to transfer) + 100 MiB = 104 MiB; 102 free → two dumps go
    const ok = run("backup-full.sh", { BACKUP_FREE_BYTES_OVERRIDE: String(102 * MiB), BACKUP_REQUIRE_MARKER: "true" }, [], 30_000)
    expect(ok.stderr).toBe("")
    expect(ok.status).toBe(0)
    const left = dumps()
    expect(left).toHaveLength(4) // 3 kept + the new one
    expect(left.slice(0, 3)).toEqual(["within_20260903_020000.dump", "within_20260904_020000.dump", "within_20260905_020000.dump"])
    expect(existsSync(join(dest, "db", "within_20260901_020000.dump.meta.json"))).toBe(false)
    expect(existsSync(join(dest, "db", "within_20260902_020000.dump.meta.json"))).toBe(false)
    expect(existsSync(join(dest, "media", "photo.bin"))).toBe(true)
    expect(ok.psql).not.toContain("'error'")
    const runLog = readdirSync(join(dest, "logs")).find((n) => n.startsWith("backup_"))!
    expect(readFileSync(join(dest, "logs", runLog), "utf8")).toMatch(/freed .*within_20260901_020000\.dump/)
  }, 30_000)

  it("keeps at least 3 dumps and fails with a clear message when space is still short", () => {
    seedDumps([
      "within_20260901_020000.dump", "within_20260902_020000.dump",
      "within_20260903_020000.dump", "within_20260904_020000.dump",
    ])
    // need = 2 + 0 + 100 = 102 MiB; 90 free, one deletion allowed (floor 3) → 91 MiB, still short
    const r = run("backup-full.sh", { BACKUP_FREE_BYTES_OVERRIDE: String(90 * MiB) }, [], 30_000)
    expect(r.status).toBe(1)
    expect(dumps()).toEqual(["within_20260902_020000.dump", "within_20260903_020000.dump", "within_20260904_020000.dump"])
    expect(r.psql).toContain("'error', 'Backup-Ziel voll: 91 MB frei, 102 MB nötig'")
    expect(readdirSync(join(dest, "db")).some((n) => n.endsWith(".part"))).toBe(false)
  })

  it("a missing media folder degrades the estimate to 0 instead of killing the dump (review #532)", () => {
    const r = run("backup-full.sh", { BACKUP_MEDIA_SRC: join(dir, "no-such-media") }, [], 30_000)
    expect(dumps()).toHaveLength(1)
    expect(readdirSync(join(dest, "db")).some((n) => n.endsWith(".part"))).toBe(false)
    const runLog = readdirSync(join(dest, "logs")).find((n) => n.startsWith("backup_"))!
    expect(readFileSync(join(dest, "logs", runLog), "utf8")).toMatch(/db dump →/)
    // the real media rsync afterwards still reports the missing folder (as on main)
    expect(r.status).not.toBe(0)
  })

  it("without the override the free space comes from df on the destination", () => {
    const r = run("backup-full.sh", {}, [], 30_000)
    expect(r.status).toBe(0)
    expect(dumps()).toHaveLength(1)
  })
})

describe("marker file .within-backup-stick (BACKUP_REQUIRE_MARKER=true)", () => {
  it("backup-full.sh: missing marker → failed row, nothing written", () => {
    const r = run("backup-full.sh", { BACKUP_REQUIRE_MARKER: "true" })
    expect(r.status).toBe(1)
    expect(r.psql).toContain("'error', 'Backup-Ziel nicht bereit: Marker-Datei fehlt — steckt der USB-Stick?'")
    expect(existsSync(join(dest, "logs"))).toBe(false)
  })

  it("backup-full.sh: default (unset) does not require the marker", () => {
    const r = run("backup-full.sh", {}, [], 30_000)
    expect(r.status).toBe(0)
    expect(r.psql).not.toContain("Marker-Datei")
  })

  it("backup-verify.sh: missing marker → failed row before any restore", () => {
    const r = run("backup-verify.sh", { BACKUP_REQUIRE_MARKER: "true" })
    expect(r.status).toBe(1)
    expect(r.psql).toContain("Marker-Datei fehlt")
    expect(r.psql).not.toContain("CREATE DATABASE")
  })

  it("restore.sh: missing marker → failed restore row before anything is dropped", () => {
    const r = run("restore.sh", { BACKUP_REQUIRE_MARKER: "true" }, ["within_20260901_020000.dump"])
    expect(r.status).toBe(1)
    expect(r.psql).toContain("Marker-Datei fehlt")
    expect(r.psql).not.toContain("DROP DATABASE")
  })
})

describe("restore.sh — pause switch survives a restore (review #532)", () => {
  const DUMP = "within_20260901_020000.dump"
  it("reads backup_paused_at before the drop and writes it back after the restore", () => {
    writeFileSync(join(dest, "db", DUMP), "dump")
    const r = run("restore.sh", { STUB_PAUSED_AT: "2026-09-09T20:00:00.000Z" }, [DUMP], 30_000)
    expect(r.status).toBe(0)
    const drop = r.psql.indexOf("DROP DATABASE")
    const put = r.psql.indexOf("INSERT INTO app_settings (key, value) VALUES ('backup_paused_at', '2026-09-09T20:00:00.000Z')")
    expect(drop).toBeGreaterThan(-1)
    expect(put).toBeGreaterThan(drop)
    expect(r.psql.indexOf("SELECT value FROM app_settings WHERE key = 'backup_paused_at'")).toBeLessThan(drop)
  })
  it("not paused → the key from the dump is removed, nothing written back", () => {
    writeFileSync(join(dest, "db", DUMP), "dump")
    const r = run("restore.sh", {}, [DUMP], 30_000)
    expect(r.status).toBe(0)
    expect(r.psql).toContain("DELETE FROM app_settings WHERE key = 'backup_paused_at'")
    expect(r.psql).not.toContain("INSERT INTO app_settings (key, value) VALUES ('backup_paused_at'")
  })
})

describe("loop.sh — pause switch", () => {
  it("backup_paused_at set → nightly chain skipped, one 'skipped' row", () => {
    const r = run("loop.sh", { BACKUP_RUN_NOW: "1", RESTORE_POLL_SECONDS: "1", STUB_PAUSED_AT: "2026-09-09T20:00:00.000Z" }, [], 8_000)
    expect(r.stdout).toContain("backup paused since 2026-09-09T20:00:00.000Z — skipping nightly run")
    expect(r.stdout).not.toContain("running backup chain")
    expect(r.psql).toContain("INSERT INTO backup_runs (status, error_msg) VALUES ('skipped'")
    expect(existsSync(join(dest, "logs"))).toBe(false)
  }, 15_000)

  it("not paused → the chain runs", () => {
    const r = run("loop.sh", { BACKUP_RUN_NOW: "1", RESTORE_POLL_SECONDS: "1" }, [], 8_000)
    expect(r.stdout).toContain("running backup chain")
    expect(r.psql).not.toContain("'skipped'")
  }, 15_000)
})
