/**
 * Koordinaten ohne Ortsname (GPS-Standort, Regression-Fix):
 * Der GPS-Button speichert bewusst nur Koordinaten (kein Reverse Geocoding).
 * Die Standort-Chip-Anzeige darf dann nicht leer bleiben, sondern zeigt die
 * formatierten Koordinaten. Synthetic data only.
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { EntryMetadata, locationLabel } from "@/components/detail/entry-metadata"

const baseProps = {
  weather: undefined,
  tags: [],
  journalName: "QA-Synthetic",
  journalColor: "#6B7280",
}

describe("locationLabel", () => {
  it("prefers the place name when present", () => {
    expect(
      locationLabel({ name: "Hamburg, Deutschland", latitude: 53.55, longitude: 9.99 })
    ).toBe("Hamburg, Deutschland")
  })

  it("falls back to formatted coordinates for GPS-only locations", () => {
    expect(locationLabel({ name: null, latitude: 53.52599, longitude: 10.30889 })).toBe(
      "53.52599, 10.30889"
    )
  })

  it("returns null without location or with incomplete coordinates", () => {
    expect(locationLabel(undefined)).toBeNull()
    expect(locationLabel({ name: null, latitude: 53.52599 })).toBeNull()
    expect(locationLabel({ name: null })).toBeNull()
  })
})

describe("EntryMetadata — location chip", () => {
  it("renders the name when present", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryMetadata, {
        ...baseProps,
        location: { name: "Hamburg, Deutschland", latitude: 53.55, longitude: 9.99 },
      })
    )
    expect(html).toContain("Hamburg, Deutschland")
  })

  it("renders formatted coordinates when the name is null", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryMetadata, {
        ...baseProps,
        location: { name: null, latitude: 53.52599, longitude: 10.30889 },
      })
    )
    expect(html).toContain("53.52599, 10.30889")
  })

  it("renders no location chip without a location", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryMetadata, { ...baseProps, location: undefined })
    )
    expect(html).not.toContain("53.52599")
  })
})
