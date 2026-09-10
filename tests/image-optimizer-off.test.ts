/**
 * Bild-Optimizer (/_next/image) ist abgeschaltet.
 *
 * next/image wird im Code nicht benutzt, der Endpunkt läuft aber ohne Login
 * (src/proxy.ts nimmt _next/image aus dem Matcher) — die AVIF-RCE
 * GHSA-2xp9-vwfh-vxw4 lag genau dort. Mit images.unoptimized rendert
 * next-server.js für /_next/image ein 404, bevor Parameter gelesen werden.
 */
import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join, resolve } from "path"

describe("next.config: Bild-Optimizer aus", () => {
  it("images.unoptimized ist true", async () => {
    const config = (await import("../next.config")).default
    expect(config.images?.unoptimized).toBe(true)
  })

  it("src/ importiert next/image nicht (sonst bräuchte es den Optimizer)", () => {
    const root = resolve(__dirname, "..", "src")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    const users = files.filter((f) => /from ["']next\/image["']/.test(readFileSync(f, "utf8")))
    expect(users).toEqual([])
  })
})
