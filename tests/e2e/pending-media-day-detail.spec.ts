/**
 * Wartende Fotos in der Tages-Vorschau.
 *
 * Dritte Stelle desselben Widerspruchs: die Datei liegt auf dem Gerät, war aber
 * unsichtbar. Die Tages-Vorschau las den Wartekorb nicht (`joinDayRows` kannte
 * nur Server und Medien-Cache) und blendete offline zusätzlich über
 * `shouldShowEntryMedia` die ganze Galerie ungepinnter Einträge aus. Beides
 * zusammen hieß: offline angehängtes Foto → in der Tages-Vorschau nichts.
 *
 * Geprüft werden BEIDE Hälften der Regel am selben Tag: die wartende Datei ist
 * offline und ungepinnt sichtbar, die vorher hochgeladene bleibt der Regel vom
 * 22.08. unterworfen und ist es nicht. Ohne die zweite Hälfte wäre der Test
 * auch dann grün, wenn offline einfach alles gezeigt würde.
 *
 * Zwei Einträge am selben Tag erzwingen die Tages-Karte — nur über sie führt
 * der Weg in die Tages-Vorschau; steht ein Eintrag allein an seinem Tag, ist er
 * eine gewöhnliche entry-card.
 *
 * Lokal:
 *   E2E_BASE_URL=http://localhost:4003 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/pending-media-day-detail.spec.ts --project=chromium --workers=1
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { launchDevice, setDeviceOffline } from "./helpers/device"
import { utcDateKey } from "./helpers/timeline"
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

/**
 * Einen Eintrag mit einem Foto schreiben.
 * `offline`: das Foto bleibt im Wartekorb (Warte-Kennzeichen erscheint).
 * Online: auf die 201 des Uploads warten, damit die Datei wirklich oben ist.
 */
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
    name: "synthetic-day.png",
    mimeType: "image/png",
    buffer: PNG_1PX,
  })
  if (offline) await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 5_000 })

  await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
  await expect(textarea).not.toBeVisible({ timeout: 5_000 })
  if (uploaded) await uploaded
}

test.describe("Tages-Vorschau zeigt wartende Fotos", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-pending-day-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("offline angehängtes Foto ist in der Tages-Vorschau sichtbar, ungepinnt", async () => {
    test.setTimeout(120_000)
    const stamp = Date.now()

    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)

    // Erst ONLINE ein Foto, das wirklich hochgeht — es liefert die zweite
    // Hälfte der Regel (offline + ungepinnt → unsichtbar). Zwei Einträge am
    // selben Tag falten die Timeline außerdem in eine Tages-Karte, ohne die
    // die Tages-Vorschau gar nicht erreichbar wäre.
    await writeEntryWithPhoto(page, `e2e-1732 Tagesvorschau hochgeladen ${stamp}`, false)

    await setDeviceOffline(page, true)
    await writeEntryWithPhoto(page, `e2e-1732 Tagesvorschau wartend ${stamp}`, true)

    const dayCard = page
      .getByRole("main")
      .locator(`[data-testid="day-card"][data-date="${utcDateKey()}"]`)
      .first()
    await expect(dayCard).toBeVisible({ timeout: 20_000 })
    await dayCard.click()

    const dayDetail = page.locator('[data-testid="day-detail"]')
    await expect(dayDetail).toBeVisible({ timeout: 20_000 })

    // Der Befund: vorher war hier nichts — weder mischte joinDayRows den
    // Wartekorb ein, noch ließ shouldShowEntryMedia offline eine ungepinnte
    // Galerie durch.
    await expect(dayDetail.locator('img[src^="blob:"]')).toHaveCount(1, { timeout: 20_000 })
    await expect(dayDetail.getByTitle(PENDING_BADGE)).toHaveCount(1)

    // Zweite Hälfte: das hochgeladene Foto des anderen Eintrags bleibt offline
    // und ungepinnt unsichtbar (Regel vom 22.08.). Ohne diese Prüfung wäre der
    // Test auch grün, wenn visibleEntryMedia offline einfach alles durchließe.
    await expect(dayDetail.locator('img[src^="/media/"]')).toHaveCount(0)
  })
})
