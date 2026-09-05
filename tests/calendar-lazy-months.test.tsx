/**
 * Kalender-Tipp am Handy: Die Kalenderansicht mountete bei jedem Tipp 24
 * react-day-picker-Monate auf einmal (779 Tages-Buttons, ~3000 DOM-Knoten) —
 * gemessen 600–900 ms Blockade bei 4× CPU-Drosselung gegen 45–100 ms für
 * Medien. Deshalb: Startfenster 3 Monate, weitere Monate laden per Sentinel
 * beim Scrollen nach (Muster Medien-Grid).
 *
 * SSR-Renderprobe (Muster map-offline-guard): der Erst-Render trägt genau
 * INITIAL_MONTHS Monatsraster und den Nachlade-Sentinel; die Fensterlogik ist
 * eine pure Funktion mit Deckel bei der bisherigen Obergrenze.
 *
 * Hinweis: der Voll-Lauf wurde durch die Anwesenheit dieser Probe unter
 * Parallel-Last rot (Routen-Tests mit Import-im-Testkörper an der
 * 5-s-Timeout-Kante).
 *
 * Synthetisch — kein Netz, keine DB.
 */
import { describe, it, expect } from "vitest"
import React from "react"
// Kein Datei-lokales Stubben von @/lib/sync/idb — das Barrel-Prebundling in
// vitest.config.ts (deps.optimizer.ssr) hält den Import dieser SSR-Probe
// günstig, ganz ohne Mocks.
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import {
  CalendarView,
  INITIAL_MONTHS,
  MAX_MONTHS,
  nextMonthCount,
} from "@/components/calendar/calendar-view"

function renderCalendar(): string {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="de">
      <CalendarView journalId={null} selectedDate={null} onDaySelect={() => {}} />
    </LocaleProvider>
  )
}

describe("Kalender: Lazy Monatsfenster", () => {
  it("Erst-Render zeigt genau INITIAL_MONTHS (3) Monatsraster, nicht 24", () => {
    const html = renderCalendar()
    const grids = (html.match(/role="grid"/g) ?? []).length
    expect(INITIAL_MONTHS).toBe(3)
    expect(grids).toBe(INITIAL_MONTHS)
  })

  it("Nachlade-Sentinel ist ein fokussierbarer Button mit deutschem Label, solange das Fenster unter der Obergrenze liegt", () => {
    const html = renderCalendar()
    expect(html).toMatch(/<button[^>]*data-testid="calendar-month-sentinel"/)
    expect(html).toContain("Frühere Monate")
  })

  it("nextMonthCount wächst in Dreierschritten und deckelt bei MAX_MONTHS (24)", () => {
    expect(MAX_MONTHS).toBe(24)
    expect(nextMonthCount(3)).toBe(6)
    expect(nextMonthCount(6)).toBe(9)
    expect(nextMonthCount(22)).toBe(24)
    expect(nextMonthCount(24)).toBe(24)
  })

  it("hideNavigation lässt kein <nav>-Element ins Markup", () => {
    const html = renderCalendar()
    expect(html).not.toContain("<nav")
  })
})

// Review-Fund: der Sentinel-Knopf unmountete bei MAX_MONTHS (Fokus fiel auf
// body). Der SSR-Erst-Render erreicht MAX_MONTHS nie (das bräuchte 7 echte
// setMonthCount-Schritte) — deshalb eine Quelltext-Probe statt einer
// Render-Probe.
describe("Sentinel bleibt bei MAX_MONTHS gemountet (Quelltext-Probe)", () => {
  it("der Knopf ist nicht mehr hinter monthCount < MAX_MONTHS bedingt gerendert, sondern trägt disabled={monthCount >= MAX_MONTHS}", async () => {
    const { readFileSync } = await import("fs")
    const { resolve } = await import("path")
    const source = readFileSync(
      resolve(__dirname, "../src/components/calendar/calendar-view.tsx"),
      "utf8"
    )
    expect(source).not.toContain("{monthCount < MAX_MONTHS &&")
    expect(source).toContain("disabled={monthCount >= MAX_MONTHS}")
  })
})
