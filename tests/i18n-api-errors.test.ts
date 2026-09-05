/**
 * i18n PR3 — apiErrorText: stable API codes render in the active UI language,
 * unknown codes fall back to the German server text, parameterised codes
 * interpolate their payload fields.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect } from "vitest"
import { apiErrorText } from "@/lib/i18n/api-errors"
import { getMessages } from "@/lib/i18n"

const de = getMessages("de")
const en = getMessages("en")
const fr = getMessages("fr")

describe("apiErrorText — known codes translate", () => {
  it("renders entry_not_found per language", () => {
    const body = { error: "Eintrag nicht gefunden", code: "entry_not_found" }
    expect(apiErrorText(de, body, "x")).toBe("Eintrag nicht gefunden")
    expect(apiErrorText(en, body, "x")).toBe("Entry not found")
    expect(apiErrorText(fr, body, "x")).toBe("Entrée introuvable")
  })

  it("German dictionary text equals the server text (no visible change on de)", () => {
    const body = { error: "Falsches Passwort", code: "wrong_password" }
    expect(apiErrorText(de, body, "x")).toBe(body.error)
  })
})

describe("apiErrorText — parameterised codes", () => {
  it("file_too_large interpolates maxMB and kind", () => {
    const body = { error: "Datei zu groß (max. 100 MB für Videos)", code: "file_too_large", maxMB: 100, kind: "video" }
    expect(apiErrorText(de, body, "x")).toBe("Datei zu groß (max. 100 MB für Videos)")
    expect(apiErrorText(en, body, "x")).toBe("File too large (max. 100 MB for videos)")
  })

  it("rate_limited_login interpolates retryAfter", () => {
    const body = { error: "Zu viele Versuche, bitte warte 42 Sekunden", code: "rate_limited_login", retryAfter: 42 }
    expect(apiErrorText(de, body, "x")).toBe(body.error)
    expect(apiErrorText(fr, body, "x")).toBe("Trop de tentatives, attends 42 secondes")
  })
})

describe("apiErrorText — fallbacks", () => {
  it("unknown code falls back to the server-provided German text", () => {
    const body = { error: "ZIP-Inhalt zu groß unkomprimiert (max. 200 MB)", code: "import_zip_too_large" }
    expect(apiErrorText(en, body, "x")).toBe(body.error)
  })

  it("missing code falls back to server text, missing body to the caller fallback", () => {
    expect(apiErrorText(en, { error: "Irgendwas" }, "fallback")).toBe("Irgendwas")
    expect(apiErrorText(en, null, "fallback")).toBe("fallback")
    expect(apiErrorText(en, {}, "fallback")).toBe("fallback")
  })
})
