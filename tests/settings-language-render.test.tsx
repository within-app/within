/**
 * i18n PR1 — the settings page renders fully in each UI language.
 *
 * SSR string assertions (same pattern as empty-state-cta): one render per
 * language, asserting section titles from every card incl. the new language
 * switcher. German stays the default.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import SettingsPage from "@/app/settings/page"
import type { Locale } from "@/lib/i18n/config"

function renderSettings(locale: Locale): string {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale={locale}>
      <SettingsPage />
    </LocaleProvider>
  )
}

describe("settings page — full render per UI language", () => {
  it("German (default)", () => {
    const html = renderSettings("de")
    expect(html).toContain("Einstellungen")
    expect(html).toContain("Sprache")
    expect(html).toContain("Importieren")
    expect(html).toContain("Exportieren")
    expect(html).toContain("Neues Journal anlegen")
  })

  it("English", () => {
    const html = renderSettings("en")
    expect(html).toContain("Settings")
    expect(html).toContain("Language")
    expect(html).toContain("Start import")
    expect(html).toContain("Export all")
    expect(html).toContain("Create a new journal")
  })

  it("French", () => {
    const html = renderSettings("fr")
    expect(html).toContain("Réglages")
    expect(html).toContain("Langue")
    expect(html).toContain("Importer")
    expect(html).toContain("Tout exporter")
    expect(html).toContain("Créer un nouveau journal")
  })

  it("language picker renders as a labelled combobox", () => {
    // Radix Select options mount client-side only — SSR asserts the trigger.
    const html = renderSettings("de")
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-label="Sprache"')
  })
})
