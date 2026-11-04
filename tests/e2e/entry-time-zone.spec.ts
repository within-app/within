/**
 * Zeitzone je Eintrag im echten Browser. Das Gerät steht in Tokio, die App-Zone
 * des Dev-Stacks ist Europe/Berlin: So fällt auf, wenn irgendwo die falsche der
 * drei Zonen benutzt wird. Nur synthetische Inhalte.
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

test.use({ timezoneId: "Asia/Tokyo" })

const MARKER = `e2e-zone-${Date.now()}`

async function openApp(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
  await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 15_000 })
}

async function firstJournalId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/journals")
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as Array<{ id: string }>)[0].id
}

async function createEntry(request: APIRequestContext, data: object): Promise<string> {
  const res = await request.post("/api/entries", { data: { journalId: await firstJournalId(request), starred: false, ...data } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { id: string }).id
}

test.describe("Zeitzone je Eintrag", () => {
  test("Eintrag aus Bangkok zeigt Bangkoks Tag und Uhrzeit, auch in der Zeitleiste", async ({ page, request }) => {
    const id = await createEntry(request, {
      text: `${MARKER} Bangkok`,
      createdAt: "2024-03-10T20:00:00.000Z", // Bangkok 11.03. 03:00, Berlin 10.03. 21:00, Tokio 11.03. 05:00
      timeZone: "Asia/Bangkok",
    })
    await page.goto(`/entry/${id}`)
    await ensureVaultUnlocked(page)
    await expect(page.getByText(/11\. März 2024.*03:00/)).toBeVisible({ timeout: 15_000 })
    const res = await request.get("/api/entries?date=2024-03-11")
    const groups = ((await res.json()) as { dateGroups: Array<{ date: string; entries: Array<{ id: string }> }> }).dateGroups
    expect(groups.map((g) => g.date)).toEqual(["2024-03-11"])
    expect(groups[0].entries.map((e) => e.id)).toContain(id)
  })

  test("Eintrag ohne Zone bleibt in der App-Zone, nicht in der des Geräts", async ({ page, request }) => {
    const id = await createEntry(request, { text: `${MARKER} ohne Zone`, createdAt: "2024-03-12T20:00:00.000Z" })
    await page.goto(`/entry/${id}`)
    await ensureVaultUnlocked(page)
    await expect(page.getByText(/12\. März 2024.*21:00/)).toBeVisible({ timeout: 15_000 })
  })

  test("Neuer Eintrag im Editor speichert die Zone des Geräts", async ({ page, request }) => {
    const text = `${MARKER} neu`
    await openApp(page)
    await page.click('button[title="Neuer Eintrag (⌘N)"]')
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })
    await textarea.fill(text)
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect.poll(async () => {
      const res = await request.get("/api/entries?perPage=50")
      const groups = ((await res.json()) as { dateGroups: Array<{ entries: Array<{ title: string; timeZone: string | null }> }> }).dateGroups
      return groups.flatMap((g) => g.entries).find((e) => e.title === text)?.timeZone
    }, { timeout: 20_000 }).toBe("Asia/Tokyo")
  })

  test("Bearbeiten ändert die Uhrzeit in der Zone des Eintrags und behält die Zone", async ({ page, request }) => {
    const id = await createEntry(request, {
      text: `${MARKER} bearbeiten`,
      createdAt: "2024-03-14T20:00:00.000Z",
      timeZone: "Asia/Bangkok",
    })
    await page.goto(`/entry/${id}/edit`)
    await ensureVaultUnlocked(page)
    const time = page.locator('input[type="time"]').first()
    await expect(time).toHaveValue("03:00", { timeout: 15_000 })
    await time.fill("04:30")
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect.poll(async () => {
      const entry = (await (await request.get(`/api/entries/${id}`)).json()) as { createdAt: string; timeZone: string }
      return `${entry.createdAt} ${entry.timeZone}`
    }, { timeout: 20_000 }).toBe("2024-03-14T21:30:00.000Z Asia/Bangkok")
  })
})
