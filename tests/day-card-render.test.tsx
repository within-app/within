/**
 * Tages-Karte: Ein Tag mit 2+ Einträgen erscheint
 * in der Timeline als EINE Karte — Datumsspalte wie die Eintragskarte, Kopf
 * „n Einträge", bis zu drei Zeilen „HH:MM · Titel" chronologisch aufsteigend,
 * danach „+ n weitere"; Thumbnail = erstes Foto des Tages mit Gesamt-Fotozahl.
 *
 * SSR-Renderprobe (Muster entry-card-selection). Synthetisch.
 */
import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { DayCard } from "@/components/timeline/entry-card"
import { buildFlatItems } from "@/lib/timeline-virtual-items"
import { formatEntryTime } from "@/lib/format"
import type { DateGroup, TimelineEntry } from "@/types/journal"

function entry(id: string, hour: string, title: string, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id, journalId: "j1", journalColor: "#007AFF",
    createdAt: `2026-06-02T${hour}:00.000Z`,
    title, previewText: `Vorschau ${id}`,
    photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [],
    ...extra,
  }
}

// Server liefert neueste zuerst — die Karte muss chronologisch aufsteigend zeigen.
const group: DateGroup = {
  date: "2026-06-02", formattedDate: "2026-06-02",
  entries: [
    entry("c", "18:30", "Abendspaziergang", { thumbnail: "/media/x/c-thumb.webp", photoCount: 2 }),
    entry("b", "12:15", "Mittag im Garten", { thumbnail: "/media/x/b-thumb.webp", photoCount: 1 }),
    entry("a", "07:05", "Morgenlauf"),
  ],
}

/** Rendert über die echte Pipeline: buildFlatItems sortiert den Tag aufsteigend. */
function render(g: DateGroup, isSelected = false) {
  const day = buildFlatItems([g]).find((i) => i.kind === "day")
  if (!day || day.kind !== "day") throw new Error("kein day-Item")
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="de">
      <DayCard group={day.group} isSelected={isSelected} onSelect={() => {}} />
    </LocaleProvider>
  )
}

describe("DayCard — eine Karte pro Tag", () => {
  it("trägt data-testid day-card, data-date und den Kopf „3 Einträge\"", () => {
    const html = render(group)
    expect(html).toContain('data-testid="day-card"')
    expect(html).toContain('data-date="2026-06-02"')
    expect(html).toContain("3 Einträge")
    expect(html).not.toContain('data-testid="entry-card"')
  })

  it("listet Zeit · Titel chronologisch aufsteigend (Morgen vor Mittag vor Abend)", () => {
    const html = render(group)
    const a = html.indexOf("Morgenlauf"), b = html.indexOf("Mittag im Garten"), c = html.indexOf("Abendspaziergang")
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    // Uhrzeit wird lokal formatiert (wie EntryCard) — deshalb über den Formatter prüfen.
    const tA = formatEntryTime("2026-06-02T07:05:00.000Z"), tB = formatEntryTime("2026-06-02T12:15:00.000Z")
    expect(html.indexOf(tA)).toBeGreaterThan(-1)
    expect(html.indexOf(tA)).toBeLessThan(html.indexOf(tB))
  })

  it("zeigt das erste Foto des Tages (chronologisch) mit der Gesamt-Fotozahl", () => {
    const html = render(group)
    expect(html).toContain("/media/x/b-thumb.webp") // Mittag ist das erste Foto des Tages
    expect(html).not.toContain("/media/x/c-thumb.webp")
    expect(html).toMatch(/>3</) // Badge: 2 + 1 Fotos
  })

  it("kappt nach drei Zeilen mit „+ n weitere\"", () => {
    const five: DateGroup = {
      ...group,
      entries: [
        entry("e", "22:00", "Fünf"), entry("d", "20:00", "Vier"),
        ...group.entries,
      ],
    }
    const html = render(five)
    expect(html).toContain("5 Einträge")
    expect(html).toContain("Morgenlauf")
    expect(html).toContain("Abendspaziergang")
    expect(html).not.toContain("Vier")
    expect(html).toContain("+ 2 weitere")
  })

  it("Datumsspalte zeigt den Tag (App-Zone, Standard UTC) und den Selektionszustand wie die Eintragskarte", () => {
    expect(render(group)).toContain(">2<")
    expect(render(group, true)).toContain("bg-primary/10")
    expect(render(group, false)).not.toContain("bg-primary/10")
  })

  it("aria-label trägt den App-Zonen-Tag der Karte, nicht das lokal formatierte createdAt", () => {
    // Fester Tag in der Vergangenheit (kein „Heute/Gestern"): Wochentag, Tag, Monat, Jahr
    expect(render(group)).toContain("2. Juni 2026 — 3 Einträge")
  })

  it("markiert ausstehende Offline-Einträge in der Zeile wie die Eintragskarte", () => {
    const g: DateGroup = { ...group, entries: [...group.entries, entry("p", "06:00", "Wartet", { pending: true })] }
    const html = render(g)
    expect(html).toContain("Ausstehend")
  })
})
