/**
 * Login-Redirect + Cookie-Härtung.
 *
 * Der from-Redirect-Guard (startsWith("/") && !startsWith("//")) ist per
 * Backslash umgehbar: "/\evil.com" passiert, die WHATWG-URL-Auflösung macht
 * daraus https://evil.com/ — Phishing-Redirect nach erfolgreichem Login
 * (relevant bei Internet-Exposition durch fremde Self-Hoster).
 *
 * SECURE_COOKIES (default false) und TRUSTED_PROXY_COUNT waren komplett
 * entkoppelt — wer die App hinter einem HTTPS-Proxy ins Internet stellt und
 * nur TRUSTED_PROXY_COUNT setzt, verschickte das Auth-Cookie weiterhin ohne
 * Secure-Flag. Hinter einem Proxy ist HTTPS die Betriebsannahme → Secure an.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { isSafeInternalRedirect } from "@/lib/redirect-rules"

describe("isSafeInternalRedirect", () => {
  it("erlaubt normale interne Pfade", () => {
    expect(isSafeInternalRedirect("/")).toBe(true)
    expect(isSafeInternalRedirect("/entry/abc")).toBe(true)
    expect(isSafeInternalRedirect("/calendar?x=1")).toBe(true)
  })

  it("blockt protokoll-relative und Backslash-Varianten", () => {
    expect(isSafeInternalRedirect("//evil.example")).toBe(false)
    expect(isSafeInternalRedirect("/\\evil.example")).toBe(false)
    expect(isSafeInternalRedirect("\\/evil.example")).toBe(false)
    expect(isSafeInternalRedirect("/\\/evil.example")).toBe(false)
    expect(isSafeInternalRedirect("https://evil.example")).toBe(false)
    expect(isSafeInternalRedirect("")).toBe(false)
  })

  it("login-form nutzt den Guard (kein handgestrickter startsWith-Check mehr)", async () => {
    const { readFileSync } = await import("fs")
    const { join } = await import("path")
    const src = readFileSync(join(__dirname, "../src/app/login/login-form.tsx"), "utf8")
    expect(src).toContain("isSafeInternalRedirect")
  })
})

describe("Secure-Cookie-Kopplung", () => {
  const OLD_ENV = { ...process.env }
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  async function loadOptions() {
    const mod = await import("@/lib/session")
    return mod.sessionOptions
  }

  it("SECURE_COOKIES=true erzwingt Secure (wie bisher)", async () => {
    process.env.SECURE_COOKIES = "true"
    delete process.env.TRUSTED_PROXY_COUNT
    expect((await loadOptions()).cookieOptions?.secure).toBe(true)
  })

  it("TRUSTED_PROXY_COUNT>0 erzwingt Secure ebenfalls (Proxy = HTTPS-Betriebsannahme)", async () => {
    delete process.env.SECURE_COOKIES
    process.env.TRUSTED_PROXY_COUNT = "1"
    expect((await loadOptions()).cookieOptions?.secure).toBe(true)
  })

  it("LAN-Default bleibt: ohne beide Flags kein Secure (HTTP :4000 Health-Check)", async () => {
    delete process.env.SECURE_COOKIES
    delete process.env.TRUSTED_PROXY_COUNT
    expect((await loadOptions()).cookieOptions?.secure).toBe(false)
  })
})
