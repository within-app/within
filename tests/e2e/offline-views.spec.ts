/**
 * Offline-Ansichten: Kalender und Medien
 * funktionierten offline nicht — nur die Timeline.
 *
 * Root Cause: Kalender/Medien/Karte sind dynamic()-Imports; der SW cached
 * statische Chunks nur ON FIRST FETCH (precache = nur '/' + '/login').
 * Eine Ansicht, die seit dem letzten Deploy nie ONLINE geöffnet wurde, hat
 * ihren Chunk nicht im Cache — offline scheitert der Import, die Ansicht
 * bleibt beim Spinner, und der längst vorhandene IDB-Fallback des Kalenders
 * wird nie ausgeführt.
 *
 * Beweisziele:
 *   1. Kalender funktioniert offline OHNE Online-Erstbesuch der Ansicht
 *      (Chunk-Warming + bestehender IDB-Fallback): Monatsraster rendert,
 *      der Tagestipp zeigt den Eintrag aus der IDB (Einzelansicht bei einem,
 *      Tages-Vorschau rechts bei mehreren Einträgen).
 *   2. Medien-Grid zeigt offline die Timeline-Thumbnails aus der IDB
 *      (Option „Gepinnte + Thumbnails", kein Speicherwachstum)
 *      statt des Offline-Hinweises.
 *
 * Wichtig: Die Ansichten werden online NIE angeklickt — genau das ist der
 * Repro-Kern (rot gegen den Stand ohne Chunk-Warming).
 *
 * Nur synthetische Inhalte.
 */

import { chromium, test, expect, type Page, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureVaultUnlocked } from "./helpers/vault"
import { expectEntryInTimeline, utcDateKey } from "./helpers/timeline"

/** 1×1-PNG — echtes Bild, damit sharp serverseitig nicht ablehnt. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4000"
const PASSWORD = process.env.E2E_PASSWORD ?? "localtest"

const LAUNCH_ARGS = [
  "--disable-features=HttpsUpgrades,AutoupgradeMixedContent",
  `--unsafely-treat-insecure-origin-as-secure=${BASE_URL}`,
  "--disable-dev-shm-usage",
]

async function launchDevice(profileDir: string): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: LAUNCH_ARGS,
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
  })
  // navigator.onLine-Stub für persistente Contexts (pin-sync-two-devices.spec.ts).
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

async function setDeviceOffline(page: Page, offline: boolean) {
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

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
}

test.describe("Offline-Ansichten: Kalender + Medien ohne Online-Erstbesuch", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-offline-views-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("Kalender rendert offline aus der IDB; Medien-Grid zeigt Timeline-Thumbnails — beide Ansichten online nie geöffnet", async () => {
    test.setTimeout(300_000)
    const marker = `offline-views ${Date.now()}`

    device = await launchDevice(dir)
    const page = await device.newPage()

    await test.step("Online: Eintrag mit Foto anlegen — Kalender/Medien-Tabs NICHT öffnen", async () => {
      await openApp(page)
      await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
      await page.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(marker)
      await page.locator('input[type="file"]').setInputFiles({
        name: "offline-views.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await page.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
        timeout: 20_000,
      })
      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 5_000 })

      // Ein Reload-Zyklus: der Mount-Sync pullt den Eintrag samt Thumbnail in
      // die IDB — und gibt dem Chunk-Warming (Fix) Zeit, die Lazy-Chunks in
      // den SW-Static-Cache zu holen.
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
      await page.waitForTimeout(5_000)
    })

    await test.step("Flugmodus + Kaltstart: Timeline zeigt den Eintrag (IDB-Basis steht)", async () => {
      await setDeviceOffline(page, true)
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(page)
      // Tages-Karte (03.09.): reicht der Eintrag sich den Tag mit anderen,
      // ist er in eine day-card gefaltet statt einer eigenen entry-card.
      await expectEntryInTimeline(page, marker, { timeout: 20_000 })
    })

    await test.step("Kalender offline: Monatsraster rendert, Tag zeigt den IDB-Eintrag", async () => {
      await page.getByRole("button", { name: "Kalender" }).click()
      // Ohne gecachten Chunk bleibt hier für immer der ViewSpinner stehen —
      // exakt der Feldbefund.
      await expect(page.locator('[role="grid"]').first()).toBeVisible({ timeout: 20_000 })
      // Heutigen Tag anklicken → loadDayEntries fällt auf die IDB zurück: ein
      // Eintrag öffnet die Einzelansicht, mehrere die Tages-Vorschau rechts —
      // der Marker ist in beiden sichtbar (kein Tages-Panel mehr unter dem Raster).
      // Tag der App-Zone statt Gerätezeit — sonst weicht die geklickte Zelle
      // nahe der Tagesgrenze vom serverseitig gruppierten Tag ab.
      const today = Number(utcDateKey().slice(-2))
      await page
        .locator('[role="grid"] button', { hasText: new RegExp(`^${today}$`) })
        .first()
        .click()
      await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10_000 })
    })

    await test.step("Medien offline: Grid zeigt das Timeline-Thumbnail statt des Offline-Hinweises", async () => {
      // Scoped auf main: die Sidebar hat einen gleichnamigen "Medien"-Eintrag.
      await page.getByRole("main").getByRole("button", { name: "Medien" }).click()
      // Kachel aus der IDB: data:-URL des Timeline-Thumbnails.
      await expect(page.locator('img[src^="data:image"]').first()).toBeVisible({
        timeout: 20_000,
      })
      // Der pauschale Offline-Hinweis darf nicht mehr erscheinen.
      await expect(page.getByText("Fotos offline nicht verfügbar")).toHaveCount(0)
    })

    await test.step("Aufräumen: wieder online (keine Pins gesetzt — nichts zu entpinnen)", async () => {
      await setDeviceOffline(page, false)
    })
  })
})
