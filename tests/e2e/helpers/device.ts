import { chromium, expect, type BrowserContext, type Page } from "@playwright/test"

/**
 * Gemeinsamer Helfer für Specs mit einem persistenten Browser-Profil
 * (`chromium.launchPersistentContext`) — Muster ursprünglich aus
 * offline-views.spec.ts, vorher mehrfach kopiert in offline-create-sync-acr1,
 * offline-media-and-edit, offline-media-preview.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4000"
const PASSWORD = process.env.E2E_PASSWORD ?? "localtest"

export const LAUNCH_ARGS = [
  "--disable-features=HttpsUpgrades,AutoupgradeMixedContent",
  `--unsafely-treat-insecure-origin-as-secure=${BASE_URL}`,
  "--disable-dev-shm-usage",
]

/**
 * Persistenter Context mit navigator.onLine-Stub + API-Login.
 *
 * Der Stub ist nötig, weil `context.setOffline()` bei einem persistenten
 * Context zwar Netzwerk-Requests blockt, aber `navigator.onLine` in Chromium
 * NICHT zuverlässig auf `false` dreht — Produktcode, der auf `navigator.onLine`
 * statt auf fehlgeschlagene Requests verzweigt, würde sonst weiter den
 * Online-Pfad nehmen. `__setForceOffline` überschreibt `Navigator.prototype.onLine`
 * und feuert das passende `online`/`offline`-Event; `setDeviceOffline` unten
 * hält beides synchron.
 */
export async function launchDevice(profileDir: string): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: LAUNCH_ARGS,
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
  })
  await ctx.addInitScript(() => {
    let forced = false
    try { forced = localStorage.getItem("__e2e_force_offline") === "1" } catch { /* origin-los */ }
    try {
      Object.defineProperty(Navigator.prototype, "onLine", {
        configurable: true,
        get: () => !forced,
      })
    } catch { /* bereits definiert */ }
    ;(window as unknown as { __setForceOffline?: (v: boolean) => void }).__setForceOffline = (v: boolean) => {
      forced = v
      try { localStorage.setItem("__e2e_force_offline", v ? "1" : "0") } catch { /* egal */ }
      window.dispatchEvent(new Event(v ? "offline" : "online"))
    }
  })
  const login = await ctx.request.post(`${BASE_URL}/api/auth/login`, {
    data: { password: PASSWORD },
  })
  expect(login.ok()).toBeTruthy()
  return ctx
}

/**
 * Schaltet den simulierten Online-Status eines von `launchDevice` erzeugten
 * Contexts um — sowohl den echten Netzwerk-Layer (`context.setOffline`) als
 * auch `navigator.onLine` per Stub. Wirft, statt still nichts zu tun, wenn der
 * Stub fehlt (z.B. eine Page aus einem Context ohne launchDevice) — sonst
 * laufen Tests unbemerkt über den falschen Codepfad (siehe device.ts-Kommentar
 * oben).
 */
export async function setDeviceOffline(page: Page, offline: boolean): Promise<void> {
  const stubInstalled = await page.evaluate(
    () => typeof (window as unknown as { __setForceOffline?: unknown }).__setForceOffline === "function"
  )
  if (!stubInstalled) {
    throw new Error(
      "setDeviceOffline: onLine-Stub nicht installiert — Context wurde nicht über launchDevice() erzeugt " +
        "(addInitScript fehlt), oder die Page hat noch nie navigiert."
    )
  }
  if (offline) {
    await page.evaluate(() => {
      ;(window as unknown as { __setForceOffline?: (v: boolean) => void }).__setForceOffline?.(true)
    })
    await page.context().setOffline(true)
  } else {
    await page.context().setOffline(false)
    await page.evaluate(() => {
      ;(window as unknown as { __setForceOffline?: (v: boolean) => void }).__setForceOffline?.(false)
    })
  }
}
