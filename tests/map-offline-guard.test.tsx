/**
 * Offline führte der Klick auf „Karte“ zum ChunkLoadError
 * („page could not load“) — die Karte ist bewusst
 * nicht im Chunk-Warmer (online-gebunden, Pi-Kacheln, MapLibre-Boot am Handy).
 * Offline durchgestrichen und nicht anklickbar.
 *
 * SSR-Renderprobe (Muster journal-rename-render): useOnline() liest im
 * Server-Snapshot navigator.onLine mit, deshalb lässt sich der Flugmodus per
 * navigator-Stub simulieren. Dazu Source-Guards für Palette und Ansicht.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "fs"
import { resolve } from "path"
import { LocaleProvider } from "@/components/locale-provider"
import { TimelineToolbar } from "@/components/timeline/timeline-toolbar"
import { DEFAULT_FILTERS } from "@/types/journal"

function renderToolbar(onLine: boolean) {
  vi.stubGlobal("navigator", { onLine })
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="de">
      <TimelineToolbar
        viewMode="timeline"
        onViewChange={() => {}}
        hasActiveSearch={false}
        onSearchChange={() => {}}
        activeFilters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        availableTags={[]}
        journalId={null}
      />
    </LocaleProvider>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("Karte offline: durchgestrichen und gesperrt", () => {
  it("offline: Karten-Tab ist disabled, durchgestrichen, Tooltip erklärt", () => {
    const html = renderToolbar(false)
    const mapButton = html.match(/<button[^>]*title="Karte offline nicht verfügbar"[^>]*>/)?.[0]
    expect(mapButton).toBeDefined()
    expect(mapButton).toContain("disabled")
    expect(mapButton).toContain("line-through")
    // Die anderen Tabs bleiben unberührt.
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Übersicht/)
  })

  it("online: Karten-Tab normal (kein disabled, kein line-through)", () => {
    const html = renderToolbar(true)
    const mapButton = html.match(/<button[^>]*title="Karte"[^>]*>/)?.[0]
    expect(mapButton).toBeDefined()
    expect(mapButton).not.toContain("disabled")
    expect(mapButton).not.toContain("line-through")
  })

  it("Palette bietet die Karte offline nicht an; Ansicht zeigt offline den Hinweis statt des Chunks", () => {
    const palette = readFileSync(resolve(__dirname, "../src/components/command-palette.tsx"), "utf8")
    expect(palette).toMatch(/online \|\| v\.mode !== "map"/)
    const view = readFileSync(resolve(__dirname, "../src/components/timeline/timeline-view.tsx"), "utf8")
    expect(view).toMatch(/viewMode === "map" && \(online \?/)
    expect(view).toContain('data-testid="map-offline-notice"')
  })
})
