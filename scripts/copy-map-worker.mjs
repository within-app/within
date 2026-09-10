#!/usr/bin/env node
// Copies the MapLibre worker pair from node_modules into public/map/<version>/
// so the map can create its Web Worker from a same-origin URL (CSP: worker-src
// 'self', no blob:). Runs via the predev/prebuild hooks; the version folder is
// gitignored so the served files always match the installed maplibre-gl.
// The path carries the package version because the file names are not hashed:
// the SW keeps /map/ cache-first, and an unversioned worker stayed pinned to a
// new bundle after every maplibre upgrade (SHELL_VER v6/v10 incidents).
// map-view.tsx asks for exactly this path via getVersion(). Older version
// folders are removed. The worker imports ./maplibre-gl-shared.mjs relatively —
// both files must live side by side.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "fs"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { version } = createRequire(import.meta.url)("maplibre-gl/package.json")
const src = join(root, "node_modules", "maplibre-gl", "dist")
const mapDir = join(root, "public", "map")
const dest = join(mapDir, version)

mkdirSync(dest, { recursive: true })
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(src, f), join(dest, f))
}
for (const d of readdirSync(mapDir, { withFileTypes: true })) {
  if (d.isDirectory() && /^\d+\.\d+\.\d+/.test(d.name) && d.name !== version) {
    rmSync(join(mapDir, d.name), { recursive: true, force: true })
  }
  // Pre-#528 layout (unversioned copies directly in public/map/) — no longer
  // gitignored, so they would show up as untracked files after the switch.
  if (d.isFile() && d.name.endsWith(".mjs")) rmSync(join(mapDir, d.name), { force: true })
}
console.log(`copied maplibre worker pair to public/map/${version}/`)
