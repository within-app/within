/**
 * Wartende Medien in der Eintragsansicht, und alle Medien
 * unter dem Text.
 *
 * Gegen den lokalen Dev-Stack laufen lassen:
 *   WITHIN_DEV_PORT=4010 WITHIN_DEV_DB_PORT=5442 \
 *     docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build -d
 *   E2E_BASE_URL=http://localhost:4010 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/offline-media-preview.spec.ts
 *
 *   Fall 1: Offline ein Foto an einen NEUEN Eintrag hängen → in der Eintragsansicht
 *         sichtbar und als "wartet" erkennbar.
 *   Fall 2: Dasselbe an einem BESTEHENDEN Eintrag → die schon hochgeladenen Fotos
 *         verschwinden dabei nicht.
 *   Fall 3: Beides nach einem Kaltstart im Offline-Zustand.
 *   Fall 4: Nach dem Reconnect ersetzt die Server-Version die lokale Vorschau,
 *         ohne Dubletten.
 *   Fall 5: Kein Bild oberhalb von Titel und Text.
 *
 * Stolperdraht — zwei Rate-Limiter in src/proxy.ts kosten sonst eine Debug-Runde,
 * weil beide wie Produktfehler aussehen:
 *   - RATE_LIMIT_API_MAX (Default 60/min/IP): /api/sync/upsert bekommt 429. Weil
 *     der Medien-Flush erst nach dem Entry-Push läuft, bleibt das Foto im
 *     Wartekorb und Fall 1 läuft in den Timeout — nicht in eine Assertion.
 *   - RATE_LIMIT_LOGIN_MAX (Default 5/min/IP): Fall 3 loggt sich für seinen eigenen
 *     Kaltstart-Kontext selbst ein und scheitert bei expect(login.ok()).
 * Für lokale Serienläufe (mehrere Specs, --repeat-each) beide in .env.localdev
 * hochsetzen und den app-Container neu starten. Verifiziert: 21/21 grün über drei
 * Durchläufe beider Offline-Specs, 12 Fehler ohne die Anhebung.
 *
 * Nur synthetische Inhalte.
 */

import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test"
import { openCardByMarker, openEntryByMarker, TIMELINE_CARD, utcDateKey } from "./helpers/timeline"
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

/** Die Karte mit diesem Text anklicken und auf die Detailansicht warten. */
async function openEntryCard(page: Page, marker: string) {
  // Tages-Karte: entry-card nur, wenn der Eintrag allein an seinem
  // Tag steht — sonst über die Tages-Vorschau (openEntryByMarker deckt beides ab).
  await openEntryByMarker(page, marker, undefined, 10_000)
}

/** Fotos in der Detail-Galerie (die Lightbox-Trigger, nicht die Preload-Bilder). */
function galleryPhotos(page: Page) {
  return page.getByRole("button", { name: /^Foto \d+ von \d+ öffnen/ })
}

/**
 * Ein synthetischer Eintrag mit einem bereits hochgeladenen Foto — über die API,
 * weil der Seed bewusst keine Medien enthält.
 */
async function createEntryWithPhoto(
  request: APIRequestContext,
  journalId: string,
  text: string
): Promise<string> {
  const created = await request.post("/api/entries", {
    data: { text, journalId, starred: false, tags: [] },
  })
  expect(created.ok()).toBeTruthy()
  const { id } = (await created.json()) as { id: string }

  const uploaded = await request.post(`/api/upload?entryId=${id}`, {
    multipart: {
      file: { name: "synthetic-uploaded.png", mimeType: "image/png", buffer: PNG_1PX },
    },
  })
  expect(uploaded.status()).toBe(201)
  // Ohne `id` wurde die Datei geschrieben, aber keine media-Zeile — dann prüft der
  // Test nicht, was er prüfen soll.
  expect((await uploaded.json()).id).toBeTruthy()
  return id
}

async function firstJournalId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/journals")
  expect(res.ok()).toBeTruthy()
  const journals = (await res.json()) as Array<{ id: string }>
  expect(journals.length).toBeGreaterThan(0)
  return journals[0].id
}

async function photoCountOnServer(request: APIRequestContext, entryId: string): Promise<number> {
  const res = await request.get(`/api/entries/${entryId}`)
  expect(res.ok()).toBeTruthy()
  const entry = (await res.json()) as { media: Array<{ type: string }> }
  return entry.media.filter((m) => m.type === "photo").length
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

/**
 * Zwischen Upload-201 und deleteOutboxMedia zeigt die Ansicht legitim
 * Server-Foto UND Pending-Foto. Ein Reload in diesem Fenster ließe die
 * Dubletten-Prüfung fälschlich rot werden — erst warten, bis der Korb leer ist.
 */
async function waitForEmptyOutbox(page: Page) {
  await expect
    .poll(() => outboxCount(page), {
      timeout: 30_000,
      message: "mediaOutbox wurde nach dem Reconnect nicht geleert",
    })
    .toBe(0)
}

test.describe("Fall 1 — wartendes Foto an einem neuen Eintrag", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-media-preview-ac1-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("das offline angehängte Foto ist in der Eintragsansicht sichtbar", async () => {
    test.setTimeout(120_000)
    const marker = `e2e-1732 neuer Eintrag ${Date.now()}`

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
    await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 5_000 })

    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    // Auch die Timeline-Karte zeigt das wartende Foto (Thumbnail aus
    // lokaler blob:-URL) — beide applyPendingMediaToGroups-Aufrufe entfernen
    // ließ vorher jeden Test grün. Nur prüfbar, wenn der Eintrag (noch) allein
    // an seinem Tag steht (eigene entry-card): teilt er sich den Tag (U2,
    // day-card), zeigt die Karte nur das erste Foto DES TAGES, nicht
    // zwingend das wartende — die Einzelansicht unten ist dafür die
    // verlässliche Prüfung. isVisible() wartet nicht und lief bisher direkt
    // nach dem Editor-Schließen — praktisch immer false, der Guard griff also
    // nie. Stattdessen gezielt auf entry-card ODER day-card warten (Muster
    // helpers/timeline.ts isVisibleWithin).
    const ownCard = page.getByRole("main").locator('[data-testid="entry-card"]', { hasText: marker }).first()
    const dayCard = page
      .getByRole("main")
      .locator(`[data-testid="day-card"][data-date="${utcDateKey()}"]`)
      .first()
    const ownCardVisible = await ownCard
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (ownCardVisible) {
      await expect(ownCard.locator("img").first()).toHaveAttribute("src", /^blob:/, {
        timeout: 10_000,
      })
    } else {
      // Eintrag in einer day-card gefaltet — die Karte zeigt dann nur das erste
      // Foto DES TAGES, nicht zwingend das wartende. Nur nachweisen, dass die
      // day-card überhaupt da ist; der verlässliche Beweis kommt unten aus der
      // Einzelansicht (openEntryCard → galleryPhotos).
      await expect(dayCard).toBeVisible({ timeout: 10_000 })
    }

    // Rot auf main: die Detailansicht bekam media: [] und zeigte gar nichts.
    await openEntryCard(page, marker)
    await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 10_000 })

    // Die Vorschau kommt aus einem lokalen Object-URL, nicht vom Server …
    const src = await galleryPhotos(page).first().locator("img").getAttribute("src")
    expect(src).toMatch(/^blob:/)
    // Das Attribut allein genügt nicht — eine bereits revokte blob:-URL
    // trüge dieselbe src, wäre aber nie dekodiert. naturalWidth belegt Pixel.
    await expect
      .poll(
        () =>
          galleryPhotos(page)
            .first()
            .locator("img")
            .evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
        { timeout: 10_000, message: "Pending-Vorschau wurde nie dekodiert (tote blob:-URL?)" }
      )
      .toBe(true)
    // … und ist als noch nicht hochgeladen gekennzeichnet, statt echt zu wirken.
    await expect(page.getByTitle(PENDING_BADGE)).toBeVisible()

    // Fall 4: nach dem Reconnect ersetzt die Server-Version die lokale Vorschau.
    // Den Listener VOR dem Reconnect registrieren — gewinnt der Flush
    // das Rennen, läuft waitForResponse sonst in einen leeren 30-s-Timeout.
    const uploadDone = page.waitForResponse(
      (r) => r.url().includes("/api/upload") && r.status() === 201,
      { timeout: 30_000 }
    )
    await setDeviceOffline(page, false)
    await uploadDone

    const entries = await device.request.get(`/api/entries?q=${encodeURIComponent(marker)}&perPage=5`)
    const data = (await entries.json()) as { dateGroups: Array<{ entries: Array<{ id: string }> }> }
    const entryId = data.dateGroups.flatMap((g) => g.entries)[0]?.id
    expect(entryId).toBeTruthy()
    expect(await photoCountOnServer(device.request, entryId)).toBe(1)

    await waitForEmptyOutbox(page)
    await page.reload()
    await ensureVaultUnlocked(page)
    await openEntryCard(page, marker)
    // Genau ein Foto — keine Dublette aus Wartekorb + Server …
    await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 15_000 })
    // … und es kommt jetzt vom Server, ohne Wartet-Abzeichen.
    await expect(page.getByTitle(PENDING_BADGE)).toHaveCount(0)
    const serverSrc = await galleryPhotos(page).first().locator("img").getAttribute("src")
    expect(serverSrc).not.toMatch(/^blob:/)
  })
})

test.describe("Fall 2 — wartendes Foto an einem bestehenden Eintrag", () => {
  let dir: string
  let device: BrowserContext

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "within-media-preview-ac2-"))
  })

  test.afterAll(async () => {
    await device?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("das hochgeladene Foto bleibt sichtbar, das wartende kommt daneben", async () => {
    test.setTimeout(120_000)
    const marker = `e2e-1732 bestehender Eintrag ${Date.now()}`

    device = await launchDevice(dir)
    const journalId = await firstJournalId(device.request)
    const entryId = await createEntryWithPhoto(device.request, journalId, marker)
    expect(await photoCountOnServer(device.request, entryId)).toBe(1)

    const page = await device.newPage()
    await openApp(page)
    await openEntryCard(page, marker)
    await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 10_000 })

    await setDeviceOffline(page, true)
    await page.getByRole("button", { name: "Eintrag bearbeiten" }).click()
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 10_000 })

    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic-offline.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    })
    await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 5_000 })
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 10_000 })

    // Speichern schließt den Editor zurück in die Timeline (onClose/router.back)
    // — die Detailansicht muss danach erneut geöffnet werden (U2: ggf. jetzt
    // eine day-card, falls sich der Tag inzwischen mit anderen teilt).
    await openEntryCard(page, marker)

    // Offline gilt für Server-Zeilen weiter die Medien-Regel vom 22.08.: das
    // bereits hochgeladene Foto ist ungepinnt nicht sichtbar. Sichtbar bleibt
    // genau die wartende lokale Datei. Dass der Merge
    // die Server-Zeile nicht ERSETZT hat, beweist der Reconnect weiter unten
    // (dort stehen beide Fotos mit Server-Pfad).
    await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(page.getByTitle(PENDING_BADGE)).toHaveCount(1)

    const sources = await galleryPhotos(page).locator("img").evaluateAll(
      (imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src") ?? "")
    )
    expect(sources.filter((s) => s.startsWith("blob:"))).toHaveLength(1)
    expect(sources.filter((s) => s.startsWith("/"))).toHaveLength(0)

    // Fall 4 für den Bearbeitungsfall: nach dem Reconnect zwei Server-Fotos, keine Dublette.
    // Listener vor dem Reconnect registrieren (siehe Fall 1).
    const uploadDone = page.waitForResponse(
      (r) => r.url().includes("/api/upload") && r.status() === 201,
      { timeout: 30_000 }
    )
    await setDeviceOffline(page, false)
    await uploadDone
    await expect
      .poll(() => photoCountOnServer(device.request, entryId), {
        timeout: 30_000,
        message: "das wartende Foto ist nach dem Reconnect nicht am Eintrag angekommen",
      })
      .toBe(2)

    await waitForEmptyOutbox(page)
    await page.reload()
    await ensureVaultUnlocked(page)
    await openEntryCard(page, marker)
    await expect(galleryPhotos(page)).toHaveCount(2, { timeout: 15_000 })
    await expect(page.getByTitle(PENDING_BADGE)).toHaveCount(0)
  })
})

test.describe("404 online belebt keinen gelöschten Eintrag wieder", () => {
  test("serverseitig gelöschter Eintrag zeigt 'nicht gefunden' statt der IDB-Kopie", async ({ page, request }) => {
    const marker = `e2e-1732 gelöscht ${Date.now()}`
    const journalId = await firstJournalId(request)
    const entryId = await createEntryWithPhoto(request, journalId, marker)

    await openApp(page)
    // Warten, bis der Sync-Pull den Eintrag in den IDB-Store gebracht hat —
    // erst dann existiert die Kopie, die der 404-Fallback wiederbeleben würde.
    // U1: der entries-Store ist verschlüsselt, nur der keyPath (id)
    // liegt im rohen IDB-Datensatz im Klartext — die entryId kennen wir schon
    // aus createEntryWithPhoto.
    await page.waitForFunction(
      async (id) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open("within-sync")
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const entries = await new Promise<Array<{ id: string }>>((resolve, reject) => {
          const gr = db.transaction("entries", "readonly").objectStore("entries").getAll()
          gr.onsuccess = () => resolve(gr.result as Array<{ id: string }>)
          gr.onerror = () => reject(gr.error)
        })
        db.close()
        return entries.some((e) => e.id === id)
      },
      entryId,
      { timeout: 20_000 }
    )

    // Auf "Gerät B" löschen — die Timeline hier ist noch stale und zeigt die Karte.
    const deleted = await request.delete(`/api/entries/${entryId}`)
    expect(deleted.ok()).toBeTruthy()

    // U2: robust gegen beide Layouts (entry-card/day-card) — openEntryByMarker
    // passt hier nicht, der Server liefert 404 statt des Editors.
    await openCardByMarker(page, marker)

    // Rot ohne Fix: der IDB-Fallback griff bei jedem !res.ok und zeigte den
    // gelöschten Eintrag samt gecachter Fotos, als wäre nichts passiert.
    await expect(page.getByText("Eintrag nicht gefunden")).toBeVisible({ timeout: 10_000 })
    await expect(galleryPhotos(page)).toHaveCount(0)
  })
})

test.describe("Fall 5 — alle Medien unter dem Text", () => {
  test("oberhalb von Titel und Text steht kein Bild mehr", async ({ page, request }) => {
    const marker = `# e2e-1733 Titel ${Date.now()}\n\nSynthetischer Fließtext.`
    const journalId = await firstJournalId(request)
    await createEntryWithPhoto(request, journalId, marker)

    await openApp(page)
    await openEntryCard(page, `e2e-1733 Titel`)

    const title = page.locator("article h1").first()
    await expect(title).toBeVisible({ timeout: 10_000 })
    await expect(galleryPhotos(page)).toHaveCount(1)

    // Dokumentreihenfolge ist das eigentliche Kriterium: das Bild muss NACH dem
    // Titel kommen. Rot auf main — dort stand das Hero-Bild davor.
    const titleIsBeforePhoto = await page.evaluate(() => {
      const heading = document.querySelector("article h1")
      const photo = document.querySelector('article button[aria-label^="Foto 1 von"]')
      if (!heading || !photo) return null
      // DOCUMENT_POSITION_FOLLOWING = 4 → photo steht nach heading.
      return Boolean(heading.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(titleIsBeforePhoto).toBe(true)

    // Und geometrisch: kein Bild oberhalb der Titelzeile.
    const titleBox = await title.boundingBox()
    const photoBox = await galleryPhotos(page).first().boundingBox()
    expect(titleBox).not.toBeNull()
    expect(photoBox).not.toBeNull()
    expect(photoBox!.y).toBeGreaterThan(titleBox!.y)
  })
})

test.describe("Fall 3 — Kaltstart im Offline-Zustand", () => {
  // Der Fall, der die Fehler zuletzt zutage gefördert hat: App beendet, Gerät
  // offline, App neu geöffnet — Shell aus dem Service-Worker-Cache, Daten aus
  // IndexedDB, kein einziger erfolgreicher Netzwerk-Request.
  test("das wartende Foto ist auch nach einem Neustart ohne Netz sichtbar", async () => {
    test.slow()
    const profileDir = mkdtempSync(join(tmpdir(), "within-pending-"))
    const marker = `e2e-1732 Kaltstart ${Date.now()}`
    // Eintrag mit Server-Foto, dessen Detail in der Warm-Phase online
    // geöffnet wird — der entryMedia-Cache muss den Kaltstart im IDB überleben.
    const serverMarker = `e2e-1732 Kaltstart-Server ${Date.now()}`

    // ── Aufwärmen: einmal online, damit Shell und IDB gefüllt sind ───────────
    let ctx = await launchDevice(profileDir)
    let serverEntryId = ""
    try {
      const warm = await ctx.newPage()
      await warm.goto("/")
      await warm.waitForLoadState("networkidle")
      await ensureVaultUnlocked(warm)
      await warm.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })
      await warm.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {
        timeout: 20_000,
      })
      await warm.waitForFunction(
        async () => {
          // Versionslos öffnen — eine feste Version wirft VersionError,
          // sobald ein neueres Bundle die DB schon hochgezogen hat.
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
        },
        null,
        { timeout: 20_000 }
      )

      // Server-Foto-Eintrag anlegen, per Reload in den IDB-Sync holen
      // und das Detail EINMAL online öffnen — das befüllt den entryMedia-Cache,
      // dessen Kaltstart-Persistenz die Offline-Phase unten nachweist.
      const journalId = await firstJournalId(ctx.request)
      serverEntryId = await createEntryWithPhoto(ctx.request, journalId, serverMarker)
      // Nach der Medien-Regel zeigt die Einzelansicht offline nur bei
      // GEPINNTEN Einträgen ihre Server-Fotos — dieser Test prüft den entryMedia-Cache
      // über den Kaltstart und braucht deshalb einen gepinnten Eintrag.
      // Serverseitig pinnen, BEVOR die Warm-Phase das Detail öffnet: ein Pin
      // danach bumpt updated_at, und ohne Invalidierungs-Guard verwirft der
      // nächste Pull genau den Cache, den diese Probe nachweisen soll.
      const pinRes = await ctx.request.put(`/api/entries/${serverEntryId}/pin`, {
        data: { pinned: true },
      })
      expect(pinRes.ok()).toBeTruthy()
      await warm.reload()
      await ensureVaultUnlocked(warm)
      await warm.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })
      await openEntryCard(warm, serverMarker)
      await expect(galleryPhotos(warm)).toHaveCount(1, { timeout: 10_000 })
      // Der Sync-Pull muss den Eintrag in den IDB-entries-Store gebracht haben,
      // sonst prüft die Offline-Phase nur den Netz-Cache statt des IDB-Pfads.
      // U1: der entries-Store ist verschlüsselt, nur der keyPath
      // (id) liegt im rohen IDB-Datensatz im Klartext.
      await warm.waitForFunction(
        async (id) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open("within-sync")
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
          const entries = await new Promise<Array<{ id: string }>>((resolve, reject) => {
            const gr = db.transaction("entries", "readonly").objectStore("entries").getAll()
            gr.onsuccess = () => resolve(gr.result as Array<{ id: string }>)
            gr.onerror = () => reject(gr.error)
          })
          db.close()
          return entries.some((e) => e.id === id)
        },
        serverEntryId,
        { timeout: 20_000 }
      )
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

      await page.click('button[title="Neuer Eintrag (⌘N)"]')
      const textarea = page.locator("textarea").first()
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await textarea.fill(marker)
      await page.locator('input[type="file"]').setInputFiles({
        name: "synthetic.png",
        mimeType: "image/png",
        buffer: PNG_1PX,
      })
      await expect(page.getByTitle(PENDING_BADGE)).toBeVisible({ timeout: 10_000 })
      await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
      await expect(textarea).not.toBeVisible({ timeout: 10_000 })

      // Noch einmal neu laden — immer noch offline. Der Wartekorb überlebt den
      // Neustart, die Vorschau muss ihn also auch nach einem Reload finden.
      await page.reload()
      await ensureVaultUnlocked(page)
      await page.waitForSelector(TIMELINE_CARD, { timeout: 20_000 })
      await openEntryCard(page, marker)
      await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 15_000 })
      const src = await galleryPhotos(page).first().locator("img").getAttribute("src")
      expect(src).toMatch(/^blob:/)
      // Siehe Fall 1 — Dekodierung nachweisen, nicht nur das Attribut.
      await expect
        .poll(
          () =>
            galleryPhotos(page)
              .first()
              .locator("img")
              .evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
          { timeout: 10_000, message: "Pending-Vorschau wurde nie dekodiert (tote blob:-URL?)" }
        )
        .toBe(true)
      await expect(page.getByTitle(PENDING_BADGE)).toBeVisible()

      // Kaltstart-Persistenz des entryMedia-Caches — der online besuchte
      // und dort gepinnte Eintrag zeigt sein hochgeladenes Foto auch offline
      // nach Neustart, mit Server-Pfad-src (nicht blob:). Eine Regression
      // "Cache landet in einer In-Memory-Struktur/sessionStorage" bliebe sonst
      // unsichtbar. Ungepinnt wäre hier nach der Regel vom 22.08. nichts zu sehen.
      await page.reload()
      await ensureVaultUnlocked(page)
      await page.waitForSelector(TIMELINE_CARD, { timeout: 20_000 })
      await openEntryCard(page, serverMarker)
      await expect(galleryPhotos(page)).toHaveCount(1, { timeout: 15_000 })
      const serverSrc = await galleryPhotos(page).first().locator("img").getAttribute("src")
      expect(serverSrc).toMatch(/^\/media\//)
    } finally {
      // Der oben gepinnte Eintrag darf NICHT im geteilten Dev-Stack liegen
      // bleiben: Specs, die exakte Pin-Mengen prüfen (timeline-offline-filter,
      // pin-sync-two-devices, preview-mirror), werden davon rot. Löschen räumt
      // Eintrag und Pin in einem.
      if (serverEntryId) {
        await ctx.request
          .delete(`/api/entries/${serverEntryId}`)
          .catch(() => { /* Aufräumen darf den Test nicht kippen */ })
      }
      await ctx.close()
      rmSync(profileDir, { recursive: true, force: true })
    }
  })
})
