/**
 * docker-entrypoint.sh füllt SESSION_SECRET und DATABASE_URL aus dem
 * Secrets-Volume nach — nur wenn sie nicht gesetzt sind — und startet den
 * eigentlichen Befehl. Läuft mit dem lokalen /bin/sh gegen ein Temp-Verzeichnis.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

const SCRIPT = resolve(__dirname, "../docker-entrypoint.sh")
let dir: string

function run(env: Record<string, string>): Record<string, string> {
  const out = execFileSync("/bin/sh", [SCRIPT, "/usr/bin/env"], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", WITHIN_SECRETS_DIR: dir, ...env },
    encoding: "utf8",
  })
  return Object.fromEntries(
    out.trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)] })
  )
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "within-secrets-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("docker-entrypoint.sh", () => {
  it("baut DATABASE_URL und SESSION_SECRET aus den Secrets-Dateien", () => {
    writeFileSync(join(dir, "db_password"), "AbC123xyz\n")
    writeFileSync(join(dir, "session_secret"), "s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t\n")
    const env = run({})
    expect(env.DATABASE_URL).toBe("postgresql://journal:AbC123xyz@db:5432/journal")
    expect(env.SESSION_SECRET).toBe("s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t")
  })

  it("explizit gesetzte Variablen haben Vorrang (bestehende Installationen)", () => {
    writeFileSync(join(dir, "db_password"), "generated")
    writeFileSync(join(dir, "session_secret"), "generated-secret")
    const env = run({ DATABASE_URL: "postgresql://x:y@host:5432/z", SESSION_SECRET: "own-secret-own-secret-own-secret" })
    expect(env.DATABASE_URL).toBe("postgresql://x:y@host:5432/z")
    expect(env.SESSION_SECRET).toBe("own-secret-own-secret-own-secret")
  })

  it("ohne Secrets-Dateien bleibt die Umgebung unverändert (env.ts meldet dann den Fehler)", () => {
    const env = run({})
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.SESSION_SECRET).toBeUndefined()
  })

  it("Host und Datenbankname sind über WITHIN_DB_* übersteuerbar", () => {
    writeFileSync(join(dir, "db_password"), "pw")
    const env = run({ WITHIN_DB_HOST: "postgres", WITHIN_DB_NAME: "diary", WITHIN_DB_USER: "diary" })
    expect(env.DATABASE_URL).toBe("postgresql://diary:pw@postgres:5432/diary")
  })
})
