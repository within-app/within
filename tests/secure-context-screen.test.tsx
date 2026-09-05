/**
 * Vault P2 — WebCrypto existiert nur in Secure Contexts. Statt eines
 * kryptischen Fehlers beim PIN-Setup über plain HTTP zeigt die App einen
 * klaren Hinweis-Screen "HTTPS erforderlich" (Zusage 11.08.).
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { SecureContextScreen } from "@/components/secure-context-screen"

function render(locale: "de" | "en") {
  return renderToStaticMarkup(
    <LocaleProvider initialLocale={locale}>
      <SecureContextScreen />
    </LocaleProvider>
  )
}

describe("SecureContextScreen", () => {
  it("erklärt auf Deutsch, dass within HTTPS braucht", () => {
    const html = render("de")
    expect(html).toContain("HTTPS erforderlich")
    expect(html).toContain("sicheren Kontext")
  })

  it("erklärt es auf Englisch", () => {
    const html = render("en")
    expect(html).toContain("HTTPS required")
    expect(html).toContain("secure context")
  })
})

describe("AppLockProvider zeigt den Hinweis statt des Vault-Gates (Quell-Kontrakt)", () => {
  const src = readFileSync(
    join(__dirname, "../src/components/app-lock-provider.tsx"),
    "utf8"
  )

  it("prüft window.isSecureContext und rendert SecureContextScreen", () => {
    expect(src).toContain("isSecureContext")
    expect(src).toContain("SecureContextScreen")
  })

  it("lässt exempte Pfade (Login/Share) unangetastet — der Hinweis ersetzt nur das Vault-Overlay", () => {
    // Der Hinweis hängt an derselben Exempt-Logik wie das Vault-Gate:
    // /login und /share rendern keine verschlüsselten Inhalte und bleiben nutzbar.
    expect(src.indexOf("exempt ? null")).toBeGreaterThan(-1)
  })
})
