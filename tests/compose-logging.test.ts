/**
 * Docker-Log-Rotation:
 *
 * Kein Service hatte ein logging:-Limit — der Default-json-file-Driver
 * schreibt unbegrenzt. Die App loggt ausschließlich nach stdout/stderr
 * (src/lib/logger.ts), Postgres ebenfalls: eine Crash-Loop (Migrationsfehler →
 * instrumentation rethrow → restart: unless-stopped) oder eine
 * Sync-Retry-Schleife gegen eine fehlschlagende Route schreibt die SD-Karte
 * über Wochen voll → ENOSPC → Postgres tot.
 *
 * Greift beim nächsten Redeploy des Stacks (Compose ist die
 * Stack-Definition) — keine Pi-Handarbeit nötig.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8")

// Zählt Dienste mit einem logging:-Eintrag — ausgeschrieben (`logging:` mit
// Block, ggf. als Anker `&logging`) oder als Alias (`logging: *logging`).
function loggingBlocks(compose: string): number {
  return (compose.match(/^ {4}logging:(\s|$)/gm) ?? []).length
}

describe("Docker-Logging-Limits (B30)", () => {
  it("docker-compose.yml: app UND db haben json-file-Limits (max-size/max-file)", () => {
    const compose = read("docker-compose.yml")
    expect(compose).toContain("logging:")
    expect(loggingBlocks(compose)).toBeGreaterThanOrEqual(2)
    expect(compose).toContain("max-file")
  })

  it("docker-compose.dev.yml: alle Services (inkl. Caddy) haben Limits", () => {
    const compose = read("docker-compose.dev.yml")
    expect(loggingBlocks(compose)).toBeGreaterThanOrEqual(3)
  })

})
