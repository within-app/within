/**
 * PDF-Anhänge in der Oberfläche (2026-10-30).
 *
 * Detailansicht: eine Zeile pro PDF mit Symbol, Anzeigename, Größe, „Öffnen"
 * (neuer Tab, noopener — der Browser rendert das PDF in seinem eigenen Viewer)
 * und „Herunterladen" (download-Attribut mit dem Originalnamen).
 * Medien-Übersicht: eine Kachel wie bei Audio, mit PDF-Label und Name.
 *
 * Statisches Rendering wie die übrigen Komponententests (react-dom/server,
 * Default-Locale des LocaleProviders). Synthetic data only.
 */
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { PdfAttachment, ensurePdfExtension } from "@/components/detail/pdf-attachment"
import { PdfTile } from "@/components/media/media-grid-view"
import type { Media, MediaItem } from "@/types/journal"

const PDF_PATH = "/media/cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-cccc-4ccc-8ccc-cccccccccccc-original.pdf"

function makePdf(overrides: Partial<Media> = {}): Media {
  return {
    id: "m-pdf-1",
    entryId: "entry-1",
    type: "pdf",
    filePath: PDF_PATH,
    order: 0,
    originalName: "Synth Vertrag.pdf",
    sizeBytes: 819175,
    ...overrides,
  }
}

describe("PdfAttachment (Detailansicht)", () => {
  it("zeigt Name und Größe und verlinkt Öffnen (neuer Tab, noopener) und Herunterladen (download=Name)", () => {
    const html = renderToStaticMarkup(React.createElement(PdfAttachment, { media: makePdf() }))
    expect(html).toContain("Synth Vertrag.pdf")
    expect(html).toContain("800 KB")
    // Öffnen: derselbe Pfad wie die Medien-Route, neuer Tab ohne Opener-Bezug
    expect(html).toMatch(new RegExp(`<a[^>]*href="${PDF_PATH}"[^>]*target="_blank"[^>]*rel="noopener[^"]*"`))
    // Herunterladen: download-Attribut trägt den Anzeigenamen
    expect(html).toMatch(new RegExp(`<a[^>]*href="${PDF_PATH}"[^>]*download="Synth Vertrag.pdf"`))
  })

  it("ohne Anzeigename: Fallback PDF und download ohne erfundenen Namen", () => {
    const html = renderToStaticMarkup(
      React.createElement(PdfAttachment, { media: makePdf({ originalName: null, sizeBytes: null }) })
    )
    expect(html).toContain("PDF")
    expect(html).not.toContain("Synth Vertrag.pdf")
    expect(html).toMatch(/<a[^>]*download(="")?[\s>]/)
    expect(html).not.toContain("KB")
  })

  it("Day-One-Name ohne Endung: Anzeige unverändert, Download bekommt .pdf", () => {
    const html = renderToStaticMarkup(
      React.createElement(PdfAttachment, { media: makePdf({ originalName: "20240101_Scan" }) })
    )
    expect(html).toContain(">20240101_Scan<")
    expect(html).toMatch(/download="20240101_Scan\.pdf"/)
    expect(ensurePdfExtension("Vertrag.PDF")).toBe("Vertrag.PDF")
    expect(ensurePdfExtension("Vertrag")).toBe("Vertrag.pdf")
  })

  it("rendert den Anzeigenamen als Text, nie als Markup", () => {
    const html = renderToStaticMarkup(
      React.createElement(PdfAttachment, { media: makePdf({ originalName: "<img src=x onerror=alert(1)>.pdf" }) })
    )
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x")
  })
})

describe("PdfTile (Medien-Übersicht)", () => {
  const item: MediaItem = {
    id: "m-pdf-1",
    entryId: "entry-1",
    type: "pdf",
    filePath: PDF_PATH,
    originalName: "Synth Vertrag.pdf",
    sizeBytes: 819175,
    createdAt: "2024-09-01T10:00:00.000Z",
    journalColor: "#336699",
  }

  it("zeigt PDF-Label, Anzeigename und die Journalfarbe; Klick ist ein Button (öffnet den Eintrag)", () => {
    const html = renderToStaticMarkup(React.createElement(PdfTile, { item, onClick: () => {} }))
    expect(html).toContain("PDF")
    expect(html).toContain("Synth Vertrag.pdf")
    expect(html).toContain("#336699")
    expect(html).toMatch(/<button[^>]*aria-label="[^"]*PDF Synth Vertrag\.pdf[^"]*"/)
  })
})
