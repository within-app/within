/**
 * „An diesem Tag": wartende Fotos sichtbar, Server-Fotos offline nicht.
 *
 * Vierte und letzte Stelle der Runde, und die einzige mit zwei
 * gegenläufigen Fehlern:
 *
 *   - Die Medien-Regel vom 22.08. griff hier GAR NICHT. `OnThisDayEntry` wurde
 *     ohne `showMedia` gerendert, der Default ist `true` — offline zeigte die
 *     Ansicht also die Server-Fotos ungepinnter Einträge, deren Bytes es
 *     offline gar nicht gibt.
 *   - Wartende Dateien tauchten umgekehrt nirgends auf, obwohl sie auf dem
 *     Gerät liegen.
 *
 * Beide Hälften werden am selben Tag geprüft: erst online ein Foto, das
 * wirklich hochgeht, dann offline ein wartendes.
 *
 * STOLPERDRAHT, der die zweite Hälfte sonst wertlos macht: offline füllt
 * `loadFullEntries` die Medienliste aus `readCachedEntryMedia`, und dieser
 * Cache wird NUR beim Öffnen der Einzelansicht im Online-Zustand geschrieben
 * (entry-detail.tsx, cacheEntryMedia). Ohne diesen Schritt trägt der
 * hochgeladene Eintrag offline `media: []`, es kann gar kein Server-Foto
 * rendern — die Prüfung wäre auch ohne die Regel grün. Deshalb wird der
 * Eintrag online einmal geöffnet.
 *
 * Lokal:
 *   E2E_BASE_URL=http://localhost:4003 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/pending-media-on-this-day.spec.ts --project=chromium --workers=1
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { launchDevice, setDeviceOffline } from "./helpers/device"
import { openEntryByMarker } from "./helpers/timeline"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

const PENDING_BADGE = "Wird beim nächsten Online-Gang hochgeladen"

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
}

/** Eintrag mit Foto schreiben; online wird auf die 201 des Uploads gewartet. */
async function writeEntryWithPhoto(page: Page, text: string, offline: boolean) {
  const uploaded = offline
    ? null
    : page.waitForResponse(
        (r) => r.url().includes("/api/upload") && r.status() === 201,
        { timeout: 30_000 }
      )

  await page.click('button[title="Neuer Eintrag (⌘N)"]')
  const textarea = page.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.fill(text)

  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-otd.png",
    mimeType: "image/png",
    buffer: PNG_1PX,
  })
  if (offline) await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 5_000 })

  await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 5_000 })
  if (uploaded) await uploaded
}

test.describe("An diesem Tag — Medien-Regel und wartende Fotos", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-pending-otd-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("offline: wartendes Foto sichtbar, hochgeladenes eines ungepinnten Eintrags nicht", async () => {
    test.setTimeout(120_000)
    const stamp = Date.now()

    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    const uploadedMarker = `e2e-1732 AnDiesemTag hochgeladen ${stamp}`
    await writeEntryWithPhoto(page, uploadedMarker, false)

    // Einzelansicht online öffnen — nur das schreibt die Medienliste in den
    // Cache, aus dem die Lese-Ansicht offline liest (siehe Kopf).
    // Großzügig: direkt nach einem Serverstart zahlt der erste Aufruf die
    // Kaltstart-Kompilierung der Route.
    await openEntryByMarker(page, uploadedMarker, undefined, 30_000)
    await expect(
      page.getByRole("button", { name: /^Foto \d+ von \d+ öffnen/ }).first()
    ).toBeVisible({ timeout: 30_000 })

    await setDeviceOffline(page, true)
    await writeEntryWithPhoto(page, `e2e-1732 AnDiesemTag wartend ${stamp}`, true)

    await page.getByRole("button", { name: "Übersicht" }).click()
    await page.getByRole("button", { name: /An diesem Tag/ }).click()

    const dialog = page.getByRole("dialog", { name: "An diesem Tag" })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog.locator("article").first()).toBeVisible({ timeout: 20_000 })

    // Erste Hälfte: die wartende Datei liegt auf dem Gerät und wird gezeigt.
    await expect(dialog.locator('img[src^="blob:"]')).toHaveCount(1, { timeout: 20_000 })
    await expect(dialog.getByTitle(PENDING_BADGE)).toHaveCount(1)

    // Zweite Hälfte: die Regel vom 22.08., die hier bisher gar nicht griff —
    // das hochgeladene Foto eines ungepinnten Eintrags bleibt offline weg.
    await expect(dialog.locator('img[src^="/media/"]')).toHaveCount(0)
  })
})
