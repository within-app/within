/**
 * Offline lässt sich ein bestehender Eintrag bearbeiten.
 *
 * Rote Ausgangslage: Der Bearbeiten-Knopf machte `router.push('/entry/<id>/edit')`.
 * Der Service Worker cached nur `['/', '/login']` vorab (public/sw.js), also
 * lieferte er offline unter dieser URL die Shell von '/' aus — Next.js hydrierte
 * die Timeline statt des Editors, und man landete wieder in der Übersicht.
 *
 * Der Editor wird deshalb inline geöffnet, genau wie es für neue Einträge schon
 * lief. Diese Tests halten beide Hälften fest: die Panel-Auswahl und die
 * Tatsache, dass keine Bearbeiten-Route vorgehalten werden muss.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { resolvePanelMode, panelTakesOverMobile } from "../src/lib/timeline/panel-mode"

const ENTRY_ID = "20000000-0000-4000-8000-000000000001"

describe("resolvePanelMode", () => {
  it("zeigt den leeren Zustand, wenn nichts ausgewählt ist", () => {
    expect(resolvePanelMode({ selectedEntryId: null, editingEntryId: null, showNewEntry: false, selectedDate: null }))
      .toBe("empty")
  })

  it("zeigt die Detailansicht bei ausgewähltem Eintrag", () => {
    expect(resolvePanelMode({ selectedEntryId: ENTRY_ID, editingEntryId: null, showNewEntry: false, selectedDate: null }))
      .toBe("detail")
  })

  it("zeigt den Editor inline, sobald ein Eintrag bearbeitet wird", () => {
    expect(resolvePanelMode({ selectedEntryId: ENTRY_ID, editingEntryId: ENTRY_ID, showNewEntry: false, selectedDate: null }))
      .toBe("edit")
  })

  it("hält den Eintrag ausgewählt, während er bearbeitet wird", () => {
    // Damit Schließen zurück in den Eintrag führt und nicht in den leeren Zustand.
    const state = { selectedEntryId: ENTRY_ID, editingEntryId: ENTRY_ID, showNewEntry: false, selectedDate: null }
    expect(resolvePanelMode(state)).toBe("edit")
    expect(resolvePanelMode({ ...state, editingEntryId: null })).toBe("detail")
  })

  it("lässt Bearbeiten vor einem offenen Neu-Eintrag gewinnen", () => {
    expect(resolvePanelMode({ selectedEntryId: null, editingEntryId: ENTRY_ID, showNewEntry: true, selectedDate: null }))
      .toBe("edit")
  })

  it("belegt auf dem Handy in jedem Nicht-Leer-Zustand den ganzen Schirm", () => {
    expect(panelTakesOverMobile({ selectedEntryId: null, editingEntryId: null, showNewEntry: false, selectedDate: null }))
      .toBe(false)
    expect(panelTakesOverMobile({ selectedEntryId: null, editingEntryId: ENTRY_ID, showNewEntry: false, selectedDate: null }))
      .toBe(true)
  })
})

describe("resolvePanelMode — Tages-Vorschau", () => {
  const DATE = "2026-09-02"

  it("zeigt die Tages-Vorschau, wenn ein Tag und kein Eintrag gewählt ist", () => {
    expect(resolvePanelMode({ selectedEntryId: null, editingEntryId: null, showNewEntry: false, selectedDate: DATE }))
      .toBe("day")
  })

  it("Einzelansicht gewinnt über den Tag — Öffnen aus der Vorschau, Zurück landet wieder im Tag", () => {
    const state = { selectedEntryId: ENTRY_ID, editingEntryId: null, showNewEntry: false, selectedDate: DATE }
    expect(resolvePanelMode(state)).toBe("detail")
    expect(resolvePanelMode({ ...state, selectedEntryId: null })).toBe("day")
  })

  it("Tag gewinnt über einen offenen Neu-Eintrag", () => {
    expect(resolvePanelMode({ selectedEntryId: null, editingEntryId: null, showNewEntry: true, selectedDate: DATE }))
      .toBe("day")
  })

  it("belegt auf dem Handy mit gewähltem Tag den ganzen Schirm", () => {
    expect(panelTakesOverMobile({ selectedEntryId: null, editingEntryId: null, showNewEntry: false, selectedDate: DATE }))
      .toBe(true)
  })
})

describe("REGRESSION: Bearbeiten ist keine Routen-Navigation mehr", () => {
  const root = join(__dirname, "..")

  it("öffnet den Editor aus der Detailansicht über onEdit statt router.push", () => {
    const source = readFileSync(
      join(root, "src/components/detail/entry-detail.tsx"),
      "utf8"
    )
    // Der Fallback auf die Route bleibt für Direktaufrufe von /entry/<id> bestehen,
    // aber der onEdit-Pfad muss davor greifen.
    expect(source).toContain("if (onEdit) onEdit(entry)")
  })

  it("reicht die Wurzelseite onEdit an die Detailansicht durch", () => {
    const source = readFileSync(join(root, "src/app/page.tsx"), "utf8")
    expect(source).toContain("onEdit={setEditingEntry}")
    expect(source).toContain("initialEntry={editingEntry}")
  })

  it("verlässt sich nicht darauf, dass /entry/<id>/edit vorgecacht wäre", () => {
    const sw = readFileSync(join(root, "public/sw.js"), "utf8")
    const match = sw.match(/NAV_PRECACHE = (\[[^\]]*\])/)
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain("edit")
  })
})
