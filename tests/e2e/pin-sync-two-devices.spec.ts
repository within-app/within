/**
 * Pin-Sync über zwei Geräte: „Wenn ich auf dem
 * Desktop einen Eintrag unpinne, muss das auch mit meinem Handy syncen."
 *
 * Zwei getrennte Browser-Profile (launchPersistentContext, Muster
 * offline-media-and-edit.spec.ts) = zwei Geräte mit eigener IDB, eigenem
 * SW-Cache, eigener Vault-Instanz:
 *
 *   1. A pinnt → B synct → B zeigt den Pin und hat die Fotos OFFLINE
 *      (verschlüsselte eigene Kopie via Backfill — der Feed trägt keine
 *      Medien-Metadaten).
 *   2. A unpinnt → B synct → Pin weg, Cache-Bytes weg, offline nur Text.
 *
 * Lauf gegen den Dev-Stack:
 *   E2E_BASE_URL=http://localhost:4001 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/pin-sync-two-devices.spec.ts
 *
 * Nur synthetische Inhalte.
 */

import { chromium, test, expect, type Page, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureVaultUnlocked } from "./helpers/vault"
import { openEntryByMarker } from "./helpers/timeline"

/** 1×1-PNG — echtes Bild, damit sharp serverseitig nicht ablehnt. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4000"
const PASSWORD = process.env.E2E_PASSWORD ?? "localtest"

/** Same flags as playwright.config.ts — the persistent context bypasses the fixtures. */
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
  // Playwright-Lücke im persistenten Context: setOffline(true) killt zwar das
  // Netz, lässt navigator.onLine aber auf true — die App hielte sich für
  // online und das Offline-Gate (shouldShowEntryMedia) griffe nie. Der Stub
  // stellt die Geräte-Realität her (Flugmodus setzt onLine=false); gesteuert
  // über localStorage, damit auch ein Reload im Offline-Zustand ihn sieht.
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

/** Netz + navigator.onLine gemeinsam umschalten — wie echter Flugmodus. */
async function setDeviceOffline(page: Page, offline: boolean) {
  if (offline) {
    // Erst onLine-Flag setzen (persistiert für Folge-Reloads), dann Netz kappen.
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
  // Erste Navigation: SW installiert + claimt (einmaliger Reload); die zweite
  // startet mit stehendem Controller.
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
}

async function openEntryDetail(page: Page, marker: string) {
  // Tages-Karte (03.09.): entry-card nur, wenn der Eintrag allein an seinem
  // Tag steht — sonst über die Tages-Vorschau (openEntryByMarker deckt beides ab).
  await openEntryByMarker(page, marker, undefined, 15_000)
  await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 15_000 })
}

/** /media/-Pfade der Cache-Einträge dieses Profils (within-media-v2). */
async function cachedMediaPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const cache = await caches.open("within-media-v2")
    return (await cache.keys()).map((req) => new URL(req.url).pathname)
  })
}

async function mediaContentType(page: Page, url: string): Promise<string> {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { cache: "no-store" })
    return res.headers.get("content-type") ?? ""
  }, url)
}

test.describe("Pin-Sync über zwei Geräte (A pinnt/unpinnt → B folgt)", () => {
  let dirA: string
  let dirB: string
  let deviceA: BrowserContext
  let deviceB: BrowserContext

  test.beforeAll(() => {
    dirA = mkdtempSync(join(tmpdir(), "within-pin-sync-a-"))
    dirB = mkdtempSync(join(tmpdir(), "within-pin-sync-b-"))
  })

  test.afterAll(async () => {
    await deviceA?.close().catch(() => {})
    await deviceB?.close().catch(() => {})
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })

  test("Pin auf A erreicht B (inkl. Medien offline); Unpin auf A räumt B (Cache-Bytes weg, offline nur Text)", async () => {
    test.setTimeout(300_000)
    const marker = `pin-sync-2dev ${Date.now()}`

    deviceA = await launchDevice(dirA)
    const pageA = await deviceA.newPage()

    await test.step("Gerät A: Eintrag mit Foto anlegen und pinnen", async () => {
      await openApp(pageA)
      await pageA.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
      await pageA.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = pageA.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(marker)
      await pageA.locator('input[type="file"]').setInputFiles({
        name: "pin-sync-a.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await pageA.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
        timeout: 20_000,
      })
      await pageA.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 5_000 })

      await openEntryDetail(pageA, marker)
      const pinResponse = pageA.waitForResponse(
        (r) => r.url().includes("/pin") && r.request().method() === "PUT" && r.ok(),
        { timeout: 30_000 }
      )
      await pageA.getByRole("button", { name: "Für offline speichern" }).click()
      await expect(
        pageA.getByRole("button", { name: "Offline-Speicherung aufheben" })
      ).toBeVisible({ timeout: 30_000 })
      // Der Pin-Op muss den Server erreicht haben (PUT /api/entries/[id]/pin 200).
      await pinResponse
    })

    deviceB = await launchDevice(dirB)
    const pageB = await deviceB.newPage()
    let mediaUrlsB: string[] = []

    await test.step("Gerät B: Sync adoptiert den Pin und lädt die eigene verschlüsselte Kopie", async () => {
      await openApp(pageB)

      // Adoption + Medien-Backfill laufen im Mount-Sync; UI-Beweis ist der
      // Umschalter im Detail. Reload zwischen den Poll-Runden stößt jeweils
      // einen frischen Sync an.
      await expect
        .poll(
          async () => {
            await pageB.goto("/")
            await pageB.waitForLoadState("networkidle")
            await ensureVaultUnlocked(pageB)
            await openEntryDetail(pageB, marker)
            return pageB
              .getByRole("button", { name: "Offline-Speicherung aufheben" })
              .isVisible()
              .catch(() => false)
          },
          { timeout: 90_000, intervals: [3_000], message: "Pin von A kommt auf B nicht an" }
        )
        .toBe(true)

      // Backfill-Beweis: B hält eigene verschlüsselte Kopien in within-media-v2.
      await expect
        .poll(async () => (await cachedMediaPaths(pageB)).length, {
          timeout: 60_000,
          intervals: [3_000],
          message: "Medien-Backfill auf B bleibt leer",
        })
        .toBeGreaterThanOrEqual(1)
      mediaUrlsB = await cachedMediaPaths(pageB)
    })

    await test.step("Gerät B offline: Fotos kommen aus dem eigenen verschlüsselten Pin-Cache", async () => {
      await setDeviceOffline(pageB, true)
      await pageB.reload()
      await pageB.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(pageB)

      for (const path of mediaUrlsB) {
        await expect
          .poll(async () => mediaContentType(pageB, path), {
            timeout: 15_000,
            message: `B offline: ${path} liefert keine entschlüsselten Bytes`,
          })
          .toMatch(/^image\/(?!svg)/)
      }
      await setDeviceOffline(pageB, false)
    })

    await test.step("Gerät A: unpinnt — Server bestätigt", async () => {
      const unpinResponse = pageA.waitForResponse(
        (r) => r.url().includes("/pin") && r.request().method() === "PUT" && r.ok(),
        { timeout: 30_000 }
      )
      await pageA.getByRole("button", { name: "Offline-Speicherung aufheben" }).click()
      await expect(
        pageA.getByRole("button", { name: "Für offline speichern" })
      ).toBeVisible({ timeout: 30_000 })
      await unpinResponse
    })

    await test.step("Gerät B: Sync räumt Pin, Cache-Bytes und zeigt offline nur Text", async () => {
      await expect
        .poll(
          async () => {
            await pageB.goto("/")
            await pageB.waitForLoadState("networkidle")
            await ensureVaultUnlocked(pageB)
            await openEntryDetail(pageB, marker)
            return pageB
              .getByRole("button", { name: "Für offline speichern" })
              .isVisible()
              .catch(() => false)
          },
          { timeout: 90_000, intervals: [3_000], message: "Unpin von A kommt auf B nicht an" }
        )
        .toBe(true)

      // Cache-Bytes freigegeben — der Sinn des Unpins.
      const remaining = await cachedMediaPaths(pageB)
      for (const url of mediaUrlsB) {
        expect(remaining).not.toContain(url)
      }

      // Offline: nur Text — kein Bild, weder aus Pin- noch aus HTTP-Cache.
      await setDeviceOffline(pageB, true)
      await pageB.reload()
      await pageB.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(pageB)
      await openEntryDetail(pageB, marker)
      await expect(pageB.getByRole("heading", { name: marker })).toBeVisible({ timeout: 10_000 })
      // Poll statt Sofort-Count: der SW kann die Route aus dem SHELL_CACHE
      // mit online-gerendertem SSR-HTML beantworten (img-KNOTEN vorhanden);
      // erst die Hydration wendet das Offline-Gate (shouldShowEntryMedia)
      // an und räumt die Galerie. Der Byte-Beweis folgt darunter.
      for (const path of mediaUrlsB) {
        await expect
          .poll(async () => pageB.locator(`img[src="${path}"]`).count(), {
            timeout: 15_000,
            message: `B offline nach Unpin: ${path} wird noch gerendert`,
          })
          .toBe(0)
      }
      for (const path of mediaUrlsB) {
        expect(await mediaContentType(pageB, path)).toContain("image/svg+xml")
      }
      await setDeviceOffline(pageB, false)
    })
  })
})
