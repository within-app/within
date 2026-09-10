/**
 * Error-Boundary: ein ChunkLoadError nach einem Deploy in einem offenen Tab
 * war ein weißer Bildschirm (`find src -name error.tsx` → leer). Jetzt zeigen
 * error.tsx (Segment) und global-error.tsx (Layout gefallen, eigenes
 * <html><body>) eine kurze dreisprachige Meldung mit „Neu laden".
 *
 * Die Sprache kommt ohne React-Context aus dem, was der LocaleProvider
 * persistiert (localStorage, sonst <html lang>) — der Provider selbst kann
 * Teil des gefallenen Baums sein.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ErrorPage from "@/app/error"
import GlobalError from "@/app/global-error"
import { resolveErrorLocale } from "@/components/error-fallback"

afterEach(() => vi.unstubAllGlobals())

const stubStoredLocale = (value: string | null) =>
  vi.stubGlobal("localStorage", { getItem: () => value, setItem: () => {}, removeItem: () => {} })

describe("error.tsx", () => {
  it.each([
    ["de", "Neu laden"],
    ["en", "Reload"],
    ["fr", "Recharger"],
  ])("rendert in %s", (locale, reload) => {
    stubStoredLocale(locale)
    const html = renderToStaticMarkup(<ErrorPage />)
    expect(html).toContain(reload)
    expect(html).toContain("<button")
  })

  it("ohne gespeicherte Sprache: Deutsch", () => {
    const html = renderToStaticMarkup(<ErrorPage />)
    expect(html).toContain("Neu laden")
  })
})

describe("global-error.tsx", () => {
  it("rendert eigenes <html><body> mit der Meldung", () => {
    stubStoredLocale("en")
    const html = renderToStaticMarkup(<GlobalError />)
    expect(html).toMatch(/^<html lang="en"/)
    expect(html).toContain("<body")
    expect(html).toContain("Reload")
  })
})

describe("resolveErrorLocale()", () => {
  it("localStorage vor <html lang> vor Default", () => {
    stubStoredLocale("fr")
    expect(resolveErrorLocale()).toBe("fr")
    stubStoredLocale(null)
    vi.stubGlobal("document", { documentElement: { lang: "en" } })
    expect(resolveErrorLocale()).toBe("en")
    vi.stubGlobal("document", { documentElement: { lang: "xx" } })
    expect(resolveErrorLocale()).toBe("de")
  })

  it("blockierter Storage wirft nicht", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked") } })
    expect(resolveErrorLocale()).toBe("de")
  })
})
