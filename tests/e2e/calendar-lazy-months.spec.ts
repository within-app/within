/**
 * Kalender-Lazy-Monatsfenster: Startfenster 3 Monate, weitere
 * Monate kommen per Sentinel-Button ("Frühere Monate") oder Scrollen nach,
 * gedeckelt bei MAX_MONTHS (24). Der Knopf bleibt bei MAX_MONTHS gemountet
 * (disabled statt entfernt) — Fokus geht nie verloren.
 *
 * Bestätigter Review-Fund: sobald der Sentinel ins Bild scrollt, lädt der
 * IntersectionObserver selbst nach und schiebt ihn weiter — ein Pointer-Klick
 * trifft ihn praktisch nie. Diese Probe klickt ihn deshalb bewusst NICHT,
 * sondern prüft beide echten Wege: Scrollen (Observer) und Tastatur
 * (focus() + Enter). Nur ≥-Vergleiche außer beim initialen Stand, weil
 * focus() selbst schon einen Observer-Schritt auslösen kann, bevor Enter
 * gedrückt wird (Doppelschritt, siehe calendar-view.tsx-Kommentar).
 *
 * main.getByRole("grid") statt locator('[role="grid"]'): Rollen-Selektoren
 * schließen versteckte Elemente aus — der ViewChunkWarmer hält andere
 * Ansichten (inkl. Kalender) im Hintergrund vorgewärmt, deren Grids ein
 * reiner CSS-Selektor sonst mitzählen würde.
 *
 * Nur synthetische Inhalte — reine DOM-Zählung, keine Datenannahmen.
 */
import { test, expect } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"

test("Kalender lädt Monate lazy: 3 initial, Scroll- und Tastatur-Nachladen", async ({ page }) => {
  // Erste Navigation: SW installiert + claimt (einmaliger Reload); die zweite
  // startet mit stehendem Controller.
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await ensureVaultUnlocked(page)

  const main = page.getByRole("main")
  await main.getByRole("button", { name: "Kalender" }).click()

  await expect(main.getByRole("grid")).toHaveCount(3, { timeout: 20_000 })

  const sentinel = main.getByRole("button", { name: "Frühere Monate" })

  // Scroll-Pfad: der Observer beobachtet denselben Knopf weiter.
  await sentinel.scrollIntoViewIfNeeded()
  await expect(async () => {
    expect(await main.getByRole("grid").count()).toBeGreaterThanOrEqual(6)
  }).toPass({ timeout: 10_000 })

  // Tastatur-Pfad: focus() scrollt ggf. selbst schon nach (Observer), Enter
  // lädt garantiert einen weiteren Schritt — deshalb ≥ 9, nicht = 9.
  await sentinel.focus()
  await page.keyboard.press("Enter")
  await expect(async () => {
    expect(await main.getByRole("grid").count()).toBeGreaterThanOrEqual(9)
  }).toPass({ timeout: 10_000 })
})
