#!/usr/bin/env node
// Copies the MapLibre worker pair from node_modules into public/map/ so the
// map can create its Web Worker from a same-origin URL (CSP: worker-src 'self',
// no blob:). Runs via the predev/prebuild hooks; public/map/*.mjs is
// gitignored so the served files always match the installed maplibre-gl.
// The worker imports ./maplibre-gl-shared.mjs relatively — both files must
// live side by side.
import { copyFileSync, mkdirSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = join(root, "node_modules", "maplibre-gl", "dist")
const dest = join(root, "public", "map")

mkdirSync(dest, { recursive: true })
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(src, f), join(dest, f))
}
console.log("copied maplibre worker pair to public/map/")
