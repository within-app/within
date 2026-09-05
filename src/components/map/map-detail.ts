// Pure logic for the MapLibre map view — kept out of the component for testability.

import type {
  FeatureCollection,
  Geometry,
  Position,
  Polygon,
  MultiPolygon,
  LineString,
  MultiLineString,
} from "geojson"

// [name, lng, lat, minZoom] — minZoom is Natural Earth's designed label reveal level (0–10).
// cities.json is sorted by population descending, so array order encodes label priority.
export type City = [name: string, lng: number, lat: number, minZoom: number]

// MapLibre (web-mercator) zoom levels — Natural Earth min_zoom uses the same scale.
export const MAP_MIN_ZOOM = 0.8
export const MAP_MAX_ZOOM = 12

// Zoom at which the 10m country polygons replace the 50m base.
export const DETAIL_SWITCH_ZOOM = 4.5

// Zoom at which the mid-zoom detail chunk (admin-1 borders, lakes, rivers) loads.
export const DETAIL_LAYERS_ZOOM = 2.5

export function geoDetailForZoom(zoom: number): "50m" | "10m" {
  return zoom >= DETAIL_SWITCH_ZOOM ? "10m" : "50m"
}

/**
 * Rewrites a coordinate line so consecutive longitudes never jump across the
 * antimeridian: after a ±180° seam crossing all following points shift by
 * ±360°, making the line continuous (possibly extending past ±180 — MapLibre
 * renders that correctly via world copies).
 */
export function unwrapLine(line: Position[]): Position[] {
  let offset = 0
  const out: Position[] = [line[0]]
  for (let i = 1; i < line.length; i++) {
    const delta = line[i][0] - line[i - 1][0]
    if (delta > 180) offset -= 360
    else if (delta < -180) offset += 360
    out.push(offset === 0 ? line[i] : [line[i][0] + offset, line[i][1]])
  }
  return out
}

/**
 * Fixes antimeridian-crossing edges in world-atlas geometry (Russia, Fiji,
 * Antarctica contain rings whose edges jump from ~+180 to −180). MapLibre's
 * tiler draws such edges straight across the world map — visible as giant
 * fill slivers and horizontal bands over the oceans. Returns the same object,
 * mutated. Handles FeatureCollections and bare geometries (topojson mesh).
 */
export function unwrapAntimeridian<T extends FeatureCollection | Geometry>(input: T): T {
  if (input.type === "FeatureCollection") {
    for (const f of input.features) {
      if (f.geometry) unwrapAntimeridian(f.geometry)
    }
    return input
  }
  const g = input as Geometry
  if (g.type === "Polygon") {
    ;(g as Polygon).coordinates = (g as Polygon).coordinates.map(unwrapLine)
  } else if (g.type === "MultiPolygon") {
    ;(g as MultiPolygon).coordinates = (g as MultiPolygon).coordinates.map((p) => p.map(unwrapLine))
  } else if (g.type === "LineString") {
    ;(g as LineString).coordinates = unwrapLine((g as LineString).coordinates)
  } else if (g.type === "MultiLineString") {
    ;(g as MultiLineString).coordinates = (g as MultiLineString).coordinates.map(unwrapLine)
  }
  return input
}

/**
 * Converts a Tailwind-style HSL variable value ("205 58% 94%") into a color
 * string MapLibre's parser accepts ("hsl(205,58%,94%)"). Returns the fallback
 * for empty/unreadable values (e.g. during tests without real CSS).
 */
export function cssVarToHsl(raw: string, fallback = "hsl(0,0%,50%)"): string {
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 3) return fallback
  return `hsl(${parts[0]},${parts[1]},${parts[2]})`
}
