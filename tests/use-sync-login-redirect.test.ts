/**
 * Abgelaufene Session bei erreichbarem Server: seit dem Navigations-Timeout im
 * SW (#528) hydriert die App auch dann aus der gecachten Shell, wenn der Server
 * langsam ist — die 307 nach /login kommt nie an. Ohne diese Umleitung sähe
 * der Nutzer eine eingeloggte App (IDB-Einträge), jeder Request liefert 401,
 * die Outbox syncet nie. Der Fall bestand schon für „offline → online mit
 * abgelaufener Session", das Timeout macht ihn nur wahrscheinlicher.
 *
 * Die Umleitung feuert NUR auf `authRequired` — das setzt die Engine allein
 * bei einer echten 401/403-Antwort der Probe (tests/sync-auth-gate.test.ts:
 * Netzfehler → kein authRequired) — und nur online, einmal pro Sitzung, nie im
 * Editor (/entry/…): dort hält React den Text nur im State (Autosave 30 s),
 * ein harter Reload würde ihn wegwerfen; die nächste Navigation weg vom
 * Editor läuft ohnehin in die 307 des Proxys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SyncResult } from "@/lib/sync/types"

const base: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: 0, mediaUploaded: 0, mediaFailed: 0 }

async function load() {
  vi.resetModules()
  return (await import("@/hooks/useSync")).redirectToLoginIfSessionExpired
}

beforeEach(() => vi.stubGlobal("navigator", { onLine: true }))
afterEach(() => vi.unstubAllGlobals())

describe("redirectToLoginIfSessionExpired", () => {
  it("echte 401/403-Probe (authRequired) online → einmal nach /login, nicht zweimal", async () => {
    const redirect = await load()
    const assign = vi.fn()
    expect(redirect({ ...base, authRequired: true }, "/", assign)).toBe(true)
    expect(redirect({ ...base, authRequired: true }, "/", assign)).toBe(false)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith("/login")
  })

  it("Netzfehler/Timeout (kein authRequired) → keine Umleitung", async () => {
    const redirect = await load()
    const assign = vi.fn()
    expect(redirect({ ...base, pullFailed: true }, "/", assign)).toBe(false)
    expect(assign).not.toHaveBeenCalled()
  })

  it("im Editor (/entry/…) → keine Umleitung, der Text im State bleibt; später außerhalb schon", async () => {
    const redirect = await load()
    const assign = vi.fn()
    expect(redirect({ ...base, authRequired: true }, "/entry/synthetic-1", assign)).toBe(false)
    expect(redirect({ ...base, authRequired: true }, "/entry/new", assign)).toBe(false)
    expect(assign).not.toHaveBeenCalled()
    expect(redirect({ ...base, authRequired: true }, "/", assign)).toBe(true)
  })

  it("offline → keine Umleitung, auch mit authRequired", async () => {
    vi.stubGlobal("navigator", { onLine: false })
    const redirect = await load()
    const assign = vi.fn()
    expect(redirect({ ...base, authRequired: true }, "/", assign)).toBe(false)
    expect(assign).not.toHaveBeenCalled()
  })
})
