/**
 * Tabwechsel warf die Timeline weg: `viewMode` stand in den Deps des
 * Reset-Effekts — Kalender öffnen → Daten leer, zurück → Skeleton, neuer
 * /api/entries-Request, Sprung nach oben. Zielbild seit #528:
 *  - Reset (Daten leeren) nur bei Journal/Filter/Suche/refreshNonce, nie bei
 *    viewMode; der Reset setzt kein `loading` mehr, das tut nur der Lade-Effekt.
 *  - Der Lade-Effekt hängt an viewMode und lädt NUR sichtbar: Rückkehr zur
 *    Timeline revalidiert Seite 1 (ein Request), die alten Karten bleiben bis
 *    dahin stehen (kein Skeleton) — außer ein Reset wartet (resetPendingRef),
 *    dann Skeleton wie bei jedem Filterwechsel.
 *
 * Kein DOM-Renderer im Repo (Umgebung node, kein jsdom/happy-dom), deshalb
 * Source-Guard wie tests/map-offline-guard.test.tsx — gezielte Regexe, keine
 * vollständigen Dep-Arrays.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

const src = readFileSync(resolve(__dirname, "../src/components/timeline/timeline-view.tsx"), "utf8")

/** Body + Dep-Array des Effekts, dessen Body `marker` enthält. */
function effect(marker: string): { body: string; deps: string } {
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\)/g
  for (const m of src.matchAll(re)) if (m[1].includes(marker)) return { body: m[1], deps: m[2] }
  throw new Error(`kein Effekt mit ${marker}`)
}

describe("Timeline behält Daten beim Tabwechsel", () => {
  it("Reset-Effekt: nicht an viewMode, setzt kein loading, merkt den Reset vor", () => {
    const reset = effect("setAllDateGroups([])")
    expect(reset.deps).not.toMatch(/\bviewMode\b/)
    expect(reset.deps).toMatch(/\brefreshNonce\b/)
    expect(reset.body).not.toContain("setLoading")
    expect(reset.body).toContain("resetPendingRef.current = true")
  })

  it("Lade-Effekt: an viewMode, lädt nur sichtbar, Skeleton nur nach einem Reset", () => {
    const load = effect("/api/entries?")
    expect(load.deps).toMatch(/\bviewMode\b/)
    expect(load.body).toMatch(/^\s*if \(viewMode !== "timeline"\) return$/m)
    expect(load.body).toContain("const fresh = resetPendingRef.current")
    expect(load.body).not.toMatch(/^\s*(if \(page === 1\) )?setLoading\(true\)$/m)
  })

  it("Verlassen der Timeline spult auf Seite 1 zurück (Rückkehr = genau ein Seite-1-Request)", () => {
    expect(src).toMatch(/if \(viewMode !== "timeline"\) setPage\(1\)/)
  })
})
