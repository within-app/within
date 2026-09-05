/**
 * i18n PR1 — dictionary integrity + German fallback.
 *
 * The dictionaries are compile-time typed against the German source (Messages),
 * so a missing key is a tsc error. These tests are the runtime safety net:
 * structure parity across languages and deep-merge fallback to German.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { de, type Messages } from "@/lib/i18n/messages/de"
import { en } from "@/lib/i18n/messages/en"
import { fr } from "@/lib/i18n/messages/fr"
import { getMessages, mergeWithFallback } from "@/lib/i18n"

/** Flattens a dictionary into "path:valueType" entries for structural comparison. */
function keyShapes(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? keyShapes(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}:${typeof value}`]
  )
}

describe("i18n dictionaries — structure parity", () => {
  it("en mirrors the exact key structure and value kinds of de", () => {
    expect(keyShapes(en)).toEqual(keyShapes(de))
  })

  it("fr mirrors the exact key structure and value kinds of de", () => {
    expect(keyShapes(fr)).toEqual(keyShapes(de))
  })
})

describe("getMessages", () => {
  it("returns each language's own strings", () => {
    expect(getMessages("de").settings.title).toBe("Einstellungen")
    expect(getMessages("en").settings.title).toBe("Settings")
    expect(getMessages("fr").settings.title).toBe("Réglages")
  })

  it("parameterised messages interpolate and pluralise", () => {
    expect(getMessages("de").settings.import.errorCount(1)).toBe("1 Fehler")
    expect(getMessages("en").settings.journals.entryCount(1)).toBe("1 entry")
    expect(getMessages("en").settings.journals.entryCount(3)).toBe("3 entries")
    expect(getMessages("fr").settings.journals.entryCount(2)).toBe("2 entrées")
  })
})

describe("mergeWithFallback — missing keys fall back to German", () => {
  it("keeps override values and fills gaps from de", () => {
    const partial = { settings: { title: "Settings" } } as unknown as Partial<Messages>
    const merged = mergeWithFallback(de, partial)

    expect(merged.settings.title).toBe("Settings")
    // Keys missing in the partial dictionary render German, never undefined:
    expect(merged.settings.import.running).toBe("Importiere…")
    expect(merged.date.today).toBe("Heute")
    expect(merged.common.cancel).toBe("Abbrechen")
    expect(merged.settings.journals.entryCount(2)).toBe("2 Einträge")
  })

  it("returns the base unchanged for an undefined override", () => {
    expect(mergeWithFallback(de, undefined)).toBe(de)
  })
})
