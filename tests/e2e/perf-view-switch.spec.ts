/**
 * Messwerkzeug (kein Gate): Zeit vom Tab-Tipp bis die Zielansicht sichtbar ist,
 * plus Long Tasks im Hauptthread, unter CDP-CPU-Drosselung als Handy-Proxy.
 * Entstanden bei der Kalender-Analyse (24-Monats-Mount).
 *
 * Opt-in: PERF=1 E2E_BASE_URL=… E2E_PASSWORD=… npx playwright test tests/e2e/perf-view-switch.spec.ts
 * Ohne PERF wird die Spec übersprungen — sie misst, sie prüft nicht.
 *
 * Tagestipp (Kalender → Tages-Vorschau rechts): der Tipp lädt
 * erst den Tag (ein Request) und öffnet dann Vorschau oder Einzelansicht — die
 * Zahl enthält damit einen Roundtrip, ältere Werte (Bottom-Panel, synchron)
 * sind nicht 1:1 vergleichbar. Ein leerer Tag öffnet nichts; die Spec legt sich
 * deshalb einen synthetischen Eintrag für heute an und räumt ihn wieder weg.
 */
import { test, expect, type Page } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

test.skip(process.env.PERF !== "1", "Messwerkzeug — nur mit PERF=1")

// day-card kommt mit dem parallelen Tages-Karten-PR (Tages-Karte statt Einzelkarten bei 2+ Einträgen)
const TIMELINE_READY = '[data-testid="entry-card"], [data-testid="day-card"]'
// div.grid matcht auch das Lade-Skeleton (nur divs) — erst img/button sind echte Medien-Kacheln.
const MEDIA_READY = "div.grid :is(img, button)"
// Tagestipp: die Tages-Vorschau rechts (day-detail — seit 04.09.2026 auch aus dem
// Kalender, statt der Liste unter dem Raster) ODER die Einzelansicht, denn ein Tag
// mit genau einem Eintrag öffnet ihn direkt. Beides zählt als „Antwort auf den Tipp".
const DAY_PANEL_READY =
  ':is([data-testid="day-detail"], button[aria-label="Eintrag bearbeiten"], button[aria-label="Edit entry"])'

async function openApp(page: Page) {
  // Erste Navigation: SW installiert + claimt (einmaliger Reload); die zweite
  // startet mit stehendem Controller (Muster pin-sync-two-devices.spec.ts).
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)
}

function installLongTaskScript() {
  const w = window as unknown as { __lt: number[] }
  w.__lt = []
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(Math.round(e.duration))))
      .observe({ type: "longtask" })
  } catch { /* longtask unsupported */ }
}
async function installLongTaskObserver(page: Page) {
  // addInitScript läuft bei jeder künftigen Navigation neu an — überlebt
  // damit einen SW-Claim- oder sonstigen Reload mitten in der Messung, den
  // ein reines evaluate() (nur im aktuell geladenen Dokument) verlieren
  // würde. Wirkt aber erst ab der nächsten Navigation, deshalb zusätzlich
  // einmal sofort für das bereits geladene Dokument.
  await page.addInitScript(installLongTaskScript)
  await page.evaluate(installLongTaskScript)
}
const takeLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __lt: number[] }
    const v = w.__lt ?? []
    w.__lt = []
    return v
  })

async function measure(page: Page, act: () => Promise<void>, readySel: string) {
  const main = page.getByRole("main")
  await takeLongTasks(page)
  const t0 = Date.now()
  await act()
  await main.locator(readySel).first().waitFor({ state: "visible", timeout: 60_000 })
  const ms = Date.now() - t0
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const lt = await takeLongTasks(page)
  return `${ms} ms · longtasks ${lt.length}${lt.length ? ` (max ${Math.max(...lt)}, Σ ${lt.reduce((a, b) => a + b, 0)})` : ""}`
}

async function tap(page: Page, tab: string, readySel: string) {
  const main = page.getByRole("main")
  return measure(page, () => main.getByRole("button", { name: tab, exact: true }).click(), readySel)
}

async function tapToday(page: Page) {
  // Einzelansicht und Tages-Vorschau überleben einen Tab-Wechsel (App-Shell
  // bleibt gemountet) — ab dem zweiten Durchlauf wäre DAY_PANEL_READY sonst
  // schon erfüllt, bevor der Tipp überhaupt passiert, und misst nur die
  // Klick-Latenz statt den echten Tagestipp. Escape räumt erst den Eintrag,
  // dann den Tag weg (waitFor "hidden" ist sofort erfüllt, wenn nie offen).
  await page.keyboard.press("Escape")
  await page.locator('button[aria-label="Eintrag bearbeiten"]').waitFor({ state: "hidden", timeout: 5_000 })
  await page.keyboard.press("Escape")
  await page.locator('[data-testid="day-detail"]').waitFor({ state: "hidden", timeout: 5_000 })
  const main = page.getByRole("main")
  const dayNum = String(new Date().getDate())
  return measure(
    page,
    () => main.locator('[role="grid"] button', { hasText: new RegExp(`^${dayNum}$`) }).first().click(),
    DAY_PANEL_READY
  )
}

let todayEntryId: string | null = null
test.beforeAll(async ({ request }) => {
  const journals = await request.get("/api/journals")
  const first = ((await journals.json()) as Array<{ id: string }>)[0]
  if (!first) return
  const res = await request.post("/api/entries", {
    data: { journalId: first.id, text: `perf-view-switch heute ${Date.now()}`, photos: [] },
  })
  if (res.ok()) todayEntryId = ((await res.json()) as { id: string }).id
})
test.afterAll(async ({ request }) => {
  if (todayEntryId) await request.delete(`/api/entries/${todayEntryId}`).catch(() => {})
})

test("Ansichtswechsel: Kalender / Medien / Timeline unter CPU-Drosselung", async ({ page }) => {
  test.setTimeout(300_000)
  const cdp = await page.context().newCDPSession(page)
  await openApp(page)
  await page.getByRole("main").locator(TIMELINE_READY).first().waitFor({ timeout: 30_000 })
  await installLongTaskObserver(page)

  // Warmup ungemessen: Chunks laden, SW-Claim-Reload abwarten
  await tap(page, "Kalender", '[role="grid"]')
  await tap(page, "Timeline", TIMELINE_READY)
  await tap(page, "Medien", MEDIA_READY)
  await tap(page, "Timeline", TIMELINE_READY)
  await page.waitForTimeout(20_000)

  const lines: string[] = []
  for (const rate of [4, 6]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate })
    for (let i = 1; i <= 3; i++) {
      const k = await tap(page, "Kalender", '[role="grid"]')
      const grids = await page.getByRole("main").locator('[role="grid"]').count()
      const d = await tapToday(page)
      await tap(page, "Timeline", TIMELINE_READY)
      const m = await tap(page, "Medien", MEDIA_READY)
      const t = await tap(page, "Timeline", TIMELINE_READY)
      lines.push(`CPU ${rate}× #${i} | Kalender ${k} [${grids} Monate im DOM] | Tagestipp ${d} | Medien ${m} | Timeline ${t}`)
    }
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  console.log(lines.join("\n"))
  expect(lines).toHaveLength(6)
})
