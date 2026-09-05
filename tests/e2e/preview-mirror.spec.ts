/**
 * Offline-Medienspiegel + Kalender-Zellen:
 *
 * 1. Die Zeitraum-Einstellung (App-Einstellungen) regelt, welche
 *    Foto-VORSCHAUEN offline in der Medienübersicht liegen — mit ehrlicher
 *    Speicher-Info aus echten Server-Zahlen (/api/media/preview-stats).
 * 2. Der Spiegel-Lauf cached die Server-Thumbs verschlüsselt über die
 *    bestehende Pin-Cache-Mechanik (within-media-v2 + LRU-Zeilen).
 * 3. Flugmodus: Medienübersicht zeigt die ECHTEN Foto-Kacheln des Zeitraums
 *    (SW entschlüsselt aus dem Cache); Kalender-Tageszellen zeigen das Bild
 *    wie online (Timeline-Thumb aus der IDB).
 * 4. Zeitraum verkleinern/Aus: der Spiegel räumt NUR seine eigenen
 *    Cache-Einträge — Pin-Bytes bleiben unberührt.
 *
 * Muster offline-views.spec.ts (Flugmodus + navigator.onLine-Stub für
 * persistente Contexts). Nur synthetische Inhalte.
 */

import { chromium, test, expect, type Page, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureVaultUnlocked } from "./helpers/vault"
import { openEntryByMarker, expectEntryInTimeline } from "./helpers/timeline"

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

async function createEntry(page: Page, text: string, fileName: string) {
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
  await page.click('button[title="Neuer Eintrag (⌘N)"]')
  const textarea = page.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.fill(text)
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "image/png",
    buffer: PNG_1PX,
  })
  await page.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
    timeout: 20_000,
  })
  await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 5_000 })
}

async function openEntryDetail(page: Page, marker: string) {
  // Tages-Karte (03.09.): entry-card nur, wenn der Eintrag allein an seinem
  // Tag steht — sonst über die Tages-Vorschau (openEntryByMarker deckt beides ab).
  await openEntryByMarker(page, marker, undefined, 15_000)
  await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 15_000 })
}

/** Pfade aller Einträge im verschlüsselten Medien-Cache (within-media-v2). */
async function mediaCachePaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const cache = await caches.open("within-media-v2")
    return (await cache.keys()).map((r) => new URL(r.url).pathname).sort()
  })
}

/** Zeitraum in den Einstellungen umstellen (löst den Spiegel-Lauf aus). */
async function setPreviewPeriod(page: Page, optionLabel: string) {
  await page.goto("/settings")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.getByRole("combobox", { name: "Zeitraum" }).click()
  await page.getByRole("option", { name: optionLabel }).click()
}

test.describe("Offline-Medienspiegel: Zeitraum regelt die Vorschauen, Kalender-Zellen offline wie online", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-preview-mirror-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("Einstellung → Spiegel-Lauf → Flugmodus zeigt Zeitraum-Kacheln + Kalender-Bild; Verkleinern räumt nur eigene Bytes", async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const markerPinned = `preview-mirror pinned ${stamp}`
    const markerPlain = `preview-mirror plain ${stamp}`

    device = await launchDevice(dir)
    const page = await device.newPage()

    await test.step("Online: zwei Einträge mit Foto — Kalender/Medien-Tabs NICHT öffnen", async () => {
      await openApp(page)
      await createEntry(page, markerPinned, "mirror-a.png")
      await createEntry(page, markerPlain, "mirror-b.png")
      // Reload-Zyklus: Mount-Sync pullt beide Einträge samt Thumbnails in
      // die IDB, das Chunk-Warming holt die Lazy-Chunks.
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
      await page.waitForTimeout(5_000)
    })

    // Soll-Zahl des Zeitraums aus echten Server-Zahlen (dieselbe Quelle wie
    // die Speicher-Info) — der Dev-Stack hat Foto-Bestand aus früheren Läufen.
    let serverCount = 0

    await test.step("Einstellungen: Zeitraum '6 Monate' → ehrliche Speicher-Info aus Server-Zahlen", async () => {
      const since = new Date()
      since.setUTCMonth(since.getUTCMonth() - 6)
      const statsRes = await device.request.get(
        `${BASE_URL}/api/media/preview-stats?since=${encodeURIComponent(since.toISOString())}`
      )
      expect(statsRes.ok()).toBeTruthy()
      const stats = (await statsRes.json()) as { count: number; bytes: number }
      serverCount = stats.count
      expect(serverCount).toBeGreaterThanOrEqual(2)
      expect(stats.bytes).toBeGreaterThan(0)

      await setPreviewPeriod(page, "6 Monate")
      const info = page.getByTestId("preview-storage-info")
      // Echte Zahl (N Vorschauen · Größe) — kein Fehlertext, kein Dauerladen.
      await expect(info).toContainText(/Vorschau/, { timeout: 15_000 })
      await expect(info).not.toContainText("nicht abrufbar")
    })

    await test.step("Spiegel-Lauf: Cache-Ist erreicht das Server-Soll des Zeitraums (verschlüsselt)", async () => {
      await expect
        .poll(async () => (await mediaCachePaths(page)).filter((p) => p.endsWith("-thumb.webp")).length, {
          timeout: 180_000,
        })
        .toBe(serverCount)
      // Kurzer Puffer für den Registry-Write nach dem letzten Cache-Put.
      await page.waitForTimeout(3_000)
    })

    let pinnedFullPath = ""
    let pinnedThumbPath = ""
    let plainThumbPath = ""

    await test.step("Eintrag A pinnen (Server bestätigt) — Vollauflösung kommt zum Spiegel dazu", async () => {
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
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

      // Cache-Inventur: genau EINE Vollauflösung (die des Pins — der Spiegel
      // cached nie Vollauflösungen) neben den Zeitraum-Thumbs.
      await expect
        .poll(
          async () => (await mediaCachePaths(page)).filter((p) => !p.endsWith("-thumb.webp")).length,
          { timeout: 60_000 }
        )
        .toBe(1)
      const paths = await mediaCachePaths(page)
      pinnedFullPath = paths.find((p) => !p.endsWith("-thumb.webp")) ?? ""
      const pinnedId = pinnedFullPath.split("/").slice(-2, -1)[0]
      pinnedThumbPath = paths.find((p) => p.includes(pinnedId) && p.endsWith("-thumb.webp")) ?? ""
      plainThumbPath = paths.find((p) => p.endsWith("-thumb.webp") && !p.includes(pinnedId)) ?? ""
      expect(pinnedFullPath).not.toBe("")
      expect(pinnedThumbPath).not.toBe("")
      expect(plainThumbPath).not.toBe("")
    })

    await test.step("Flugmodus: Medienübersicht zeigt die ECHTEN Foto-Kacheln des Zeitraums", async () => {
      await setDeviceOffline(page, true)
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(page)
      // Tages-Karte (03.09.): reicht sich der Eintrag den Tag mit anderen,
      // ist er in eine day-card gefaltet statt einer eigenen entry-card.
      await expectEntryInTimeline(page, markerPlain, { timeout: 20_000 })

      await page.getByRole("main").getByRole("button", { name: "Medien" }).click()
      // Zeitraum-Kacheln sind Server-Thumb-URLs (SW entschlüsselt aus dem
      // Cache) — nicht mehr nur die data:-Timeline-Thumbnails.
      // Die Menge ist exakt das Server-Soll des Zeitraums (eine Kachel PRO FOTO).
      await expect(page.locator('img[src*="-thumb.webp"]')).toHaveCount(serverCount, {
        timeout: 30_000,
      })
      await expect(page.getByText("Fotos offline nicht verfügbar")).toHaveCount(0)
    })

    await test.step("Flugmodus: Kalender-Tageszelle zeigt das Bild wie online", async () => {
      await page.getByRole("button", { name: "Kalender" }).click()
      await expect(page.locator('[role="grid"]').first()).toBeVisible({ timeout: 20_000 })
      // Tageszellen-Thumbnail aus der IDB (data:-URL) — vor dem Fix gab es
      // offline nur Zähler-Punkte.
      await expect(page.locator('[role="grid"] img').first()).toBeVisible({ timeout: 10_000 })
    })

    await test.step("Wieder online: Zeitraum 'Aus' → Spiegel räumt NUR eigene Bytes, Pin bleibt", async () => {
      await setDeviceOffline(page, false)
      await setPreviewPeriod(page, "Aus")
      await expect(page.getByTestId("preview-storage-info")).toContainText(/Keine Vorschauen/, {
        timeout: 10_000,
      })
      // ALLE Spiegel-Thumbs verschwinden (auch der des ungepinnten Eintrags B);
      // A-Thumb + A-Vollauflösung gehören dem Pin und bleiben unangetastet.
      await expect
        .poll(async () => mediaCachePaths(page), { timeout: 120_000 })
        .toEqual([pinnedFullPath, pinnedThumbPath].sort())
      expect(plainThumbPath).not.toBe(pinnedThumbPath)
    })

    await test.step("Suite-Hygiene: Pin wieder lösen (Server bestätigt)", async () => {
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
      await openEntryDetail(page, markerPinned)
      const unpinResponse = page.waitForResponse(
        (r) => r.url().includes("/pin") && r.request().method() === "PUT" && r.ok(),
        { timeout: 30_000 }
      )
      await page.getByRole("button", { name: "Offline-Speicherung aufheben" }).click()
      await expect(
        page.getByRole("button", { name: "Für offline speichern" })
      ).toBeVisible({ timeout: 30_000 })
      await unpinResponse
    })
  })
})
