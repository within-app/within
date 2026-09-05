/**
 * Warte-Kennzeichnung auf der Kachel der Medien-Übersicht.
 *
 * Ohne Kennzeichen ist eine lokale Vorschau nicht von einem hochgeladenen Foto
 * zu unterscheiden, und man sieht der Übersicht nicht an, was schon auf dem
 * Server liegt. Eine ausgereizte Datei geht NIE mehr hoch — sie muss
 * „fehlgeschlagen" sagen, nicht „wartet".
 *
 * SSR-Renderprobe (Muster day-card-render). Synthetisch.
 */
import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { PhotoTile } from "@/components/media/media-grid-view"
import type { MediaItem } from "@/types/journal"

function tile(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "srv-1",
    entryId: "entry-1",
    type: "photo",
    filePath: "/media/j/srv-1.jpg",
    createdAt: "2026-09-04T10:00:00.000Z",
    journalColor: "#007AFF",
    ...over,
  }
}

function render(item: MediaItem) {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="de">
      <PhotoTile item={item} onClick={() => {}} />
    </LocaleProvider>
  )
}

describe("PhotoTile — wartende Medien", () => {
  it("kennzeichnet eine hochgeladene Kachel nicht", () => {
    const html = render(tile())
    expect(html).not.toContain("Wartet")
    expect(html).not.toContain("Upload fehlgeschlagen")
  })

  it("zeigt das Warte-Kennzeichen auf einer Kachel aus dem Wartekorb", () => {
    const html = render(
      tile({ id: "pending:o1", filePath: "blob:local-1", pending: true, journalColor: "" })
    )
    expect(html).toContain("Wartet")
    // Der Screenreader liest das aria-label des Buttons, nicht den Badge-Text.
    expect(html).toMatch(/aria-label="[^"]*Wartet[^"]*"/)
  })

  it("sagt bei ausgereizten Versuchen fehlgeschlagen statt wartet", () => {
    const html = render(
      tile({
        id: "pending:o1",
        filePath: "blob:local-1",
        pending: true,
        uploadStuck: true,
        uploadError: "415 unsupported",
        journalColor: "",
      })
    )
    expect(html).toContain("Upload fehlgeschlagen")
    expect(html).not.toContain(">Wartet<")
  })
})
