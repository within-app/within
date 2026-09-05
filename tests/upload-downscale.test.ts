/**
 * PR5 — Upload-Verkleinerung als Geräte-Schalter (Default aus).
 *
 * Deckt die pure Logik ab: Schalter-Persistenz, Verkleinerungs-Bedingungen,
 * Zielmaß-Berechnung (nie hochskalieren, Seitenverhältnis erhalten). Der
 * Browser-Teil (createImageBitmap/Canvas) fällt bei jedem Fehler auf das
 * Original zurück und ist bewusst nicht node-testbar.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import {
  computeTarget,
  needsDownscale,
  isDownscaleEnabled,
  setDownscaleEnabled,
  DOWNSCALE_STORAGE_KEY,
  DOWNSCALE_MAX_EDGE,
  DOWNSCALE_MIN_BYTES,
} from "@/lib/upload-downscale"

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe("Schalter-Persistenz (pro Gerät, Default AUS)", () => {
  it("ist standardmäßig aus — Desktop-Uploads bleiben unangetastet", () => {
    expect(isDownscaleEnabled(makeStore())).toBe(false)
  })

  it("lässt sich ein- und ausschalten", () => {
    const store = makeStore()
    setDownscaleEnabled(store, true)
    expect(isDownscaleEnabled(store)).toBe(true)
    expect(store.getItem(DOWNSCALE_STORAGE_KEY)).toBe("1")
    setDownscaleEnabled(store, false)
    expect(isDownscaleEnabled(store)).toBe(false)
  })

  it("wirft nicht, wenn localStorage nicht verfügbar ist", () => {
    const broken = { getItem: () => { throw new Error("blocked") } }
    expect(isDownscaleEnabled(broken as unknown as Pick<Storage, "getItem">)).toBe(false)
  })
})

describe("needsDownscale", () => {
  const photo = { mimeType: "image/jpeg", width: 6000, height: 3375 }

  it("greift bei großen Dateien (Sony-A7-III-Fall: 9,7 MB, 20 MP)", () => {
    expect(needsDownscale({ ...photo, size: 9_700_000 })).toBe(true)
  })

  it("greift bei großen Kanten trotz kleiner Datei", () => {
    expect(needsDownscale({ mimeType: "image/jpeg", size: 1_000_000, width: 8000, height: 2000 })).toBe(true)
  })

  it("lässt kleine Handy-Fotos unangetastet (4,4 MB, unter Kantenlimit)", () => {
    expect(needsDownscale({ mimeType: "image/jpeg", size: 4_400_000, width: 4000, height: 3000 })).toBe(false)
  })

  it("fasst Videos und Audio nie an", () => {
    expect(needsDownscale({ mimeType: "video/mp4", size: 90_000_000, width: 3840, height: 2160 })).toBe(false)
    expect(needsDownscale({ mimeType: "audio/mpeg", size: 40_000_000, width: 0, height: 0 })).toBe(false)
  })

  it("nutzt die dokumentierten Standard-Schwellen", () => {
    expect(DOWNSCALE_MIN_BYTES).toBe(6 * 1024 * 1024)
    expect(DOWNSCALE_MAX_EDGE).toBe(4096)
  })
})

describe("computeTarget — längste Kante auf maxEdge, nie hochskalieren", () => {
  it("skaliert Querformat auf die Breite", () => {
    expect(computeTarget(6000, 3375, 4096)).toEqual({ width: 4096, height: 2304 })
  })

  it("skaliert Hochformat auf die Höhe", () => {
    expect(computeTarget(3375, 6000, 4096)).toEqual({ width: 2304, height: 4096 })
  })

  it("lässt kleine Bilder unverändert (kein Upscaling)", () => {
    expect(computeTarget(3000, 2000, 4096)).toEqual({ width: 3000, height: 2000 })
  })

  it("übersteht Null-Maße ohne Division durch Null", () => {
    expect(computeTarget(0, 0, 4096)).toEqual({ width: 0, height: 0 })
  })
})
