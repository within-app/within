#!/usr/bin/env node
// Downloads the glyph PBF ranges needed for map city labels into
// public/map/font/. Run once when the label character set changes
// (the ranges below cover every codepoint in cities.json).
//
// Source: https://github.com/protomaps/basemaps-assets (fonts/, SIL OFL 1.1 —
// prebuilt SDF glyphs of Noto Sans). The PBFs are checked into the repo so
// runtime and CI never need network access.
import { writeFileSync, mkdirSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const FONT = "Noto Sans Regular"
const RANGES = ["0-255", "256-511", "512-767", "7680-7935", "8192-8447"]
const BASE = "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts"

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "map", "font", FONT)
mkdirSync(dest, { recursive: true })

for (const range of RANGES) {
  const url = `${BASE}/${encodeURIComponent(FONT)}/${range}.pbf`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(join(dest, `${range}.pbf`), buf)
  console.log(`${range}.pbf (${(buf.length / 1024).toFixed(0)} KB)`)
}
