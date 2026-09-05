/**
 * Journal-Rename + Import-Namensfeld — UI-Strings in allen drei Sprachen.
 *
 * SSR-Renderproben (Muster settings-language-render): der Bearbeiten-Button
 * pro Journal-Zeile und das Import-Namensfeld rendern lokalisiert. Die
 * Dialog-Strings (Radix-Portal, rendert nicht per SSR) werden direkt am
 * typisierten Dictionary geprüft.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import SettingsPage, { JournalSection } from "@/app/settings/page"
import { getMessages } from "@/lib/i18n"
import { LOCALES, type Locale } from "@/lib/i18n/config"
import type { Journal } from "@/types/journal"

const SYNTH_JOURNAL: Journal = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  name: "Synth Journal",
  color: "#007AFF",
  entryCount: 2,
}

function renderJournalSection(locale: Locale): string {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale={locale}>
      <JournalSection journals={[SYNTH_JOURNAL]} onRefresh={() => {}} />
    </LocaleProvider>
  )
}

function renderSettings(locale: Locale): string {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale={locale}>
      <SettingsPage />
    </LocaleProvider>
  )
}

describe("journal row — edit affordance per UI language", () => {
  it("German", () => {
    const html = renderJournalSection("de")
    expect(html).toContain('aria-label="Journal „Synth Journal“ bearbeiten"')
  })

  it("English", () => {
    const html = renderJournalSection("en")
    expect(html).toContain('aria-label="Edit journal “Synth Journal”"')
  })

  it("French", () => {
    const html = renderJournalSection("fr")
    expect(html).toContain('aria-label="Modifier le journal « Synth Journal »"')
  })
})

describe("import section — journal name field per UI language", () => {
  it("German", () => {
    const html = renderSettings("de")
    expect(html).toContain("Name des neuen Journals")
    expect(html).toContain('placeholder="DayOne Import"')
  })

  it("English", () => {
    const html = renderSettings("en")
    expect(html).toContain("Name of the new journal")
  })

  it("French", () => {
    const html = renderSettings("fr")
    expect(html).toContain("Nom du nouveau journal")
  })
})

describe("edit dialog strings exist in every locale (portal renders client-side only)", () => {
  it("has non-empty dialog strings in de/en/fr", () => {
    for (const locale of LOCALES) {
      const j = getMessages(locale).settings.journals
      for (const s of [j.editTitle, j.save, j.saving, j.editFailed]) {
        expect(s, `${locale} dialog string`).toBeTruthy()
      }
    }
  })
})
