/**
 * Karte-leer-Klasse (SHELL_VER v6/v10): das MapLibre-Worker-Paar lag ungehasht
 * unter /map/, der SW hielt es cache-first — nach jedem maplibre-Upgrade klebte
 * der alte Worker am neuen Bundle, bis jemand SHELL_VER von Hand hob. Seit #528
 * liegt das Paar unter /map/<maplibre-version>/ (Kopierskript) und die Karte
 * fragt genau diesen Pfad (getVersion()) — versionierter Pfad = cache-first korrekt.
 *
 * Das Skript läuft hier wirklich (predev/prebuild tun dasselbe); der Ordner ist
 * gitignored.
 */
import { describe, it, expect } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs"
import { join, resolve } from "path"
import { getVersion } from "maplibre-gl"

const root = resolve(__dirname, "..")
const mapDir = join(root, "public", "map")

describe("MapLibre-Worker unter versioniertem Pfad", () => {
  it("getVersion() der Karte ist die Version des installierten Pakets", () => {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", "maplibre-gl", "package.json"), "utf8"))
    expect(getVersion()).toBe(pkg.version)
  })

  it("map-view.tsx lädt den Worker unter /map/<getVersion()>/", () => {
    const view = readFileSync(join(root, "src", "components", "map", "map-view.tsx"), "utf8")
    expect(view).toContain("setWorkerUrl(`/map/${getVersion()}/maplibre-gl-worker.mjs`)")
  })

  it("Kopierskript legt das Paar unter public/map/<version>/ ab und räumt ältere Versionsordner weg", () => {
    const stale = join(mapDir, "0.0.0-stale")
    mkdirSync(stale, { recursive: true })
    execFileSync(process.execPath, [join(root, "scripts", "copy-map-worker.mjs")], { cwd: root })

    const dest = join(mapDir, getVersion())
    expect(existsSync(join(dest, "maplibre-gl-worker.mjs"))).toBe(true)
    expect(existsSync(join(dest, "maplibre-gl-shared.mjs"))).toBe(true)
    expect(existsSync(stale)).toBe(false)
    // Glyphen (eingecheckt) bleiben unberührt.
    expect(existsSync(join(mapDir, "font"))).toBe(true)
    rmSync(stale, { recursive: true, force: true })
  })
})
