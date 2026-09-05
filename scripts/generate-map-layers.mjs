#!/usr/bin/env node
// Generates src/components/map/layers-50m.json — the mid-zoom detail layers
// (admin-1 boundaries, lakes, rivers) bundled for the MapLibre map view.
//
// Source (public domain, https://www.naturalearthdata.com/about/terms-of-use/),
// GeoJSON conversion via https://github.com/martynafford/natural-earth-geojson:
//   .../50m/cultural/ne_50m_admin_1_states_provinces_lines.json
//   .../50m/physical/ne_50m_lakes.json
//   .../50m/physical/ne_50m_rivers_lake_centerlines.json
//
// Usage: node scripts/generate-map-layers.mjs <admin1-lines.json> <lakes.json> <rivers.json>
//
// Output: one FeatureCollection per layer, properties reduced to { mz } (the
// Natural Earth min_zoom reveal level), coordinates rounded to 4 decimals
// (~11 m — well below 1:50m source resolution).
import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const [admin1Src, lakesSrc, riversSrc] = process.argv.slice(2)
if (!admin1Src || !lakesSrc || !riversSrc) {
  console.error("Usage: node scripts/generate-map-layers.mjs <admin1-lines.json> <lakes.json> <rivers.json>")
  process.exit(1)
}

const round4 = (n) => Math.round(n * 10000) / 10000

function roundCoords(coords) {
  if (typeof coords[0] === "number") return [round4(coords[0]), round4(coords[1])]
  return coords.map(roundCoords)
}

function slim(path) {
  const fc = JSON.parse(readFileSync(path, "utf8"))
  return {
    type: "FeatureCollection",
    features: fc.features
      .filter((f) => f.geometry)
      .map((f) => ({
        type: "Feature",
        properties: { mz: Number.isFinite(f.properties.min_zoom) ? f.properties.min_zoom : 0 },
        geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
      })),
  }
}

const out = {
  admin1: slim(admin1Src),
  lakes: slim(lakesSrc),
  rivers: slim(riversSrc),
}

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "map", "layers-50m.json")
const json = JSON.stringify(out)
writeFileSync(dest, json)
console.log(
  `wrote ${out.admin1.features.length} admin1 / ${out.lakes.features.length} lakes / ` +
  `${out.rivers.features.length} rivers to ${dest} (${(json.length / 1024).toFixed(0)} KB raw)`
)
