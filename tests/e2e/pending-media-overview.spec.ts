/**
 * Wartende Fotos in der Medien-Übersicht.
 *
 * Nach dem Deploy adffa831 war ein offline angehängtes Foto in der
 * Einzelansicht sichtbar, im Medien-Tab aber nicht — dort tauchte es
 * erst nach dem Sync auf. Diese Spec deckt genau die Lücke ab:
 *
 *   Fall 1: Offline ein Foto anhängen → im Medien-Tab genau EINE zusätzliche
 *         Kachel mit blob:-Quelle und Warte-Kennzeichen.
 *   Fall 2: Nach dem Reconnect genau EINE Kachel für dieses Foto — die lokale
 *         verschwindet, der Server-Pfad ersetzt sie, keine Dublette.
 *
 * Gegen den lokalen Dev-Stack laufen lassen (Muster offline-media-preview):
 *   E2E_BASE_URL=http://localhost:4003 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/pending-media-overview.spec.ts --project=chromium --workers=1
 *
 * Zwei Stolperdrähte, beide sehen sonst wie Produktfehler aus:
 *   - Der ViewChunkWarmer rendert bis zu 15 s versteckte Kopien von Kalender,
 *     Medien und Übersicht in <main>. Ein globaler img-Locator zählt die
 *     wartende Kachel doppelt — deshalb überall `:visible`.
 *   - RATE_LIMIT_API_MAX (Default 60/min/IP) lässt /api/sync/upsert mit 429
 *     auflaufen; der Medien-Flush kommt dann nie und läuft in den Timeout
 *     statt in eine Assertion. Für Serienläufe in .env.localdev hochsetzen.
 *
 * Absolute Kachelzahlen wären in einer gewachsenen Dev-DB wertlos — gezählt
 * wird ausschließlich, was aus dem Wartekorb stammt (blob:-Quelle, Badge).
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { launchDevice, setDeviceOffline } from "./helpers/device"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/** 1×1-PNG — echtes Bild, damit sharp serverseitig nicht ablehnt. */
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

/** Kacheln der sichtbaren Medien-Übersicht, die aus dem Wartekorb stammen. */
function pendingTiles(page: Page) {
  return page.getByRole("main").locator('img[src^="blob:"]:visible')
}

async function openMediaTab(page: Page) {
  await page.getByRole("main").getByRole("button", { name: "Medien" }).click()
}



/** Anzahl wartender Dateien im mediaOutbox-Store (IDB "within-sync"). */
async function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("within-sync")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains("mediaOutbox")) {
            db.close()
            resolve(0)
            return
          }
          const req = db.transaction("mediaOutbox", "readonly").objectStore("mediaOutbox").count()
          req.onerror = () => { db.close(); reject(req.error) }
          req.onsuccess = () => { db.close(); resolve(req.result) }
        }
      })
  )
}

test.describe("Medien-Übersicht zeigt wartende Fotos", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-pending-overview-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("offline angehängtes Foto erscheint als wartende Kachel und wird nach dem Sync ersetzt", async () => {
    test.setTimeout(180_000)
    const marker = `e2e-1732 Uebersicht ${Date.now()}`

    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    await setDeviceOffline(page, true)

    await test.step("Fall 1: offline anhängen, Medien-Tab zeigt genau eine wartende Kachel", async () => {
      await page.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(marker)

      await page.locator('input[type="file"]').setInputFiles({
        name: "synthetic-overview.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 5_000 })

      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 5_000 })

      await openMediaTab(page)
      // Der eigentliche Befund: vor dem Fix war das hier 0 — die Übersicht las
      // den Wartekorb nie, weder online noch offline.
      await expect(pendingTiles(page)).toHaveCount(1, { timeout: 30_000 })
      await expect(
        page.getByRole("main").getByTitle(PENDING_BADGE).locator("visible=true")
      ).toHaveCount(1)
    })

    await test.step("Fall 2: nach dem Reconnect genau eine Kachel — keine Dublette", async () => {
      // Den Listener VOR dem Reconnect registrieren, sonst gewinnt der
      // Flush das Rennen und waitForResponse läuft in einen leeren Timeout.
      const uploadDone = page.waitForResponse(
        (r) => r.url().includes("/api/upload") && r.status() === 201,
        { timeout: 60_000 }
      )
      await setDeviceOffline(page, false)
      await uploadDone

      // Zwischen Upload-201 und deleteOutboxMedia zeigt die App legitim
      // beides. Erst wenn der Korb leer ist, ist die Dubletten-Prüfung ehrlich.
      await expect
        .poll(() => outboxCount(page), {
          timeout: 60_000,
          message: "mediaOutbox wurde nach dem Reconnect nicht geleert",
        })
        .toBe(0)

      const entries = await device.request.get(
        `/api/entries?q=${encodeURIComponent(marker)}&perPage=5`
      )
      const data = (await entries.json()) as {
        dateGroups: Array<{ entries: Array<{ id: string }> }>
      }
      const entryId = data.dateGroups.flatMap((g) => g.entries)[0]?.id
      expect(entryId).toBeTruthy()
      const detail = await device.request.get(`/api/entries/${entryId}`)
      const entry = (await detail.json()) as {
        media: Array<{ type: string; filePath: string; thumbnailPath?: string }>
      }
      const photos = entry.media.filter((m) => m.type === "photo")
      expect(photos).toHaveLength(1)
      // Dateiname der Server-Version — daran erkennt der Test unten die echte
      // Kachel, unabhängig davon, wie viele Fotos die Dev-DB sonst enthält.
      const serverFile = (photos[0].thumbnailPath ?? photos[0].filePath).split("/").pop() ?? ""
      expect(serverFile).not.toBe("")

      // BEWUSST OHNE reload(): der Sync bumpt timelineNonce
      // (syncRequiresMediaRefresh), die Übersicht muss darauf von selbst
      // nachziehen. Mit einem Reload an dieser Stelle wäre der Test blind
      // dafür, dass MediaGridView den refreshNonce gar nicht bekommt — dann
      // bliebe die Kachel mit „Wartet" stehen, obwohl die Datei längst oben ist.
      await expect(pendingTiles(page)).toHaveCount(0, { timeout: 30_000 })
      await expect(
        page.getByRole("main").getByTitle(PENDING_BADGE).locator("visible=true")
      ).toHaveCount(0)

      // Und die Server-Kachel rückt wirklich nach. Ohne diese positive Prüfung
      // wäre der Schritt auch dann grün, wenn das Foto aus der Übersicht ganz
      // verschwindet (kaputte /api/media-Projektion, zu scharfer Wächter).
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      await ensureVaultUnlocked(page)
      await openMediaTab(page)
      await expect(pendingTiles(page)).toHaveCount(0, { timeout: 30_000 })
      await expect(
        page.getByRole("main").locator(`img[src*="${serverFile}"]:visible`)
      ).toHaveCount(1, { timeout: 30_000 })
    })
  })
})
