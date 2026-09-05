/**
 * Übersicht-Zahlen veraltet (Auftrag 2026-07-27).
 *
 * Gegen den lokalen Dev-Stack laufen lassen:
 *   WITHIN_DEV_PORT=4010 WITHIN_DEV_DB_PORT=5442 \
 *     docker compose -f docker-compose.dev.yml --env-file .env.localdev up --build -d
 *   E2E_BASE_URL=http://localhost:4010 E2E_PASSWORD=localtest \
 *     npx playwright test tests/e2e/overview-stale-stats.spec.ts
 *
 * AC: Eintrag löschen → die Zahlen der Übersicht sinken. Der Test löscht aus
 * der Detailansicht, während die Übersicht offen bleibt — das deckt beide
 * Ursachen ab: das fehlende deleted_at-Filter in /api/stats (Tombstone würde
 * weiter mitgezählt) und die fehlende Refresh-Verdrahtung (die offene Ansicht
 * bekäme den neuen Wert nicht mit, auch nicht mit korrektem Server).
 *
 * Nur synthetische Inhalte.
 */

import { test, expect, type APIRequestContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

async function createEntry(request: APIRequestContext, text: string): Promise<string> {
  const journalsRes = await request.get("/api/journals")
  expect(journalsRes.ok()).toBeTruthy()
  const journals = (await journalsRes.json()) as Array<{ id: string }>
  expect(journals.length).toBeGreaterThan(0)

  const res = await request.post("/api/entries", {
    data: { text, journalId: journals[0].id, photos: [], tags: [] },
  })
  expect(res.ok()).toBeTruthy()
  const { id } = (await res.json()) as { id: string }
  return id
}

test("Löschen senkt die Übersicht-Zahlen in der offenen Ansicht", async ({ page, request }) => {
  const marker = `Synthetic overview-stale ${Date.now()}`

  // Eintrag mit heutigem Datum → taucht in Einträge-Zahl und "An diesem Tag" auf.
  await createEntry(request, `${marker}\n\nSynthetischer Inhalt.`)

  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)

  // Übersicht öffnen und Ausgangszahl lesen.
  await page.getByRole("button", { name: "Übersicht" }).click()
  const main = page.getByRole("main")
  // Genau die StatCell-Kachel treffen: span und p sind direkte Kinder — ein
  // loses div:has(span) matcht auch alle äußeren Container. :visible schließt
  // die versteckte ViewChunkWarmer-Kopie aus (rendert bis zu 15s lang eine
  // zweite Übersicht in <main>, hidden aria-hidden) — robuster als auf ihr
  // Unmount zu warten, das nie auftritt, wenn der Warmer gar nicht mountet.
  const entriesCell = main
    .locator('div:visible:has(> span:text-is("Einträge"))')
    .locator("p")
  await expect(entriesCell).not.toBeEmpty()
  const before = parseInt((await entriesCell.innerText()).replace(/\./g, ""), 10)
  expect(before).toBeGreaterThanOrEqual(1)

  // "An diesem Tag" aufklappen — eine Vollbild-Lese-Ansicht statt
  // einer Liste; den synthetischen Eintrag über seinen Marker finden und über
  // dessen "Öffnen"-Knopf in die normale Detailansicht wechseln.
  await page.getByRole("button", { name: /An diesem Tag/ }).click()
  const onThisDayDialog = page.getByRole("dialog", { name: "An diesem Tag" })
  const entryArticle = onThisDayDialog.locator("article", { hasText: marker }).first()
  await expect(entryArticle).toBeVisible({ timeout: 10_000 })
  await entryArticle.getByRole("button", { name: "Öffnen", exact: true }).click()

  // "Öffnen" schließt die Lese-Ansicht selbst (history.back) und öffnet die
  // normale Detailansicht daneben — die Übersicht bleibt sichtbar/gemountet.
  await page.getByRole("button", { name: "Eintrag löschen" }).click()
  await page.getByRole("button", { name: "Löschen", exact: true }).click()

  // Ohne Tab-Wechsel und ohne Reload: Zahl sinkt.
  await expect(entriesCell).toHaveText(
    (before - 1).toLocaleString("de-DE"),
    { timeout: 10_000 }
  )

  // Zweiter, unabhängiger Nachweis pro Eintrag (nicht nur der Zähler): der
  // Marker darf nirgends mehr in der aktiven Ansicht auftauchen.
  await expect(main.getByText(marker.slice(0, 30))).toHaveCount(0, { timeout: 10_000 })
})
