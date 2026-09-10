/**
 * Restore button — source contracts between the pieces that cannot be unit
 * tested together: compose mounts, the backup loop's polling, the restore
 * script's guards, the schema column and the status card's filter.
 * (The real end-to-end run is documented in the PR — docker compose on a Mac.)
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8")

describe("docker-compose.yml — restore wiring", () => {
  const compose = read("docker-compose.yml")
  it("one backup folder definition, mounted read-only into app and writable into backup", () => {
    expect(compose).toMatch(/^x-backup-dir: &backup_dir/m)
    expect(compose).toMatch(/- <<: \*backup_dir\n\s+read_only: true/)
    expect(compose).toMatch(/- \*backup_dir/)
    expect(compose).toContain("create_host_path: true")
  })
  it("the backup service can write the media folder back (no :ro)", () => {
    const backup = compose.slice(compose.indexOf("\n  backup:"))
    expect(backup).toContain("- media_data:/app/public/media\n")
    expect(backup).not.toContain("media_data:/app/public/media:ro")
  })
})

describe("docker-compose.yml — app healthcheck", () => {
  it("timeout is above the app's 5s connect timeout and start_period covers the migration retry budget (30 × 7s + boot)", () => {
    const app = read("docker-compose.yml").split("\n  app:")[1]
    expect(Number(app.match(/timeout:\s*(\d+)s/)![1])).toBeGreaterThan(5)
    expect(Number(app.match(/start_period:\s*(\d+)s/)![1])).toBeGreaterThanOrEqual(240)
  })
})

describe("scripts/backup — restore path", () => {
  it("loop.sh polls app_settings.restore_request and consumes it before restore.sh", () => {
    const loop = read("scripts/backup/loop.sh")
    expect(loop).toContain("restore_request")
    expect(loop).toContain('"$SCRIPT_DIR/restore.sh" "$dump"')
    expect(loop.indexOf("DELETE FROM app_settings")).toBeLessThan(loop.indexOf('"$SCRIPT_DIR/restore.sh"'))
    expect(loop).not.toMatch(/^\s*sleep "\$wait_seconds"/m)
  })
  it("restore.sh validates the dump name before it reaches psql, drops WITH (FORCE) and writes the restore row", () => {
    const restore = read("scripts/backup/restore.sh")
    expect(restore).toMatch(/\[\[\s*"\$DUMP_NAME"\s*=~\s*\^within_\[0-9\]/)
    expect(restore.indexOf("=~ ^within_")).toBeLessThan(restore.indexOf("DROP DATABASE"))
    expect(restore).toContain("WITH (FORCE)")
    expect(restore).toContain("--no-acl --no-owner")
    expect(restore).toContain("('restore', 'ok'")
    expect(restore).toContain("rsync -a --delete --chown=nextjs:nodejs")
  })
  it("backup-full.sh keeps the folder traversable for the app (711, not 700)", () => {
    expect(read("scripts/backup/backup-full.sh")).toContain('chmod 711 "${BACKUP_DEST}"')
  })
  it("backup-verify.sh writes the counts sidecar, backup-retention.sh removes it with the dump", () => {
    expect(read("scripts/backup/backup-verify.sh")).toContain('"${latest_dump}.meta.json"')
    expect(read("scripts/backup/backup-retention.sh")).toContain('"${dump}.meta.json"')
  })
})

describe("schema + status card", () => {
  it("backup_runs.kind exists idempotently and the status card only reads backup rows", () => {
    expect(read("src/lib/db/schema.sql")).toMatch(/column_name = 'kind'[\s\S]*ADD COLUMN kind TEXT NOT NULL DEFAULT 'backup'/)
    expect(read("src/app/api/backup/status/route.ts")).toContain("WHERE kind = 'backup'")
  })
})
