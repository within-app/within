/**
 * Zustellungs-Beweis im echten Browser.
 *
 * Der Node-Harness (tests/sw-media-encryption.test.ts, media-key-channel.test.ts)
 * beweist die LOGIK von Key-Kanal und SW-Entschlüsselung — nicht die ZUSTELLUNG
 * im echten Browser (Lehre: startMessages() fehlte, alle Units grün,
 * Zustellung tot). Dieser Spec beweist end-to-end in Chromium:
 *
 *   1. Pin → Cache-Eintrag in within-media-v2 ist Ciphertext (x-within-enc: v1)
 *   2. Offline-Kaltstart (Reload = DEK weg) → PIN-Unlock → MEDIA_KEY erreicht
 *      den SW → /media/-Fetch liefert entschlüsselte Bild-Bytes statt Platzhalter
 *   3. In-Session-Lock (pagehide) → MEDIA_KEY_CLEAR erreicht den SW → offline
 *      nur noch SVG-Platzhalter, nie Ciphertext
 *   4. Re-Unlock in derselben SW-Generation → Push-Kanal liefert wieder Bytes
 *
 * NICHT abgedeckt (ehrlich): der Pull-Kanal nach SW-Idle-Restart
 * (MEDIA_KEY_REQUEST) — ein SW-Kill ist in Playwright nicht deterministisch
 * erzwingbar; bleibt Unit-geprüft + Gerätetest. Nur synthetische Inhalte.
 *
 * Lauf gegen den Dev-Stack:
 *   E2E_BASE_URL=http://localhost:4001 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/vault-media-delivery.spec.ts
 */

import { test, expect, type Page } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { openEntryByMarker } from "./helpers/timeline"

/** 1×1-PNG — echtes Bild, damit sharp serverseitig nicht ablehnt. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

/** Content-Type, den ein /media/-Fetch im Seitenkontext liefert. */
async function mediaContentType(page: Page, url: string): Promise<string> {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { cache: "no-store" })
    return res.headers.get("content-type") ?? ""
  }, url)
}

/**
 * Fetch im DEFAULT-Cache-Modus — darf den HTTP-Cache des Browsers benutzen.
 * Genau das ist der Punkt des Negativbeweises: mit `cache: "no-store"` würde
 * der Browser-HTTP-Cache umgangen und das Leck bliebe unsichtbar.
 */
async function mediaFetchDefault(
  page: Page,
  url: string
): Promise<{ cc: string; ct: string; all: Record<string, string> }> {
  return page.evaluate(async (u) => {
    const res = await fetch(u)
    const all: Record<string, string> = {}
    res.headers.forEach((v, k) => { all[k] = v })
    return {
      cc: res.headers.get("cache-control") ?? "",
      ct: res.headers.get("content-type") ?? "",
      all,
    }
  }, url)
}

test.describe("Vault-Medien-Zustellung — Pin, Kaltstart, Lock/Unlock (echter Browser)", () => {
  test("Pin cached Ciphertext; Offline-Kaltstart + Unlock liefert Bytes; Lock liefert Platzhalter; Re-Unlock heilt", async ({ page }) => {
    // 240s: der Unpin-Aufräumschritt (Pin-Sync 23.08.) kommt zum alten
    // 180s-Budget dazu — die PBKDF2-Unlocks dominieren die Laufzeit.
    test.setTimeout(240_000)
    const marker = `vault-delivery ${Date.now()}`

    await test.step("Online: Vault einrichten, Eintrag mit Foto anlegen", async () => {
      // Erste Navigation: SW installiert, claimt und triggert den einmaligen
      // controllerchange-Reload. Die zweite Navigation startet mit stehendem
      // Controller — kein Reload mehr, der in Setup/Editor-Fluss platzen kann.
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)

      await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
      await page.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(marker)
      await page.locator('input[type="file"]').setInputFiles({
        name: "vault-delivery.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      // Online-Upload abwarten, dann speichern
      await page.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
        timeout: 20_000,
      })
      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 5_000 })
    })

    let mediaUrls: string[] = []

    await test.step("Detail öffnen, pinnen — Cache-Eintrag ist Ciphertext", async () => {
      // Frisch angelegter Eintrag — Tages-Karte (03.09.): entry-card nur, wenn
      // er allein an seinem Tag steht, sonst über die Tages-Vorschau.
      await openEntryByMarker(page, marker, undefined, 10_000)
      await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 10_000 })

      const pinButton = page.getByRole("button", { name: "Für offline speichern" })
      await expect(pinButton).toBeVisible({ timeout: 10_000 })
      await pinButton.click()
      // caching → fertig: aria-label wechselt auf Unpin
      await expect(
        page.getByRole("button", { name: "Offline-Speicherung aufheben" })
      ).toBeVisible({ timeout: 30_000 })

      // Beweis „Ciphertext at rest": jeder Cache-Eintrag trägt x-within-enc: v1
      const cacheState = await page.evaluate(async () => {
        const cache = await caches.open("within-media-v2")
        const keys = await cache.keys()
        const rows: { url: string; enc: string | null }[] = []
        for (const req of keys) {
          const res = await cache.match(req)
          rows.push({ url: req.url, enc: res?.headers.get("x-within-enc") ?? null })
        }
        return rows
      })
      expect(cacheState.length).toBeGreaterThanOrEqual(1)
      for (const row of cacheState) expect(row.enc).toBe("v1")
      mediaUrls = cacheState.map((r) => new URL(r.url).pathname)
    })

    await test.step("Offline-Kaltstart: Unlock stellt den Key zu, Fotos kommen entschlüsselt", async () => {
      await page.context().setOffline(true)
      await page.reload()
      await page.waitForLoadState("domcontentloaded")
      // Kaltstart = gesperrt; Unlock muss offline funktionieren und pusht MEDIA_KEY
      await ensureVaultUnlocked(page)

      // Zustellungs-Beweis: der SW entschlüsselt den gepinnten Cache-Eintrag —
      // Content-Type image/* (nie svg-Platzhalter, nie Fehler)
      for (const path of mediaUrls) {
        await expect
          .poll(async () => mediaContentType(page, path), {
            timeout: 15_000,
            message: `SW liefert für ${path} keine entschlüsselten Bytes`,
          })
          .toMatch(/^image\/(?!svg)/)
      }
    })

    await test.step("In-Session-Lock: MEDIA_KEY_CLEAR erreicht den SW — nur noch Platzhalter", async () => {
      // pagehide ist der definierte Sofort-Lock-Trigger (use-vault-lock.ts);
      // der Event prüft exakt die Hook→Kanal→SW-Kette im echten Browser.
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
      // Lock-Gate steht wieder vor der App
      await expect(
        page.locator('div[role="dialog"][aria-modal="true"] input[type="password"]')
      ).toBeVisible({ timeout: 10_000 })

      // Gesperrt + offline: SW darf NIE Ciphertext oder Bytes liefern — Platzhalter (SVG)
      for (const path of mediaUrls) {
        await expect
          .poll(async () => mediaContentType(page, path), {
            timeout: 15_000,
            message: `SW liefert für ${path} nach Lock noch Bild-Bytes — MEDIA_KEY_CLEAR nicht zugestellt?`,
          })
          .toMatch(/svg/)
      }
    })

    await test.step("Re-Unlock in derselben SW-Generation: Push-Kanal liefert wieder Bytes", async () => {
      await ensureVaultUnlocked(page)
      for (const path of mediaUrls) {
        await expect
          .poll(async () => mediaContentType(page, path), {
            timeout: 15_000,
            message: `SW liefert für ${path} nach Re-Unlock keine Bytes — MEDIA_KEY-Push nicht zugestellt?`,
          })
          .toMatch(/^image\/(?!svg)/)
      }
      await page.context().setOffline(false)
    })

    await test.step("Aufräumen: Unpin (seit Pin-Sync 23.08. ist der Pin SERVER-Zustand — ohne Unpin adoptiert ihn jeder spätere Test-Context)", async () => {
      // Der Offline-Reload in Schritt 3 lief über den '/'-Shell-Fallback des
      // SW — die Seite steht seitdem auf der Timeline. Detail frisch öffnen.
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)
      await openEntryByMarker(page, marker, undefined, 15_000)
      await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 15_000 })

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

  test("HTTP-Cache-Leck geschlossen (Gerätetest §2, 23.08.): /media/ antwortet no-store; ungepinnt offline kommt NIE das Bild aus dem HTTP-Cache", async ({ page }) => {
    test.setTimeout(180_000)
    const marker = `http-cache-negativ ${Date.now()}`

    await test.step("Online: Eintrag mit Foto anlegen — NICHT pinnen", async () => {
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await page.goto("/")
      await page.waitForLoadState("networkidle")
      await ensureVaultUnlocked(page)

      await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
      await page.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(marker)
      await page.locator('input[type="file"]').setInputFiles({
        name: "http-cache-negativ.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await page.waitForResponse((r) => r.url().includes("/api/upload") && r.status() === 201, {
        timeout: 20_000,
      })
      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 5_000 })
    })

    let mediaUrls: string[] = []

    await test.step("Foto online ansehen (Kandidat für den HTTP-Cache) — Header ist private, no-store", async () => {
      await openEntryByMarker(page, marker, undefined, 10_000)
      await expect(page.getByRole("heading", { name: marker })).toBeVisible({ timeout: 10_000 })

      // Die /media/-URLs DIESES Eintrags deterministisch über die API beziehen
      // — ein DOM-weiter img-Scan würde auch Bilder anderer (z. B. gepinnter)
      // Einträge einsammeln, deren Antworten der SW aus dem verschlüsselten
      // Cache bedient (Marker cache-decrypt), und den Header-Beweis verfälschen.
      const search = await page.request.get(`/api/entries?q=${encodeURIComponent(marker)}&perPage=5`)
      expect(search.ok()).toBeTruthy()
      const searchData = (await search.json()) as { dateGroups: { entries: { id: string }[] }[] }
      const entryId = searchData.dateGroups.flatMap((g) => g.entries)[0]?.id
      expect(entryId).toBeTruthy()
      const detail = await page.request.get(`/api/entries/${entryId}`)
      expect(detail.ok()).toBeTruthy()
      const detailData = (await detail.json()) as {
        media: { filePath: string; thumbnailPath: string | null }[]
      }
      mediaUrls = detailData.media.flatMap((m) =>
        m.thumbnailPath ? [m.filePath, m.thumbnailPath] : [m.filePath]
      )
      expect(mediaUrls.length).toBeGreaterThan(0)

      for (const path of mediaUrls) {
        // Default-Cache-Modus: dieser Fetch DÜRFTE den HTTP-Cache füllen —
        // der Server verbietet es jetzt per Header. Deckt BEIDE
        // Auslieferungs-Schichten ab (Route + Nexts Static-Layer).
        const { cc, ct, all } = await mediaFetchDefault(page, path)
        expect(ct, `${path} → ${JSON.stringify(all)}`).toMatch(/^image\/(?!svg)/)
        expect(cc, `${path} → ${JSON.stringify(all)}`).toBe("private, no-store")
      }
    })

    await test.step("NEGATIVBEWEIS: offline liefert derselbe Fetch den Platzhalter — nicht das Bild aus dem HTTP-Cache", async () => {
      await page.context().setOffline(true)
      for (const path of mediaUrls) {
        const { ct } = await mediaFetchDefault(page, path)
        // Vor dem Fix kam hier image/png aus dem HTTP-Disk-Cache (Gerätetest
        // §2) — unverschlüsselt, am Verschlüsselungsmodell vorbei. Jetzt: SW-
        // Platzhalter, weil weder Pin-Cache noch HTTP-Cache das Foto halten.
        expect(ct).toContain("image/svg+xml")
        expect(ct).not.toMatch(/^image\/png/)
      }
      await page.context().setOffline(false)
    })
  })
})
