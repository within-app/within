/**
 * Day-One-Import im echten Browser: die Ergebnisliste bleibt bei vielen Hinweisen
 * benutzbar, und ein verbundenes Gerät holt sich alte importierte Einträge von selbst.
 *
 * Gegen den lokalen Dev-Stack laufen lassen:
 *   WITHIN_DEV_PORT=4010 WITHIN_DEV_DB_PORT=5440 \
 *     docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build -d
 *   E2E_BASE_URL=http://localhost:4010 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/day-one-import-complete.spec.ts
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type Page } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { zipSync, strToU8 } from "fflate"
import { ensureVaultUnlocked } from "./helpers/vault"
import { launchDevice } from "./helpers/device"

const hex = () => randomUUID().replace(/-/g, "").toUpperCase()

/** Liest aus der Geräte-Datenbank, was der Sync dort hinterlassen hat. */
function deviceState(page: Page, entryId: string) {
  return page.evaluate((id) => new Promise<{ hasEntry: boolean; datasetId: unknown }>((resolve, reject) => {
    const open = indexedDB.open("within-sync")
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(["entries", "meta"])
      const entry = tx.objectStore("entries").getKey(id)
      const meta = tx.objectStore("meta").get("datasetId")
      tx.oncomplete = () => {
        open.result.close()
        const raw = meta.result as { value?: unknown } | string | undefined
        resolve({ hasEntry: entry.result !== undefined, datasetId: typeof raw === "object" ? raw?.value ?? raw : raw })
      }
      tx.onerror = () => reject(tx.error)
    }
  }), entryId)
}

test.describe("Day-One-Import", () => {
  test("alle Hinweise stehen in einer scrollbaren Liste, auch auf dem Telefon", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    const photos = Array.from({ length: 30 }, (_, i) => ({ identifier: `P${i}`, md5: `${hex()}${i}`, type: "jpeg" }))
    const zip = zipSync({
      "Journal.json": strToU8(JSON.stringify({
        entries: [{ uuid: hex(), text: "e2e-import-liste", creationDate: "2019-02-01T10:00:00Z", photos }],
      })),
    })

    await page.goto("/settings")
    await ensureVaultUnlocked(page)
    await page.locator('input[type="file"][accept=".zip"]').setInputFiles({
      name: "synthetic.zip", mimeType: "application/zip", buffer: Buffer.from(zip),
    })
    await page.getByRole("button", { name: "Import starten" }).click()

    const summary = page.getByText("30 Hinweise")
    await expect(summary).toBeVisible({ timeout: 30_000 })
    await summary.click()

    const list = page.locator("details[open] ul")
    await expect(list.locator("li")).toHaveCount(30)
    const box = await list.evaluate((el) => ({
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
      overflowY: getComputedStyle(el).overflowY,
    }))
    expect(box.overflowY).toBe("auto")
    expect(box.clientHeight).toBeLessThanOrEqual(260)
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth)
    const page360 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
    expect(page360.scroll).toBeLessThanOrEqual(page360.inner)

    // Der letzte Hinweis ist auch wirklich erreichbar.
    await list.locator("li").last().scrollIntoViewIfNeeded()
    await expect(list.locator("li").last()).toBeInViewport()
  })

  test("ein verbundenes Gerät holt sich alte importierte Einträge beim nächsten Sync", async () => {
    test.setTimeout(120_000)
    const dir = mkdtempSync(join(tmpdir(), "within-import-"))
    const device = await launchDevice(dir)
    try {
      const page = await device.newPage()
      const uuid = hex()
      const entryId = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`.toLowerCase()

      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)

      // Erst wenn das Gerät eine Kennung kennt, kann es deren Wechsel bemerken.
      let before: unknown
      await expect.poll(async () => {
        before = (await deviceState(page, entryId)).datasetId
        return before
      }, { timeout: 30_000 }).toBeTruthy()

      // Zehn Jahre alter Eintrag: über updated_at erreicht ihn kein Delta-Sync.
      const zip = zipSync({
        "Journal.json": strToU8(JSON.stringify({
          entries: [{ uuid, text: "e2e-import-geraet", creationDate: "2016-02-01T10:00:00Z", modifiedDate: "2016-02-01T10:00:00Z" }],
        })),
      })
      const res = await device.request.post("/api/import", {
        headers: { "Content-Type": "application/zip" }, data: Buffer.from(zip),
      })
      expect(res.status()).toBe(200)
      expect((await res.json()).imported).toBe(1)

      // Der Sync läuft beim Wieder-online-Gehen, ganz ohne Zutun am Gerät.
      await expect.poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("online")))
        return (await deviceState(page, entryId)).hasEntry
      }, { timeout: 45_000, intervals: [2_000] }).toBe(true)
      expect((await deviceState(page, entryId)).datasetId).not.toEqual(before)
    } finally {
      await device.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
