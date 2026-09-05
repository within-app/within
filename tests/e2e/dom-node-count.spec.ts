/**
 * DOM node count bound for the virtualised timeline
 *
 * Proves that with ≥1000 entries in the dataset, the virtualiser
 * must keep the in-DOM entry-card count ≤ viewport-items + 2×overscan.
 *
 * Bounds (conservative, verified against timeline-view.tsx config):
 *   estimateSize=80px, overscan=5, viewport≈800px → max ~20 entry cards in DOM.
 *   We assert ≤ 50 to allow for variable item heights and measurement lag.
 *
 * Requires:
 *   - E2E_BASE_URL pointing to a non-production within instance
 *   - E2E_PASSWORD set to the app login password
 *   - At least 1000 synthetic entries (seeded automatically via /api/test/seed)
 */

import { test, expect } from "@playwright/test"
import { ensureEntries } from "./helpers/seed"
import { TIMELINE_CARD } from "./helpers/timeline"

// Tages-Karte (03.09.): der Seed-Endpunkt legt seitdem 1 Eintrag/UTC-Tag an
// (24h-Abstand, /api/test/seed) — die Karte bleibt eine entry-card. Ein VOR
// dem 03.09.2026 geseedetes QA-Synthetic-Journal (noch im 3h-Abstand, 8/Tag,
// nur noch day-card) muss einmalig gelöscht werden, siehe helpers/seed.ts.
// TIMELINE_CARD bleibt trotzdem die Union — robust, falls doch mal eine
// day-card im DOM landet, ändert nichts an ≤50/>0.
const ENTRY_CARD_SELECTOR = TIMELINE_CARD
// Conservative upper bound: viewport (≈10) + 2×overscan (10) + generous margin
const MAX_DOM_ENTRY_CARDS = 50

test.describe("Timeline virtualiser DOM node bounds", () => {
  let journalId: string

  test.beforeAll(async ({ request }) => {
    journalId = await ensureEntries(request, 1000)
  })

  test("≤50 entry-card nodes in DOM with ≥1000 entries at initial load", async ({ page }) => {
    // Navigate to the QA-Synthetic journal directly
    await page.goto(`/?journal=${journalId}`)

    // Wait for the virtualised list to render at least one card
    await page.waitForSelector(ENTRY_CARD_SELECTOR, { timeout: 15_000 })

    const cardCount = await page.locator(ENTRY_CARD_SELECTOR).count()

    expect(
      cardCount,
      `Expected ≤${MAX_DOM_ENTRY_CARDS} entry cards in DOM, got ${cardCount}. ` +
        "Virtualiser may not be active — check @tanstack/react-virtual integration."
    ).toBeLessThanOrEqual(MAX_DOM_ENTRY_CARDS)

    // Sanity: we must have at least 1 card rendered (list is not empty)
    expect(cardCount).toBeGreaterThan(0)
  })

  test("DOM card count stays bounded while scrolling", async ({ page }) => {
    await page.goto(`/?journal=${journalId}`)
    await page.waitForSelector(ENTRY_CARD_SELECTOR, { timeout: 15_000 })

    // Scroll down to the middle of the virtual list in steps, sampling each time
    const viewport = page.viewportSize()!
    const scrollSteps = 5

    for (let step = 0; step < scrollSteps; step++) {
      await page.mouse.wheel(0, viewport.height * 2)
      // Brief pause — virtualiser recalculates on scroll
      await page.waitForTimeout(300)

      const count = await page.locator(ENTRY_CARD_SELECTOR).count()
      expect(
        count,
        `DOM card count exceeded bound at scroll step ${step + 1}/${scrollSteps}: got ${count}`
      ).toBeLessThanOrEqual(MAX_DOM_ENTRY_CARDS)
    }
  })
})
