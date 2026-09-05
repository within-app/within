/**
 * Timeline-Filter „Offline verfügbar" + Offline-Unpin
 * am Gerät (Feldbefund c).
 *
 * Beweisziele:
 *   1. Der Filter zeigt exakt die gepinnten Einträge — online.
 *   2. Unpin aus der Detail-Ansicht entfernt den Eintrag LIVE aus dem
 *      gefilterten View (onPinChanged → timelineNonce).
 *   3. Der Filter funktioniert im Flugmodus identisch (Quelle: lokaler
 *      Pin-Store, nie der Server).
 *   4. Offline-Unpin: im Flugmodus entpinnen → lokale Freigabe sofort
 *      (Pin-Record + Cache-Bytes), beim nächsten Online-Kontakt flusht die
 *      Op-Queue den Unpin zum Server (PUT /api/entries/[id]/pin).
 *
 * Ein Gerät (persistentes Profil, Muster pin-sync-two-devices.spec.ts).
 * Suite-Hygiene: Pins sind Server-Zustand — die Spec endet
 * entpinnt (der Offline-Unpin-Flush ist zugleich das Cleanup).
 *
 * Lauf gegen den Dev-Stack:
 *   E2E_BASE_URL=http://localhost:4001 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/timeline-offline-filter.spec.ts
 *
 * Nur synthetische Inhalte.
 */

import { chromium, test, expect, type Page, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureVaultUnlocked } from "./helpers/vault"
import { openEntryByMarker, TIMELINE_CARD } from "./helpers/timeline"

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
  // navigator.onLine-Stub für persistente Contexts — setOffline(true) allein
  // lässt onLine auf true (Kommentar in pin-sync-two-devices.spec.ts).
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

async function createEntry(page: Page, text: string, withPhoto: boolean) {
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
  await page.click('button[title="Neuer Eintrag (⌘N)"]')
  const textarea = page.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.fill(text)
  if (withPhoto) {
    await page.locator('input[type="file"]').setInputFiles({
      name: "offline-filter.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    })
    await page.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
      timeout: 20_000,
    })
  }
  await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 5_000 })
}

async function openEntryDetail(page: Page, marker: string) {
  // Tages-Karte (03.09.): entry-card nur, wenn der Eintrag allein an seinem
  // Tag steht — sonst über die Tages-Vorschau (openEntryByMarker deckt beides ab).
  await openEntryByMarker(page, marker, undefined, 15_000)
  await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 15_000 })
}

/** Filter-Panel öffnen (falls zu) und den Offline-Toggle klicken. */
async function toggleOfflineFilter(page: Page) {
  const openBtn = page.getByRole("button", { name: "Filter öffnen" })
  if (await openBtn.isVisible().catch(() => false)) {
    await openBtn.click()
  }
  await page.getByRole("button", { name: "Offline verfügbar" }).click()
}

function entryCards(page: Page, marker: string) {
  // TIMELINE_CARD (Union): der Pin-Filter reduziert i.d.R. auf 1 Treffer und
  // bleibt entry-card, aber bei Leichen-Pins aus einem abgebrochenen früheren
  // Lauf könnte der Tag 2+ gepinnte Einträge zeigen (day-card).
  return page.locator(TIMELINE_CARD, { hasText: marker })
}

test.describe("Timeline-Filter 'Offline verfügbar' + Offline-Unpin", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-offline-filter-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("Filter zeigt exakt die gepinnten Einträge (online + Flugmodus); Unpin entfernt live; Offline-Unpin flusht beim Reconnect", async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const markerPinned = `offline-filter pinned ${stamp}`
    const markerUnpinned = `offline-filter unpinned ${stamp}`

    device = await launchDevice(dir)
    const page = await device.newPage()

    await test.step("Setup: zwei Einträge, einer gepinnt (Server bestätigt)", async () => {
      await openApp(page)
      await createEntry(page, markerUnpinned, false)
      await createEntry(page, markerPinned, true)

      await openEntryDetail(page, markerPinned)
      const pinResponse = page.waitForResponse(
        (r) => r.url().includes("/pin") && r.request().method() === "PUT" && r.ok(),
        { timeout: 30_000 }
      )
      await page.getByRole("button", { name: "Für offline speichern" }).click()
      await expect(
        page.getByRole("button", { name: "Offline-Speicherung aufheben" })
      ).toBeVisible({ timeout: 30_000 })
      await pinResponse
    })

    await test.step("Online: Filter zeigt exakt den gepinnten Eintrag", async () => {
      // Der Filter liest den lokalen Pin-Store + IDB-Spiegel; der Mount-Sync
      // muss die frischen Einträge erst gepullt haben — daher Poll mit Reload.
      // Innerhalb jeder Runde auto-wartend zählen: der pinned-View lädt nach
      // dem Toggle asynchron aus der IDB, ein Sofort-Count sähe noch den
      // ungefilterten Zustand.
      await expect
        .poll(
          async () => {
            await page.goto("/")
            await page.waitForLoadState("networkidle")
            await ensureVaultUnlocked(page)
            await toggleOfflineFilter(page)
            try {
              await expect(entryCards(page, markerPinned)).toHaveCount(1, { timeout: 10_000 })
              await expect(entryCards(page, markerUnpinned)).toHaveCount(0, { timeout: 2_000 })
              return true
            } catch {
              return false
            }
          },
          { timeout: 120_000, intervals: [1_000], message: "Filter zeigt nicht exakt die gepinnten Einträge" }
        )
        .toBe(true)
    })

    await test.step("Flugmodus: Filter identisch — gepinnter Eintrag da, ungepinnter nicht", async () => {
      await setDeviceOffline(page, true)
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(page)
      await toggleOfflineFilter(page)
      await expect(entryCards(page, markerPinned)).toHaveCount(1, { timeout: 15_000 })
      await expect(entryCards(page, markerUnpinned)).toHaveCount(0)
    })

    await test.step("Offline-Unpin: lokale Freigabe sofort, gefilterte Timeline aktualisiert live", async () => {
      await openEntryDetail(page, markerPinned)
      await page.getByRole("button", { name: "Offline-Speicherung aufheben" }).click()
      await expect(
        page.getByRole("button", { name: "Für offline speichern" })
      ).toBeVisible({ timeout: 15_000 })

      // Pin-Record lokal weg (Datenquelle des Filters) …
      const pinGone = await page.evaluate(async () => {
        const req = indexedDB.open("within-sync")
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        try {
          const tx = db.transaction("pinnedEntries", "readonly")
          const count = await new Promise<number>((resolve, reject) => {
            const c = tx.objectStore("pinnedEntries").count()
            c.onsuccess = () => resolve(c.result)
            c.onerror = () => reject(c.error)
          })
          return count === 0
        } finally {
          db.close()
        }
      })
      expect(pinGone).toBe(true)

      // … Cache-Bytes freigegeben (uncacheEntryMedia) …
      const cachedPaths = await page.evaluate(async () => {
        const cache = await caches.open("within-media-v2")
        return (await cache.keys()).map((req) => new URL(req.url).pathname)
      })
      expect(cachedPaths).toEqual([])

      // … und der gefilterte View verliert den Eintrag live (onPinChanged).
      // „Keine Treffer" rendert erst nach abgeschlossenem Load mit 0 Treffern
      // — ein nackter 0-Count wäre schon während des Skeletons wahr.
      await expect(page.getByText("Keine Treffer")).toBeVisible({ timeout: 15_000 })
      await expect(entryCards(page, markerPinned)).toHaveCount(0)
    })

    await test.step("Reconnect: Op-Queue flusht den Unpin zum Server (zugleich Suite-Cleanup)", async () => {
      const flushResponse = page.waitForResponse(
        (r) => r.url().includes("/pin") && r.request().method() === "PUT" && r.ok(),
        { timeout: 60_000 }
      )
      await setDeviceOffline(page, false)
      await flushResponse

      // Server-Gegenprobe: Nach Reload + frischem Sync bleibt der Filter leer.
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
      await toggleOfflineFilter(page)
      await expect(page.getByText("Keine Treffer")).toBeVisible({ timeout: 15_000 })
      await expect(entryCards(page, markerPinned)).toHaveCount(0)
    })
  })
})
