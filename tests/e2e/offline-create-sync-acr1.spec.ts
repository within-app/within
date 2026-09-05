/**
 * case-r1/case-r2/case-r3 offline-sync repro tests.
 *
 * Run against http://localhost:4000 with the dev compose stack:
 *   docker compose -f docker-compose.dev.yml up
 *   E2E_BASE_URL=http://localhost:4000 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/offline-create-sync-acr1.spec.ts
 *
 *   case-r1: offline create → timeline shows pending entry immediately (F3 merged view)
 *          → online → entry in GET /api/entries AND queue empty.
 *   case-r2: offline create → offline edit (same IDB key) → online → exactly ONE final entry.
 *          Tests the IDB editQueue keyPath dedup: enqueueEdit with the same entryId
 *          replaces (IDB put/keyPath), never appends.
 *   case-r3: server upsert error → badge shows error state (F1).
 *
 * Persistenter Context pro Test (Muster offline-views.spec.ts) —
 * context.setOffline(true) allein greift bei einem kontrollierenden Service Worker
 * nicht zuverlässig, und der frische Vault braucht ohnehin ein eigenes Profil je Test.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureVaultUnlocked } from "./helpers/vault"
import { expectEntryInTimeline, openEntryByMarker } from "./helpers/timeline"
import { launchDevice, setDeviceOffline } from "./helpers/device"

// Marker-Bestandteile — die Ids selbst erzeugt die App, diese Konstanten
// tauchen nur noch im Text der Testeinträge auf (nicht als echte entryId).
const ACR1_ENTRY_ID = "ef000000-0000-4000-8000-000000001001"
const ACR2_ENTRY_ID = "ef000000-0000-4000-8000-000000001002"
const ACR3_ENTRY_ID = "ef000000-0000-4000-8000-000000001003"

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
}

/** Check whether the IDB editQueue is empty */
async function getQueueCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    return new Promise<number>((resolve, reject) => {
      // Versionslos öffnen (src/lib/sync/idb.ts Z. 26-32): eine feste
      // Version wirft VersionError/blockiert, sobald ein neueres Bundle die DB
      // schon hochgezogen hat.
      const req = indexedDB.open("within-sync")
      req.onsuccess = () => {
        const db  = req.result
        const txn = db.transaction("editQueue", "readonly")
        const cr  = txn.objectStore("editQueue").count()
        cr.onsuccess = () => { db.close(); resolve(cr.result) }
        cr.onerror   = () => { db.close(); reject(cr.error) }
      }
      req.onerror   = () => reject(req.error)
      req.onblocked = () => reject(new Error("indexedDB.open('within-sync') blocked"))
    })
  })
}

test.describe("case-r1 — offline create → online → appears in timeline and server", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-acr1-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("entry created offline appears in GET /api/entries after sync and in timeline without reload", async () => {
    test.setTimeout(120_000)
    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    await setDeviceOffline(page, true)

    // Create entry through the real editor UI
    await page.click('button[title="Neuer Eintrag (⌘N)"]')
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })

    const offlineText = `case-r1 offline create e2e-1678 ${ACR1_ENTRY_ID} ${Date.now()}`
    await textarea.fill(offlineText)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    // Confirm entry is in IDB queue
    const queueAfterSave = await getQueueCount(page)
    expect(queueAfterSave).toBeGreaterThanOrEqual(1)

    // case-r1 (part 1): timeline shows pending entry WITHOUT going online yet
    // Tages-Karte: landet der Eintrag in einer day-card statt einer
    // eigenen entry-card, reicht hier "irgendwie sichtbar" — geöffnet wird er nicht.
    await expectEntryInTimeline(page, offlineText, { timeout: 5_000 })

    // Go online → sync fires
    await setDeviceOffline(page, false)

    // Wait for sync push to succeed
    await page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )

    // case-r1 (part 2): queue must be empty after successful sync
    // Poll until queue drains (sync is async)
    await page.waitForFunction(
      async () => {
        return new Promise<boolean>((resolve, reject) => {
          const req = indexedDB.open("within-sync") // versionslos
          req.onsuccess = () => {
            const db  = req.result
            const txn = db.transaction("editQueue", "readonly")
            const cr  = txn.objectStore("editQueue").count()
            cr.onsuccess = () => { db.close(); resolve(cr.result === 0) }
            cr.onerror   = () => { db.close(); reject(cr.error) }
          }
          req.onerror   = () => reject(req.error)
          req.onblocked = () => reject(new Error("indexedDB.open('within-sync') blocked"))
        })
      },
      { timeout: 10_000 }
    )

    // case-r1 (part 3): entry must appear on the server — Volltextsuche statt
    // ungefiltertem GET /api/entries oder sync/changes Seite 1 (die Dev-DB hat
    // 1000+ Einträge, der frische Eintrag muss dort nicht auf Seite 1 liegen).
    const entriesRes = await device.request.get(
      `/api/entries?q=${encodeURIComponent(offlineText)}&perPage=5`
    )
    expect(entriesRes.status()).toBe(200)
    const body = (await entriesRes.json()) as { dateGroups: Array<{ entries: Array<{ id: string }> }> }
    const matches = body.dateGroups.flatMap((g) => g.entries)
    expect(matches).toHaveLength(1)

    // Exakter Text — /api/entries liefert nur previewText (gekürzt/bereinigt),
    // die Einzelansicht liefert den rohen Text.
    const entryRes = await device.request.get(`/api/entries/${matches[0].id}`)
    expect(entryRes.status()).toBe(200)
    const { text } = (await entryRes.json()) as { text: string }
    expect(text).toBe(offlineText)
  })
})

test.describe("case-r2 — offline create + offline edit → sync → ONE final entry", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-acr2-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("editQueue dedup: second enqueue for same entryId replaces first; server receives one entry", async () => {
    test.setTimeout(120_000)
    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    await setDeviceOffline(page, true)

    // STEP 1 — Create entry offline via UI
    await page.click('button[title="Neuer Eintrag (⌘N)"]')
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })

    const stamp = Date.now()
    const originalText = `case-r2 offline create e2e-1683 ${ACR2_ENTRY_ID} ${stamp}`
    await textarea.fill(originalText)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    expect(await getQueueCount(page)).toBeGreaterThanOrEqual(1)

    // STEP 2 — Offline bearbeiten: denselben Eintrag über den Marker öffnen,
    // Text ändern, speichern. Hinweis: App-geschriebene editQueue-Datensätze
    // sind verschlüsselt, nur der keyPath (entryId) liegt im rohen IDB-Datensatz
    // im Klartext — ein direkter payload.text-Zugriff auf den bestehenden
    // (App-verschlüsselten) Datensatz ist damit nicht mehr möglich. Ein von
    // außen roh eingereihter Klartext-Datensatz wäre zwar technisch lesbar (der
    // Adapter toleriert Klartext beim Lesen, encrypted-adapter.ts), träfe aber
    // nicht den echten enqueueEdit-Pfad, den das AC eigentlich prüfen soll. Das
    // AC ("zweites Enqueue für dieselbe entryId ersetzt das erste") lässt sich
    // daher nur über den echten UI-Fluss + beobachtbares Verhalten (Queue-Count,
    // Server-Ergebnis) belegen. Muster: offline-media-and-edit.spec.ts Fall 2.
    await openEntryByMarker(page, originalText)
    await page.getByRole("button", { name: "Eintrag bearbeiten" }).click()
    const editTextarea = page.locator("textarea").first()
    await expect(editTextarea).toBeVisible({ timeout: 10_000 })

    const finalText = `case-r2 offline edited e2e-1683 ${ACR2_ENTRY_ID} FINAL ${stamp}`
    await editTextarea.fill(finalText)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(editTextarea).not.toBeVisible({ timeout: 5_000 })

    // Queue muss weiterhin genau 1 Eintrag halten — keyPath-Dedup (put() statt
    // add()): das zweite Enqueue für dieselbe entryId ersetzt das erste.
    expect(await getQueueCount(page)).toBe(1)

    // STEP 3 — Go online → sync fires
    await setDeviceOffline(page, false)

    await page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )

    // Wait for the queue to drain
    await expect.poll(() => getQueueCount(page), { timeout: 10_000 }).toBe(0)

    // STEP 4 — Server muss genau EINEN Eintrag mit dem finalen Text halten,
    // gefunden über Volltextsuche (nicht über sync/changes-Pagination — die
    // Dev-DB hat 1000+ Einträge, und die entryId ist ohnehin app-generiert,
    // nicht ACR2_ENTRY_ID).
    const entriesRes = await device.request.get(
      `/api/entries?q=${encodeURIComponent(finalText)}&perPage=5`
    )
    expect(entriesRes.status()).toBe(200)
    const body = (await entriesRes.json()) as { dateGroups: Array<{ entries: Array<{ id: string }> }> }
    const matches = body.dateGroups.flatMap((g) => g.entries)
    expect(matches).toHaveLength(1)           // no duplicate

    const entryRes = await device.request.get(`/api/entries/${matches[0].id}`)
    expect(entryRes.status()).toBe(200)
    const { text } = (await entryRes.json()) as { text: string }
    expect(text).toBe(finalText)               // final edited text
  })
})

test.describe("case-r3 — server error → badge shows error state", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-acr3-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("when upsert returns 500, SyncBadge shows error indicator", async () => {
    test.setTimeout(120_000)
    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    await setDeviceOffline(page, true)

    // Create entry offline
    await page.click('button[title="Neuer Eintrag (⌘N)"]')
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })
    await textarea.fill(`case-r3 error test e2e-1678 ${ACR3_ENTRY_ID} ${Date.now()}`)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    // Intercept upsert to return 500
    await page.route("**/api/sync/upsert", (route) => route.fulfill({ status: 500, body: '{"error":"test error"}' }))

    await setDeviceOffline(page, false)

    // Wait for sync attempt
    await page.waitForRequest((req) => req.url().includes("/api/sync/upsert"), { timeout: 15_000 })

    // case-r3: SyncBadge must show an error indicator (AlertTriangle for sync errors)
    await expect(
      page.locator('[aria-label*="Fehler"], [aria-label*="fehler"], [aria-label*="error"]').first()
    ).toBeVisible({ timeout: 5_000 })

    // Cleanup: unroute so subsequent tests aren't affected
    await page.unroute("**/api/sync/upsert")
  })
})
