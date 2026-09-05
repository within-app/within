/**
 * Backup shell scripts structural tests
 *
 * Validates:
 * 1. All backup scripts exist at expected paths
 * 2. Each has a valid bash shebang
 * 3. Each has `set -euo pipefail`
 * 4. bash -n syntax check passes (no parse errors)
 * 5. No plaintext secrets (PASSWORD= without quoting, hardcoded credentials)
 *
 * These are structural/lint tests; the actual backup behaviour requires a
 * running stack and is validated by docs/backup-restore.md.
 * Synthetic data only — no real credentials.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, statSync } from "fs"
import { execSync } from "child_process"
import { resolve } from "path"

const REPO_ROOT = resolve(__dirname, "..")
const SCRIPTS_DIR = resolve(REPO_ROOT, "scripts/backup")

const SCRIPTS = [
  "backup-full.sh",
  "backup-retention.sh",
  "backup-verify.sh",
  "loop.sh",
]

for (const script of SCRIPTS) {
  const scriptPath = resolve(SCRIPTS_DIR, script)

  describe(`scripts/backup/${script}`, () => {
    it("exists", () => {
      expect(existsSync(scriptPath)).toBe(true)
    })

    it("starts with bash shebang", () => {
      const content = readFileSync(scriptPath, "utf8")
      expect(content.startsWith("#!/usr/bin/env bash")).toBe(true)
    })

    it("has set -euo pipefail", () => {
      const content = readFileSync(scriptPath, "utf8")
      expect(content).toContain("set -euo pipefail")
    })

    it("passes bash -n syntax check", () => {
      expect(() => execSync(`bash -n ${scriptPath}`, { stdio: "pipe" })).not.toThrow()
    })

    it("does not hardcode a password value", () => {
      const content = readFileSync(scriptPath, "utf8")
      // Should never contain literal password values — only variable references
      expect(content).not.toMatch(/PGPASSWORD=['"][^$'"]{8,}['"]/)
    })

    it("never echoes PGPASSWORD or secrets", () => {
      const content = readFileSync(scriptPath, "utf8")
      // echo of PGPASSWORD or DATABASE_URL would leak secrets to logs
      expect(content).not.toMatch(/echo.*PGPASSWORD/)
      expect(content).not.toMatch(/echo.*DATABASE_URL/)
    })
  })
}

// Targeted security test for backup-verify.sh: filename must be validated before
// it is interpolated into a psql -c string to prevent SQL injection via crafted filenames.
describe("scripts/backup/backup-verify.sh — SQL injection guard", () => {
  const verifyPath = resolve(SCRIPTS_DIR, "backup-verify.sh")

  it("validates BACKUP_FILE format before using it in SQL", () => {
    const content = readFileSync(verifyPath, "utf8")
    // The guard must use a regex that constrains to the safe filename pattern
    expect(content).toMatch(/\[\[\s*"\$BACKUP_FILE"\s*=~\s*\^within_\[0-9\]/)
  })

  it("rejects unexpected filename and exits before any INSERT", () => {
    const content = readFileSync(verifyPath, "utf8")
    // The rejection exit must appear before the main INSERT block
    const guardIdx = content.indexOf("unexpected dump filename format")
    const insertIdx = content.indexOf("live_entry_count, verify_entry_count")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(insertIdx)
  })
})
