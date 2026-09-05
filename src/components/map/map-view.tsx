"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Globe2, MapPin } from "lucide-react"
import { Map as MapLibreMap, Marker as MapLibreMarker, setWorkerUrl } from "maplibre-gl"
import type { StyleSpecification, GeoJSONSource, FilterSpecification } from "maplibre-gl"
import type { FeatureCollection } from "geojson"
import type { Topology, GeometryObject as TopoGeometryObject } from "topojson-specification"
import { feature, mesh } from "topojson-client"
import "maplibre-gl/dist/maplibre-gl.css"
import { formatEntryDate } from "@/lib/format"
import { useI18n } from "@/components/locale-provider"
import type { MapMarker } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { idbToMapMarkers } from "@/lib/sync/idb-to-views"
import {
  MAP_MIN_ZOOM,
  MAP_MAX_ZOOM,
  DETAIL_SWITCH_ZOOM,
  DETAIL_LAYERS_ZOOM,
  unwrapAntimeridian,
  cssVarToHsl,
  type City,
} from "./map-detail"
import citiesJson from "./cities.json"

// The MapLibre web worker must load from a same-origin URL (CSP: worker-src
// 'self', no blob:). scripts/copy-map-worker.mjs places the worker pair in
// public/map/ on every build.
setWorkerUrl("/map/maplibre-gl-worker.mjs")

// Bundled TopoJSON (world-atlas, Natural Earth, public domain) — no network
// request needed (100 % offline). 50m base loads with the map chunk; the 10m
// detail level and the admin-1/lakes/rivers chunk are separate lazy chunks
// fetched on first deep zoom (then service-worker-cached for offline use).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const world50m = require("world-atlas/countries-50m.json") as unknown as Topology

const CITIES = citiesJson as City[]

const citiesFC: FeatureCollection = {
  type: "FeatureCollection",
  features: CITIES.map(([name, lng, lat, mz]) => ({
    type: "Feature",
    properties: { name, mz },
    geometry: { type: "Point", coordinates: [lng, lat] },
  })),
}

// Reveal filter: Natural Earth min_zoom levels align with mercator zoom.
const REVEAL_FILTER: FilterSpecification = ["<=", ["get", "mz"], ["zoom"]]

interface MapColors {
  water: string
  land: string
  boundary: string
  cityDot: string
  label: string
  halo: string
}

function readMapColors(): MapColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cssVarToHsl(cs.getPropertyValue(name))
  return {
    water: v("--map-water"),
    land: v("--map-land"),
    boundary: v("--map-boundary"),
    cityDot: v("--map-city-dot"),
    label: v("--map-label"),
    halo: v("--map-label-halo"),
  }
}

function buildStyle(colors: MapColors): StyleSpecification {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] }
  return {
    version: 8,
    glyphs: "/map/font/{fontstack}/{range}.pbf",
    sources: {
      countries: { type: "geojson", data: empty },
      boundaries: { type: "geojson", data: empty },
      admin1: { type: "geojson", data: empty },
      lakes: { type: "geojson", data: empty },
      rivers: { type: "geojson", data: empty },
      cities: { type: "geojson", data: citiesFC },
    },
    layers: [
      { id: "water", type: "background", paint: { "background-color": colors.water } },
      { id: "land", type: "fill", source: "countries", paint: { "fill-color": colors.land } },
      {
        id: "lakes",
        type: "fill",
        source: "lakes",
        filter: REVEAL_FILTER,
        paint: { "fill-color": colors.water },
      },
      {
        id: "rivers",
        type: "line",
        source: "rivers",
        minzoom: 4,
        filter: REVEAL_FILTER,
        paint: {
          "line-color": colors.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 10, 1.6],
        },
      },
      {
        id: "admin1",
        type: "line",
        source: "admin1",
        minzoom: 4,
        paint: {
          "line-color": colors.boundary,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 8, 1.3],
          "line-dasharray": [2, 2],
          "line-opacity": 0.85,
        },
      },
      {
        id: "boundaries",
        type: "line",
        source: "boundaries",
        paint: {
          "line-color": colors.boundary,
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1.1, 10, 1.6],
        },
      },
      {
        id: "city-dots",
        type: "circle",
        source: "cities",
        minzoom: 3,
        filter: REVEAL_FILTER,
        paint: {
          "circle-color": colors.cityDot,
          "circle-radius": 2.2,
          "circle-stroke-color": colors.halo,
          "circle-stroke-width": 0.8,
        },
      },
      {
        id: "city-labels",
        type: "symbol",
        source: "cities",
        filter: REVEAL_FILTER,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10.5, 10, 14],
          "text-offset": [0, 0.7],
          "text-anchor": "top",
          "symbol-sort-key": ["get", "mz"],
        },
        paint: {
          "text-color": colors.label,
          "text-halo-color": colors.halo,
          "text-halo-width": 1.2,
        },
      },
    ],
  }
}

// Paint properties to re-apply when the theme (light/dark) changes.
function applyColors(map: MapLibreMap, colors: MapColors) {
  map.setPaintProperty("water", "background-color", colors.water)
  map.setPaintProperty("land", "fill-color", colors.land)
  map.setPaintProperty("lakes", "fill-color", colors.water)
  map.setPaintProperty("rivers", "line-color", colors.water)
  map.setPaintProperty("admin1", "line-color", colors.boundary)
  map.setPaintProperty("boundaries", "line-color", colors.boundary)
  map.setPaintProperty("city-dots", "circle-color", colors.cityDot)
  map.setPaintProperty("city-dots", "circle-stroke-color", colors.halo)
  map.setPaintProperty("city-labels", "text-color", colors.label)
  map.setPaintProperty("city-labels", "text-halo-color", colors.halo)
}

interface MapViewProps {
  journalId: string | null
  selectedEntryId: string | null
  onEntrySelect: (id: string) => void
}

interface TooltipState {
  marker: MapMarker
  x: number
  y: number
}

export function MapView({ journalId, selectedEntryId, onEntrySelect }: MapViewProps) {
  const { messages, locale } = useI18n()
  const [markers, setMarkers] = useState<MapMarker[]>([])
  const [loading, setLoading] = useState(true)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerElsRef = useRef(new globalThis.Map<string, HTMLDivElement>())
  const mapMarkersRef = useRef<MapLibreMarker[]>([])
  const onEntrySelectRef = useRef(onEntrySelect)
  onEntrySelectRef.current = onEntrySelect

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (journalId) params.set("journalId", journalId)
    fetch(`/api/locations?${params}`)
      .then((r) => r.json())
      .then((data: { markers: MapMarker[] }) => {
        if (cancelled) return
        setMarkers(data.markers ?? [])
        setLoading(false)
      })
      .catch(async () => {
        // Network failed — derive markers from IndexedDB
        try {
          const idbEntries = await realIDBAdapter.getAllEntries()
          if (!cancelled) setMarkers(idbToMapMarkers(idbEntries, journalId))
        } catch {
          // IDB also unavailable — render empty map
        }
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [journalId])

  const showMap = !loading && markers.length > 0

  // Map lifecycle — one instance per mounted container.
  useEffect(() => {
    if (!showMap || !containerRef.current || mapRef.current) return

    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(readMapColors()),
      center: [10, 30],
      zoom: 1.2,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false,
    })
    mapRef.current = map

    const setSourceData = (id: string, data: GeoJSON.GeoJSON) =>
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(data)

    map.on("load", () => {
      const countriesObj = world50m.objects.countries as TopoGeometryObject
      setSourceData(
        "countries",
        unwrapAntimeridian(feature(world50m, countriesObj) as unknown as FeatureCollection)
      )
      setSourceData("boundaries", unwrapAntimeridian(mesh(world50m, countriesObj)))
    })

    // Lazy detail levels: 10m countries + the admin-1/lakes/rivers chunk.
    // Offline before either was ever cached → keep the current level.
    let detail10mRequested = false
    let layersRequested = false
    const maybeLoadDetail = () => {
      const zoom = map.getZoom()
      if (!layersRequested && zoom >= DETAIL_LAYERS_ZOOM) {
        layersRequested = true
        import("./layers-50m.json")
          .then((m) => {
            setSourceData("admin1", unwrapAntimeridian(m.default.admin1 as FeatureCollection))
            setSourceData("lakes", unwrapAntimeridian(m.default.lakes as FeatureCollection))
            setSourceData("rivers", unwrapAntimeridian(m.default.rivers as FeatureCollection))
          })
          .catch(() => { layersRequested = false })
      }
      if (!detail10mRequested && zoom >= DETAIL_SWITCH_ZOOM) {
        detail10mRequested = true
        import("world-atlas/countries-10m.json")
          .then((m) => {
            const topo = m.default as unknown as Topology
            const obj = topo.objects.countries as TopoGeometryObject
            setSourceData(
              "countries",
              unwrapAntimeridian(feature(topo, obj) as unknown as FeatureCollection)
            )
            setSourceData("boundaries", unwrapAntimeridian(mesh(topo, obj)))
          })
          .catch(() => { detail10mRequested = false })
      }
    }
    map.on("zoomend", maybeLoadDetail)
    maybeLoadDetail()

    // Theme switch (next-themes toggles the `dark` class) → re-apply palette.
    const themeObserver = new MutationObserver(() => {
      if (map.isStyleLoaded()) applyColors(map, readMapColors())
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    const markerEls = markerElsRef.current // stable Map instance, only mutated
    return () => {
      themeObserver.disconnect()
      mapMarkersRef.current = []
      markerEls.clear()
      mapRef.current = null
      map.remove()
    }
  }, [showMap])

  // Journal markers as DOM elements on the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const m of mapMarkersRef.current) m.remove()
    mapMarkersRef.current = []
    markerElsRef.current.clear()

    for (const m of markers) {
      const el = document.createElement("div")
      el.className = "map-marker"
      el.style.backgroundColor = m.journalColor
      el.style.color = m.journalColor // selection ring (::after) uses currentColor
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        onEntrySelectRef.current(m.id)
      })
      el.addEventListener("mouseenter", (e) => setTooltip({ marker: m, x: e.clientX, y: e.clientY }))
      el.addEventListener("mousemove", (e) =>
        setTooltip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : null))
      )
      el.addEventListener("mouseleave", () => setTooltip(null))
      markerElsRef.current.set(m.id, el)
      mapMarkersRef.current.push(new MapLibreMarker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map))
    }
  }, [markers, showMap])

  // Selection highlight without recreating markers.
  useEffect(() => {
    for (const [id, el] of markerElsRef.current) {
      el.classList.toggle("selected", id === selectedEntryId)
    }
  }, [selectedEntryId, markers])

  const handleTooltipClose = useCallback(() => setTooltip(null), [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="h-7 w-7 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
      </div>
    )
  }

  if (markers.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6 bg-background">
        <Globe2 className="h-10 w-10 text-muted-foreground/20" strokeWidth={1.25} />
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-foreground/60">
            {messages.map.noLocationsTitle}
          </p>
          <p className="text-[12px] text-muted-foreground/50 max-w-[220px] leading-snug">
            {messages.map.noLocationsSubtitle}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden bg-background" onMouseLeave={handleTooltipClose}>
      {/* MapLibre owns this node — React must never reconcile its children.
          h-full statt absolute: maplibre-gl.css erzwingt position:relative auf
          .maplibregl-map und würde inset-0 aushebeln (Höhe kollabiert auf 0). */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Marker count badge — iOS pill style */}
      <div className="absolute bottom-3 left-3 z-10 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70 bg-background/75 backdrop-blur-md rounded-full px-2.5 py-1 border border-border/30 shadow-xs">
        <MapPin className="h-[10px] w-[10px] shrink-0 text-muted-foreground/40" />
        {messages.map.locationCount(markers.length)}
      </div>

      {/* Tooltip — iOS card */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: tooltip.x + 14, top: tooltip.y - 44 }}
        >
          <div className="bg-popover/95 text-popover-foreground rounded-xl shadow-md border border-border/40 backdrop-blur-sm px-3 py-2 text-xs max-w-[200px]">
            <p className="font-semibold leading-snug truncate text-[12px]">{tooltip.marker.title}</p>
            <p className="text-muted-foreground mt-0.5 text-[11px]">
              {formatEntryDate(tooltip.marker.createdAt, locale)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
