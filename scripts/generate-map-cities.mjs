#!/usr/bin/env node
// Generates src/components/map/cities.json from Natural Earth populated places.
//
// Source (public domain, https://www.naturalearthdata.com/about/terms-of-use/):
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson
//
// Usage: node scripts/generate-map-cities.mjs <path-to-ne_10m_populated_places_simple.geojson>
//
// Output format: array of [name, lng, lat, minZoom] tuples,
// sorted by pop_max descending so array order encodes label priority.
// Coordinates rounded to 2 decimals (~1 km) — enough for map labels.
import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const src = process.argv[2]
if (!src) {
  console.error("Usage: node scripts/generate-map-cities.mjs <ne_10m_populated_places_simple.geojson>")
  process.exit(1)
}

const features = JSON.parse(readFileSync(src, "utf8")).features
const round2 = (n) => Math.round(n * 100) / 100

const cities = features
  .filter((f) => f.properties.name && Number.isFinite(f.properties.min_zoom))
  .sort((a, b) => (b.properties.pop_max || 0) - (a.properties.pop_max || 0))
  .map((f) => [
    f.properties.name,
    round2(f.properties.longitude),
    round2(f.properties.latitude),
    Math.round(f.properties.min_zoom * 10) / 10,
  ])

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "map", "cities.json")
writeFileSync(out, JSON.stringify(cities))
console.log(`wrote ${cities.length} cities to ${out} (${(JSON.stringify(cities).length / 1024).toFixed(0)} KB raw)`)
