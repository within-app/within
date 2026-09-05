/**
 * Visual regression — light and dark mode screenshots
 *
 * Captures the timeline viewport in both light and dark modes so QA can
 * confirm pixel-identical rendering across UI changes (AC6
 * and any future UI/design change with a visual AC).
 *
 * Usage:
 *   # First run — generate baselines:
 *   npm run test:e2e -- --update-snapshots
 *
 *   # Subsequent runs — compare against baselines:
 *   npm run test:e2e
 *
 * Snapshots are stored in tests/e2e/screenshots/ and should be committed
 * to the repo after the initial baseline capture.
 *
 * Requires:
 *   - E2E_BASE_URL pointing to a non-production within instance
 *   - E2E_PASSWORD set to the app login password
 */

import { test, expect } from "@playwright/test"
import { ensureEntries } from "./helpers/seed"
import { ensureVaultUnlocked } from "./helpers/vault"

// next-themes stores the theme choice in localStorage under this key
const THEME_STORAGE_KEY = "within-theme"

test.describe("Visual regression — light + dark mode", () => {
  let journalId: string

  test.beforeAll(async ({ request }) => {
    journalId = await ensureEntries(request, 100)
  })

  test("light mode — timeline viewport", async ({ page }) => {
    // Force light theme via localStorage before the page loads
    await page.addInitScript((key) => {
      localStorage.setItem(key, "light")
    }, THEME_STORAGE_KEY)

    await page.goto(`/?journal=${journalId}`)
    // Frisches Profil zeigt sonst das PIN-Overlay im Screenshot.
    await ensureVaultUnlocked(page)
    await page.waitForSelector('[data-testid="entry-card"]', { timeout: 15_000 })
    // Let layout stabilise
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot("timeline-light.png", {
      fullPage: false,
      // 1% pixel difference tolerance for antialiasing, font rendering variance
      maxDiffPixelRatio: 0.01,
    })
  })

  test("dark mode — timeline viewport", async ({ page }) => {
    // Force dark theme via localStorage before the page loads
    await page.addInitScript((key) => {
      localStorage.setItem(key, "dark")
    }, THEME_STORAGE_KEY)

    await page.goto(`/?journal=${journalId}`)
    // Frisches Profil zeigt sonst das PIN-Overlay im Screenshot.
    await ensureVaultUnlocked(page)
    await page.waitForSelector('[data-testid="entry-card"]', { timeout: 15_000 })
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot("timeline-dark.png", {
      fullPage: false,
      maxDiffPixelRatio: 0.01,
    })
  })
})
