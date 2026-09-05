/**
 * i18n PR2 — a core screen (timeline empty state) renders in every UI language,
 * and without a provider it falls back to German (keeps legacy SSR tests valid).
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { EmptyState } from "@/components/timeline/empty-state"
import type { Locale } from "@/lib/i18n/config"

function renderEmptyState(locale: Locale, isFiltered = false): string {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale={locale}>
      <EmptyState isFiltered={isFiltered} onNewEntry={() => {}} />
    </LocaleProvider>
  )
}

describe("timeline empty state — full render per UI language", () => {
  it("German (default)", () => {
    const html = renderEmptyState("de")
    expect(html).toContain("Noch kein Eintrag vorhanden")
    expect(html).toContain("Ersten Eintrag schreiben")
  })

  it("English", () => {
    const html = renderEmptyState("en")
    expect(html).toContain("No entries yet")
    expect(html).toContain("Write your first entry")
  })

  it("French", () => {
    const html = renderEmptyState("fr")
    // React escapes apostrophes in static markup (' → &#x27;)
    expect(html).toContain("Aucune entrée pour l&#x27;instant")
    expect(html).toContain("Écris ta première entrée")
  })

  it("filtered variant translates too", () => {
    expect(renderEmptyState("en", true)).toContain("No entry matches these filters.")
    expect(renderEmptyState("fr", true)).toContain("Aucune entrée ne correspond à ces filtres.")
  })

  it("without a provider the component falls back to German", () => {
    const html = renderToStaticMarkup(
      <EmptyState isFiltered={false} onNewEntry={() => {}} />
    )
    expect(html).toContain("Ersten Eintrag schreiben")
  })
})
