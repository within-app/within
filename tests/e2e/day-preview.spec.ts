/**
 * Tages-Vorschau: ein Kalendertag mit 2+ Einträgen
 * rendert eine einzelne day-card statt je einer entry-card; ihr Klick öffnet
 * rechts die Tages-Vorschau (alle Einträge des Tages vollständig, nur Lesen)
 * mit einem „Öffnen"-Knopf je Eintrag in die normale Einzelansicht.
 *
 * Kalender-Weg: der Tipp auf einen
 * Kalendertag mit 2+ Einträgen öffnet dieselbe Tages-Vorschau rechts (nicht
 * mehr die Liste unter dem Raster); ein Tag mit genau einem Eintrag öffnet
 * weiter direkt die Einzelansicht; Escape führt zurück in den Kalender.
 *
 * Eigenes, frisches Journal: zwei Einträge am 15. und einer am 20. des
 * Vormonats — der Vormonat liegt immer im Kalender-Startfenster (3 Monate),
 * unabhängig vom Laufdatum. Der Monat ist der LOKALE Vormonat, weil der
 * Kalender seine Raster lokal datiert (calendar-view.tsx, `new Date()`);
 * 08:00Z/10:00Z/17:30Z liegen in jeder Zeitzone von UTC−8 bis UTC+6 am
 * selben Kalendertag wie der UTC-Schlüssel (`data-date`). Nur synthetische Inhalte.
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

const JOURNAL_NAME = "QA-Day-Preview"

// Lokaler Vormonat als YYYY-MM: Tag 1 setzen, dann einen Monat zurück.
const prevMonth = new Date()
prevMonth.setDate(1)
prevMonth.setMonth(prevMonth.getMonth() - 1)
const MONTH_KEY = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}`
/** Tag mit zwei Einträgen (UTC-Tagesschlüssel wie `data-date`). */
const DATE_KEY = `${MONTH_KEY}-15`
/** Tag mit genau einem Eintrag. */
const SOLO_DATE_KEY = `${MONTH_KEY}-20`

async function deleteJournalIfExists(request: APIRequestContext, name: string) {
  const res = await request.get("/api/journals")
  expect(res.ok()).toBeTruthy()
  const journals = (await res.json()) as Array<{ id: string; name: string }>
  const existing = journals.find((j) => j.name === name)
  if (existing) {
    const del = await request.delete(`/api/journals/${existing.id}`)
    expect(del.ok()).toBeTruthy()
  }
}

async function openApp(page: Page, journalId: string) {
  // Erste Navigation: SW installiert + claimt (einmaliger Reload); die zweite
  // startet mit stehendem Controller — Muster aus pin-sync-two-devices.spec.ts.
  await page.goto(`/?journal=${journalId}`)
  await page.waitForLoadState("networkidle")
  await page.goto(`/?journal=${journalId}`)
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
}

test.describe("Tages-Vorschau — 2 Einträge an einem Tag falten zu einer day-card", () => {
  // Vault-PIN-Setup/-Unlock (PBKDF2, 600k Iterationen) braucht mehr als das 30s-Default.
  test.describe.configure({ timeout: 60_000 })

  let journalId: string
  const rand = Date.now()
  const markerA = `QA-Day A ${rand}`
  const markerB = `QA-Day B ${rand}`
  const markerSolo = `QA-Day Solo ${rand}`
  const bodyA = `QA-Day A Fließtext ${rand}`
  const bodyB = `QA-Day B Fließtext ${rand}`

  test.beforeAll(async ({ request }) => {
    await deleteJournalIfExists(request, JOURNAL_NAME)

    const created = await request.post("/api/journals", {
      data: { name: JOURNAL_NAME, color: "#6B7280" },
    })
    expect(created.status()).toBe(201)
    journalId = ((await created.json()) as { id: string }).id

    for (const [text, createdAt] of [
      [`# ${markerA}\n${bodyA}`, `${DATE_KEY}T08:00:00.000Z`],
      [`# ${markerB}\n${bodyB}`, `${DATE_KEY}T17:30:00.000Z`],
      [`# ${markerSolo}\nQA-Day Solo Fließtext ${rand}`, `${SOLO_DATE_KEY}T10:00:00.000Z`],
    ] as const) {
      const res = await request.post("/api/entries", {
        data: { journalId, text, createdAt, photos: [] },
      })
      expect(res.ok()).toBeTruthy()
    }
  })

  test.afterAll(async ({ request }) => {
    if (journalId) await request.delete(`/api/journals/${journalId}`).catch(() => {})
  })

  test("day-card mit 2 Einträgen öffnet die Tages-Vorschau; Öffnen führt in die Einzelansicht; Escape führt zurück", async ({ page }) => {
    await openApp(page, journalId)

    const main = page.getByRole("main")
    const dayCard = main.locator(`[data-testid="day-card"][data-date="${DATE_KEY}"]`)
    await expect(dayCard).toHaveCount(1, { timeout: 15_000 })
    await expect(dayCard).toContainText("2 Einträge")
    // Der Solo-Tag bleibt eine gewöhnliche entry-card.
    await expect(main.locator('[data-testid="entry-card"]')).toHaveCount(1)

    await dayCard.click()

    const dayDetail = page.locator('[data-testid="day-detail"]')
    await expect(dayDetail).toBeVisible({ timeout: 10_000 })
    await expect(dayDetail.getByText(markerA)).toBeVisible()
    await expect(dayDetail.getByText(markerB)).toBeVisible()
    await expect(dayDetail.getByText(bodyA)).toBeVisible()
    await expect(dayDetail.getByText(bodyB)).toBeVisible()

    const openButtons = dayDetail.getByRole("button", { name: "Öffnen", exact: true })
    await expect(openButtons).toHaveCount(2)

    await openButtons.first().click()

    await expect(page.getByRole("button", { name: "Eintrag bearbeiten" })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("heading", { name: markerA })).toBeVisible()
    // Nicht page.getByText: die day-card links zeigt weiterhin beide Titel-Zeilen —
    // "nur EIN Marker-Titel sichtbar" gilt für die Einzelansicht, deren Titel ein
    // <h1> ist; die day-card-Zeilen tragen keine Heading-Rolle.
    await expect(page.getByRole("heading", { name: markerB })).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(dayDetail).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press("Escape")
    await expect(dayDetail).not.toBeVisible({ timeout: 10_000 })
  })

  test("Kalender: Tag mit 2 Einträgen öffnet die Tages-Vorschau rechts, Tag mit einem Eintrag die Einzelansicht; Escape führt in den Kalender", async ({ page }) => {
    await openApp(page, journalId)

    const main = page.getByRole("main")
    await main.getByRole("button", { name: "Kalender", exact: true }).click()
    // Raster neueste zuerst: Index 1 ist der Vormonat. getByRole schließt die
    // versteckten Raster des ViewChunkWarmers aus (calendar-lazy-months.spec.ts).
    const grids = main.getByRole("grid")
    await expect(grids).toHaveCount(3, { timeout: 20_000 })
    const prevMonthGrid = grids.nth(1)
    const dayDetail = page.locator('[data-testid="day-detail"]')
    const editButton = page.getByRole("button", { name: "Eintrag bearbeiten" })

    // Tag mit 2 Einträgen → Tages-Vorschau mit beiden Volltexten, Tag bleibt markiert.
    await prevMonthGrid.locator("button", { hasText: /^15$/ }).click()
    await expect(dayDetail).toBeVisible({ timeout: 10_000 })
    await expect(dayDetail.getByText(bodyA)).toBeVisible()
    await expect(dayDetail.getByText(bodyB)).toBeVisible()
    await expect(dayDetail.getByRole("button", { name: "Öffnen", exact: true })).toHaveCount(2)
    await expect(prevMonthGrid.locator('[aria-selected="true"]')).toHaveCount(1)
    // Keine Tagesliste mehr unter dem Raster: die alten Zeilen waren Knöpfe mit
    // dem Eintragstitel — die Vorschau rechts zeigt Titel als Überschrift.
    await expect(main.getByRole("button", { name: new RegExp(markerA) })).toHaveCount(0)

    // Öffnen → Einzelansicht; Escape → wieder Tages-Vorschau; Escape → Kalender ohne Auswahl.
    await dayDetail.getByRole("button", { name: "Öffnen", exact: true }).first().click()
    await expect(editButton).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("heading", { name: markerA })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dayDetail).toBeVisible({ timeout: 10_000 })
    await expect(editButton).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(dayDetail).not.toBeVisible({ timeout: 10_000 })
    await expect(grids).toHaveCount(3)
    await expect(prevMonthGrid.locator('[aria-selected="true"]')).toHaveCount(0)

    // Tag mit genau einem Eintrag → direkt die Einzelansicht, keine Vorschau.
    await prevMonthGrid.locator("button", { hasText: /^20$/ }).click()
    await expect(editButton).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("heading", { name: markerSolo })).toBeVisible()
    await expect(dayDetail).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(editButton).toHaveCount(0, { timeout: 10_000 })
    await expect(grids).toHaveCount(3)
  })
})
