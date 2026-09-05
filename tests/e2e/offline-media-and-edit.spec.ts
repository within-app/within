/**
 * Die beiden verbliebenen Offline-Lücken.
 *
 * Gegen den lokalen Dev-Stack laufen lassen:
 *   WITHIN_DEV_PORT=4010 WITHIN_DEV_DB_PORT=5442 \
 *     docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build -d
 *   E2E_BASE_URL=http://localhost:4010 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/offline-media-and-edit.spec.ts
 *
 *   Fall 1: Offline ein Foto anhängen → sichtbare Vorschau, kein "Netzwerkfehler";
 *         nach dem Reconnect hängt die Datei am richtigen Eintrag.
 *   Fall 2: Offline einen bestehenden Eintrag bearbeiten und speichern → nach dem
 *         Reconnect steht die Änderung auf dem Server.
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type Page, type APIRequestContext, type BrowserContext } from "@playwright/test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TIMELINE_CARD, openEntryByMarker } from "./helpers/timeline"
import { ensureVaultUnlocked } from "./helpers/vault"
import { launchDevice, setDeviceOffline } from "./helpers/device"

/** 1×1-PNG — echtes Bild, damit sharp serverseitig nicht ablehnt. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

async function findEntryByText(request: APIRequestContext, text: string) {
  const res = await request.get(`/api/entries?q=${encodeURIComponent(text)}&perPage=5`)
  expect(res.ok()).toBeTruthy()
  const data = await res.json()
  return data.dateGroups.flatMap((g: { entries: unknown[] }) => g.entries) as Array<{
    id: string
    photoCount: number
  }>
}

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })
}

/**
 * Öffnet die erste Timeline-Karte, gleich ob entry-card oder day-card
 * (Tages-Karte) — landet in beiden Fällen in der
 * Einzelansicht mit Aktionen. Für Fall 3, das einen BELIEBIGEN bestehenden
 * Eintrag zum Bearbeiten braucht, keinen bestimmten Marker.
 */
async function openFirstEntry(page: Page) {
  const first = page.getByRole("main").locator(TIMELINE_CARD).first()
  await first.waitFor({ state: "visible", timeout: 15_000 })
  const isDayCard = (await first.getAttribute("data-testid")) === "day-card"
  await first.click()
  if (isDayCard) {
    await page.locator('[data-testid="day-detail"]').waitFor({ state: "visible", timeout: 10_000 })
    // exact: true — sonst matcht "Foto 1 von 1 öffnen" der Foto-Galerie per Substring mit.
    await page.getByRole("button", { name: "Öffnen", exact: true }).first().click()
  }
  await expect(page.getByRole("button", { name: "Eintrag bearbeiten" })).toBeVisible({ timeout: 10_000 })
}

async function firstJournalId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/journals")
  expect(res.ok()).toBeTruthy()
  const journals = (await res.json()) as Array<{ id: string }>
  expect(journals.length).toBeGreaterThan(0)
  return journals[0].id
}

/** Eigener Eintrag per API — bearbeitet ihn statt eines beliebigen
 *  bestehenden Eintrags in der geteilten Dev-DB (Muster createEntryWithPhoto,
 *  offline-media-preview.spec.ts). */
async function createEntry(request: APIRequestContext, journalId: string, text: string): Promise<string> {
  const res = await request.post("/api/entries", {
    data: { text, journalId, starred: false, tags: [] },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = (await res.json()) as { id: string }
  return id
}

test.describe("Fall 1 — Foto offline anhängen", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-ac1-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("Vorschau statt Netzwerkfehler, und nach dem Reconnect hängt das Bild am Eintrag", async () => {
    test.setTimeout(120_000)
    const marker = `e2e-1730 offline photo ${Date.now()}`

    device = await launchDevice(dir)
    const page = await device.newPage()

    await openApp(page)
    await setDeviceOffline(page, true)

    await page.click('button[title="Neuer Eintrag (⌘N)"]')
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })
    await textarea.fill(marker)

    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    })

    // Rot auf main: hier stand "Netzwerkfehler" und die Datei war verloren.
    await expect(page.getByText("Netzwerkfehler")).toHaveCount(0)
    await expect(page.getByTitle("Wird beim nächsten Online-Gang hochgeladen"))
      .toBeVisible({ timeout: 5_000 })

    // Die Vorschau kommt aus einem lokalen Object-URL, nicht vom Server.
    // U2: ".grid img" trifft zuerst eine (versteckt vorgeladene) Kachel des
    // ViewChunkWarmer-Medien-Grids — auf blob:-src scopen statt auf die Klasse.
    const previewSrc = await page.locator('img[src^="blob:"]').first().getAttribute("src")
    expect(previewSrc).toMatch(/^blob:/)

    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    await setDeviceOffline(page, false)
    await page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )
    // Medien laufen erst nach dem Entry-Push — sonst gäbe es eine Datei ohne Zeile.
    await page.waitForResponse(
      (r) => r.url().includes("/api/upload") && r.status() === 201,
      { timeout: 20_000 }
    )

    await expect.poll(
      async () => {
        const entries = await findEntryByText(device.request, marker)
        return entries[0]?.photoCount ?? 0
      },
      { timeout: 20_000, message: "Foto ist nach dem Reconnect nicht am Eintrag angekommen" }
    ).toBeGreaterThanOrEqual(1)
  })
})

test.describe("Fall 2 — bestehenden Eintrag offline bearbeiten", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-ac2-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("der Editor öffnet offline, statt in die Übersicht zurückzufallen", async () => {
    test.setTimeout(120_000)
    device = await launchDevice(dir)
    const page = await device.newPage()

    // Eigener Eintrag statt eines beliebigen bestehenden — sonst überschreibt
    // der Test den Text eines fremden Eintrags in der geteilten Dev-DB und
    // pusht das zum Server (Stack-Verschmutzung).
    const seedMarker = `e2e-1731 seed ${Date.now()}`
    const journalId = await firstJournalId(device.request)
    await createEntry(device.request, journalId, seedMarker)

    await openApp(page)
    await openEntryByMarker(page, seedMarker)

    await setDeviceOffline(page, true)
    await page.getByRole("button", { name: "Eintrag bearbeiten" }).click()

    // Rot auf main: /entry/<id>/edit ist nicht vorgecacht, der Service Worker
    // lieferte die '/'-Shell aus und man landete wieder in der Timeline.
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    expect(new URL(page.url()).pathname).toBe("/")

    const marker = `e2e-1731 offline edit ${Date.now()}`
    await textarea.fill(marker)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    await setDeviceOffline(page, false)
    await page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )

    await expect.poll(
      async () => (await findEntryByText(device.request, marker)).length,
      { timeout: 20_000, message: "Offline-Bearbeitung ist nicht auf dem Server angekommen" }
    ).toBeGreaterThanOrEqual(1)
  })
})

test.describe("Fall 3 — Kaltstart im Offline-Zustand", () => {
  // Der Fall, der die Fehler zuletzt zutage gefördert hat: App beendet, Gerät
  // offline, App neu geöffnet — Shell aus dem Service-Worker-Cache, Daten aus
  // IndexedDB, kein einziger erfolgreicher Netzwerk-Request.
  test("Bearbeiten und Foto-Anhang funktionieren auch nach Neustart ohne Netz", async () => {
    test.slow()
    const profileDir = mkdtempSync(join(tmpdir(), "within-cold-"))

    // ── Aufwärmen: einmal online, damit Shell und IDB gefüllt sind ───────────
    let ctx = await launchDevice(profileDir)
    try {
      const warm = await ctx.newPage()
      await warm.goto("/")
      await warm.waitForLoadState("networkidle")
      await ensureVaultUnlocked(warm)
      await warm.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })
      // Service Worker muss die Seite wirklich kontrollieren …
      await warm.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20_000 })
      // … und der erste Sync-Durchlauf die Einträge in IndexedDB geschrieben haben.
      await warm.waitForFunction(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open("within-sync")
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const count = await new Promise<number>((resolve, reject) => {
          const cr = db.transaction("entries", "readonly").objectStore("entries").count()
          cr.onsuccess = () => resolve(cr.result)
          cr.onerror = () => reject(cr.error)
        })
        db.close()
        return count > 0
      }, null, { timeout: 20_000 })
    } finally {
      await ctx.close()
    }

    // ── Kaltstart, Gerät offline ────────────────────────────────────────────
    ctx = await launchDevice(profileDir)
    // Vor der ersten Navigation blocken — sonst lädt der "Kaltstart" real online.
    await ctx.setOffline(true)
    try {
      const page = await ctx.newPage()
      await page.goto("/")
      // onLine-Stub für dieses Dokument nachziehen: das addInitScript läuft pro
      // Navigation neu und liest beim allerersten Laden noch kein "1" aus
      // localStorage (die Warm-Phase oben hat nie offline geschaltet) —
      // ctx.setOffline(true) allein flippt navigator.onLine nicht (device.ts).
      await setDeviceOffline(page, true)
      await ensureVaultUnlocked(page)
      await page.waitForSelector(TIMELINE_CARD, { timeout: 20_000 })

      // Bearbeiten
      await openFirstEntry(page)
      await page.getByRole("button", { name: "Eintrag bearbeiten" }).click()
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      expect(new URL(page.url()).pathname).toBe("/")

      // Foto anhängen
      await page.locator('input[type="file"]').setInputFiles({
        name: "synthetic.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await expect(page.getByText("Netzwerkfehler")).toHaveCount(0)
      await expect(page.getByTitle("Wird beim nächsten Online-Gang hochgeladen"))
        .toBeVisible({ timeout: 10_000 })

      const marker = `e2e-1730 cold start ${Date.now()}`
      await textarea.fill(marker)
      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 10_000 })

      // Zurück ins Netz + Reload — das entspricht dem, was am Gerät passiert: die
      // App wird mit Verbindung erneut geöffnet, und der Sync läuft beim Mount.
      // Warter vor dem Reload registrieren, sonst gewinnt der Sync das Rennen.
      const upsertDone = page.waitForResponse(
        (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
        { timeout: 30_000 }
      )
      const uploadDone = page.waitForResponse(
        (r) => r.url().includes("/api/upload") && r.status() === 201,
        { timeout: 30_000 }
      )
      await setDeviceOffline(page, false)
      await page.reload()
      // Sync läuft nur bei entsperrtem Vault — der Reload sperrt neu (DEK
      // nur im RAM), also vor den Response-Wartern entsperren, sonst flusht nichts.
      await ensureVaultUnlocked(page)
      await upsertDone
      await uploadDone

      await expect.poll(
        async () => {
          const res = await ctx.request.get(
            `/api/entries?q=${encodeURIComponent(marker)}&perPage=5`
          )
          const data = await res.json()
          const entries = data.dateGroups.flatMap((g: { entries: unknown[] }) => g.entries) as Array<{
            photoCount: number
          }>
          return entries[0]?.photoCount ?? 0
        },
        { timeout: 30_000, message: "Kaltstart-Foto ist nach dem Reconnect nicht angekommen" }
      ).toBeGreaterThanOrEqual(1)
    } finally {
      await ctx.close()
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})
