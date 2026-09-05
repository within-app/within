import { describe, it, expect } from "vitest"
import type { FeatureCollection, Polygon, MultiLineString } from "geojson"
import {
  geoDetailForZoom,
  unwrapLine,
  unwrapAntimeridian,
  cssVarToHsl,
  MAP_MIN_ZOOM,
  MAP_MAX_ZOOM,
  DETAIL_SWITCH_ZOOM,
  DETAIL_LAYERS_ZOOM,
  type City,
} from "@/components/map/map-detail"
import cities from "@/components/map/cities.json"
import layers from "@/components/map/layers-50m.json"

describe("zoom constants", () => {
  it("orders the zoom thresholds sensibly", () => {
    expect(MAP_MIN_ZOOM).toBeLessThan(DETAIL_LAYERS_ZOOM)
    expect(DETAIL_LAYERS_ZOOM).toBeLessThan(DETAIL_SWITCH_ZOOM)
    expect(DETAIL_SWITCH_ZOOM).toBeLessThan(MAP_MAX_ZOOM)
  })
})

describe("geoDetailForZoom", () => {
  it("uses 50m at low zoom and 10m from the switch threshold", () => {
    expect(geoDetailForZoom(MAP_MIN_ZOOM)).toBe("50m")
    expect(geoDetailForZoom(DETAIL_SWITCH_ZOOM - 0.1)).toBe("50m")
    expect(geoDetailForZoom(DETAIL_SWITCH_ZOOM)).toBe("10m")
    expect(geoDetailForZoom(MAP_MAX_ZOOM)).toBe("10m")
  })
})

describe("unwrapLine", () => {
  it("leaves lines without seam crossings untouched", () => {
    const line = [[9, 53], [10, 54], [11, 53]]
    expect(unwrapLine(line)).toEqual(line)
  })

  it("unwraps an east-to-west antimeridian jump (Russia's seam edge)", () => {
    // world-atlas: 179.87 → −180 is a ~0.13° step, not a 359.87° one
    const out = unwrapLine([[179.5, 69], [179.87, 69], [-180, 69], [-179.9, 68]])
    expect(out.map((p) => p[1])).toEqual([69, 69, 69, 68])
    expect(out[2][0]).toBeCloseTo(180, 6)
    expect(out[3][0]).toBeCloseTo(180.1, 6)
  })

  it("unwraps a west-to-east jump symmetrically", () => {
    const out = unwrapLine([[-179.5, -16], [-180, -16], [179.99, -16.5]])
    expect(out[1][0]).toBe(-180)
    expect(out[2][0]).toBeCloseTo(-180.01, 6)
  })

  it("returns to the original frame after a double crossing", () => {
    const out = unwrapLine([[179, 0], [-180, 0], [179.9, 1], [179, 0]])
    expect(out[out.length - 1]).toEqual([179, 0])
  })
})

describe("unwrapAntimeridian", () => {
  const crossingRing = [[179, 69], [-180, 69], [-180, 70], [179, 70], [179, 69]]

  it("fixes polygon rings inside a FeatureCollection", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [crossingRing] },
      }],
    }
    const ring = (unwrapAntimeridian(fc).features[0].geometry as Polygon).coordinates[0]
    const lngs = ring.map((p) => p[0])
    for (let i = 1; i < lngs.length; i++) {
      expect(Math.abs(lngs[i] - lngs[i - 1])).toBeLessThanOrEqual(180)
    }
  })

  it("fixes bare MultiLineString geometry (topojson mesh output)", () => {
    const geom: MultiLineString = {
      type: "MultiLineString",
      coordinates: [[[179.9, 69], [-180, 69.1]]],
    }
    expect(unwrapAntimeridian(geom).coordinates[0]).toEqual([[179.9, 69], [180, 69.1]])
  })

  it("leaves point geometries untouched", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [179.9, 69] },
      }],
    }
    expect(unwrapAntimeridian(structuredClone(fc))).toEqual(fc)
  })
})

describe("cssVarToHsl", () => {
  it("converts a Tailwind HSL triplet into MapLibre-parsable hsl()", () => {
    expect(cssVarToHsl("205 58% 94%")).toBe("hsl(205,58%,94%)")
    expect(cssVarToHsl("  240 6% 74%  ")).toBe("hsl(240,6%,74%)")
  })

  it("returns the fallback for empty or malformed values", () => {
    expect(cssVarToHsl("")).toBe("hsl(0,0%,50%)")
    expect(cssVarToHsl("nonsense", "#123")).toBe("#123")
  })
})

describe("cities.json data shape", () => {
  it("contains the full Natural Earth places set as valid tuples", () => {
    expect(cities.length).toBeGreaterThan(7000)
    for (const c of cities as City[]) {
      expect(typeof c[0]).toBe("string")
      expect(c[0].length).toBeGreaterThan(0)
      expect(c[1]).toBeGreaterThanOrEqual(-180)
      expect(c[1]).toBeLessThanOrEqual(180)
      expect(c[2]).toBeGreaterThanOrEqual(-90)
      expect(c[2]).toBeLessThanOrEqual(90)
      expect(c[3]).toBeGreaterThanOrEqual(0)
      expect(c[3]).toBeLessThanOrEqual(10)
    }
  })
})

describe("layers-50m.json data shape", () => {
  it("bundles the three mid-zoom detail layers with mz-only properties", () => {
    for (const key of ["admin1", "lakes", "rivers"] as const) {
      const fc = layers[key] as FeatureCollection
      expect(fc.type).toBe("FeatureCollection")
      expect(fc.features.length).toBeGreaterThan(100)
      for (const f of fc.features) {
        expect(Object.keys(f.properties ?? {})).toEqual(["mz"])
        expect(f.geometry).toBeTruthy()
      }
    }
  })
})
