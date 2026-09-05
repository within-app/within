/**
 * i18n PR1 — locale persistence + startup sync decision.
 *
 * Covers the pure persistence logic behind the LocaleProvider: localStorage
 * read/write validation, the pending-sync flag, the cookie string, and the
 * device-vs-server merge rule at app start.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  buildLocaleCookie,
  decideStartupSync,
  hasPendingSync,
  markPendingSync,
  persistLocale,
  readStoredLocale,
  type KeyValueStore,
} from "@/lib/i18n/persistence"
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY } from "@/lib/i18n/config"

function makeStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe("readStoredLocale / persistLocale", () => {
  let store: KeyValueStore

  beforeEach(() => {
    store = makeStore()
  })

  it("round-trips a valid locale", () => {
    persistLocale(store, "fr")
    expect(readStoredLocale(store)).toBe("fr")
  })

  it("returns null when nothing is stored", () => {
    expect(readStoredLocale(store)).toBeNull()
  })

  it("rejects an invalid stored value instead of returning it", () => {
    store.setItem(LOCALE_STORAGE_KEY, "xx")
    expect(readStoredLocale(store)).toBeNull()
  })
})

describe("pending-sync flag", () => {
  it("sets and clears the flag", () => {
    const store = makeStore()
    expect(hasPendingSync(store)).toBe(false)
    markPendingSync(store, true)
    expect(hasPendingSync(store)).toBe(true)
    markPendingSync(store, false)
    expect(hasPendingSync(store)).toBe(false)
  })
})

describe("buildLocaleCookie", () => {
  it("carries name, value, path, one-year max-age and SameSite", () => {
    const cookie = buildLocaleCookie("en")
    expect(cookie).toContain(`${LOCALE_COOKIE}=en`)
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=31536000")
    expect(cookie).toContain("SameSite=Lax")
    // Deliberately no Secure flag — app is reachable via plain http in the LAN.
    expect(cookie).not.toContain("Secure")
  })
})

describe("decideStartupSync — device vs. server merge rule", () => {
  it("pending local change wins and is pushed to the server", () => {
    expect(decideStartupSync({ current: "fr", pending: true, server: "de" }))
      .toEqual({ locale: "fr", pushToServer: true })
  })

  it("server value wins without a pending change (cross-device inheritance)", () => {
    expect(decideStartupSync({ current: "de", pending: false, server: "en" }))
      .toEqual({ locale: "en", pushToServer: false })
  })

  it("keeps the device value when the server has none", () => {
    expect(decideStartupSync({ current: "fr", pending: false, server: null }))
      .toEqual({ locale: "fr", pushToServer: false })
  })

  it("does nothing when device and server already agree", () => {
    expect(decideStartupSync({ current: "en", pending: false, server: "en" }))
      .toEqual({ locale: "en", pushToServer: false })
  })
})
