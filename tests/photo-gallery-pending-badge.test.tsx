/**
 * PhotoGallery: Badge-Wahrheit für hängengebliebene
 * Uploads + async decoding.
 *
 * Ein Foto, dessen Upload-Versuche ausgereizt sind, wird nie wieder
 * automatisch hochgeladen (`selectFlushable` überspringt es). Das Badge muss
 * "Upload fehlgeschlagen" sagen — "Wartet" wäre eine falsche Sicherheitszusage
 * für eine Datei, die das Gerät nie verlässt.
 *
 * Static-Markup-Render (node env) — kein DOM, nur synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { PhotoGallery } from "@/components/detail/photo-gallery"
import { EntryCard } from "@/components/timeline/entry-card"
import type { Media, TimelineEntry } from "@/types/journal"

function makePendingPhoto(over: Partial<Media> = {}): Media {
  return {
    id: "pending:synth-1",
    entryId: "entry-1",
    type: "photo",
    filePath: "blob:synthetic-full",
    order: 0,
    pending: true,
    ...over,
  }
}

const SYNTH_ENTRY: TimelineEntry = {
  id: "synth-badge-entry",
  journalId: "synth-j",
  journalColor: "#007AFF",
  createdAt: "2026-07-27T09:30:00.000Z",
  title: "Synthetic entry",
  previewText: "",
  photoCount: 1,
  hasAudio: false,
  hasVideo: false,
  starred: false,
  tags: [],
  thumbnail: "/media/synth/thumb.webp",
}

describe("PhotoGallery — pending badge", () => {
  it("zeigt 'Wartet' für ein normal wartendes Foto", () => {
    const html = renderToStaticMarkup(
      React.createElement(PhotoGallery, { photos: [makePendingPhoto()] })
    )
    expect(html).toContain("Wartet")
    expect(html).not.toContain("Upload fehlgeschlagen")
  })

  it("zeigt 'Upload fehlgeschlagen' samt Ursache für ein ausgereiztes Foto", () => {
    const html = renderToStaticMarkup(
      React.createElement(PhotoGallery, {
        photos: [
          makePendingPhoto({ uploadStuck: true, uploadError: "Datei zu groß (synthetisch)" }),
        ],
      })
    )
    expect(html).toContain("Upload fehlgeschlagen")
    expect(html).toContain("Datei zu groß (synthetisch)")
    expect(html).not.toContain("Wartet")
  })

  it("zeigt kein Badge für ein hochgeladenes Foto", () => {
    const html = renderToStaticMarkup(
      React.createElement(PhotoGallery, {
        photos: [makePendingPhoto({ pending: undefined, filePath: "/media/synth/a.jpg" })],
      })
    )
    expect(html).not.toContain("Wartet")
    expect(html).not.toContain("Upload fehlgeschlagen")
  })
})

describe("decoding='async' auf den Bild-Kacheln", () => {
  it("GalleryImage dekodiert asynchron", () => {
    const html = renderToStaticMarkup(
      React.createElement(PhotoGallery, { photos: [makePendingPhoto()] })
    )
    expect(html).toContain('decoding="async"')
  })

  it("ThumbnailImage dekodiert asynchron", () => {
    const html = renderToStaticMarkup(
      React.createElement(EntryCard, { entry: SYNTH_ENTRY })
    )
    expect(html).toContain('decoding="async"')
  })
})
