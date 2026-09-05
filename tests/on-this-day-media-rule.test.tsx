/**
 * „An diesem Tag": Medien-Regel plus wartende Dateien.
 *
 * Der Ansicht fehlte die Regel ganz: `OnThisDayEntry` wurde ungefiltert
 * gerendert, also zeigte sie offline auch die Server-Fotos ungepinnter
 * Einträge — Bytes, die es offline gar nicht gibt. Umgekehrt tauchte eine
 * Datei aus dem Wartekorb nirgends auf.
 *
 * SSR-Renderprobe der Liste (Muster DayDetailContent in day-detail.test.tsx),
 * damit derselbe Rückfall nicht unbemerkt bleibt. Synthetisch.
 */
import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { OnThisDayEntries } from "@/components/on-this-day/on-this-day-view"
import type { FullTimelineEntry, Media } from "@/types/journal"

const uploaded: Media = {
  id: "m1", entryId: "e1", type: "photo",
  filePath: "/media/e1/m1.jpg", thumbnailPath: "/media/e1/m1-thumb.webp", order: 0,
}
const waiting: Media = {
  id: "pending:o1", entryId: "e1", type: "photo",
  filePath: "blob:o1", order: 1, pending: true, clientMediaId: "o1",
}

function entry(media: Media[]): FullTimelineEntry {
  return {
    id: "e1", journalId: "j1", journalColor: "#007AFF",
    createdAt: "2024-06-02T07:05:00.000Z", title: "Morgenlauf", previewText: "",
    photoCount: media.length, hasAudio: false, hasVideo: false, starred: false, tags: [],
    text: "# Morgenlauf\n\nFünf Kilometer.", media,
  }
}

function render(media: Media[], online: boolean, pinnedIds: ReadonlySet<string> | null) {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="de">
      <OnThisDayEntries entries={[entry(media)]} online={online} pinnedIds={pinnedIds} />
    </LocaleProvider>
  )
}

describe("OnThisDayEntries — Medien-Regel vom 22.08.", () => {
  it("zeigt online alles", () => {
    expect(render([uploaded], true, new Set())).toContain("/media/e1/m1-thumb.webp")
  })

  it("zeigt offline + ungepinnt kein hochgeladenes Foto (die fehlende Regel)", () => {
    const html = render([uploaded], false, new Set())
    expect(html).not.toContain("/media/e1/m1-thumb.webp")
    expect(html).toContain("Fünf Kilometer.")
  })

  it("zeigt offline + gepinnt die Fotos", () => {
    expect(render([uploaded], false, new Set(["e1"]))).toContain("/media/e1/m1-thumb.webp")
  })

  it("zeigt eine wartende Datei offline auch ungepinnt, die hochgeladene nicht", () => {
    const html = render([uploaded, waiting], false, new Set())
    expect(html).toContain("blob:o1")
    expect(html).toContain("Wartet")
    expect(html).not.toContain("/media/e1/m1-thumb.webp")
  })

  it("zeigt bei noch unbekannten Pins alles — kein Aufblitzen beim Offline-Wechsel", () => {
    expect(render([uploaded], false, null)).toContain("/media/e1/m1-thumb.webp")
  })
})
