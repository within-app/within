/**
 * WIT — Timeline infinite scroll must load ALL pages, not just the first two.
 *
 * Real-world observation (2026-08-07, Pi prod): 66 entries across 2 journals,
 * "Alle Einträge" stopped rendering at exactly 50 entries (= 2 × perPage 25).
 * The oldest ~16 entries were unreachable no matter how far the user scrolled.
 *
 * Root-cause hypothesis under test: the infinite-scroll sentinel is a
 * VIRTUALIZED item (timeline-view.tsx, kind "sentinel") — it only exists in the
 * DOM while the list end is inside the virtualizer's overscan window. The
 * IntersectionObserver effect reads loaderRef.current only when its deps
 * ([hasNextPage, loadingMore, loading]) change; if the sentinel mounts later
 * (after scrolling), no effect re-runs, no observer is attached, and the next
 * page is never requested.
 *
 * These tests seed two synthetic journals (34 + 32 entries, mirroring the real
 * dataset) with dates in 2020 so they never collide with other QA data.
 * Synthetic data only — never real journal content.
 *
 * Invariant (product requirement): the timeline is ALWAYS complete — with a
 * journal filter it shows every entry of that journal, with "Alle Einträge"
 * every entry of every journal.
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { TIMELINE_CARD } from "./helpers/timeline"

const JOURNAL_A = "QA-Scroll-A" // 34 entries — A-01 (oldest) … A-34 (newest)
const JOURNAL_B = "QA-Scroll-B" // 32 entries — B-01 (oldest) … B-32 (newest)
const COUNT_A = 34
const COUNT_B = 32

// Tages-Karte (03.09.): jedes Fixture liegt schon einen Kalendertag vom
// nächsten entfernt (siehe entryDate) — gefiltert nach Journal bleibt jeder
// Eintrag eine eigene entry-card. In der ungefilterten "Alle Einträge"-Ansicht
// (A + B kombiniert) fielen A und B bei gleichem Start-Datum paarweise auf
// denselben Tag; B startet deshalb unten in einem eigenen, nicht
// überlappenden Datumsbereich. TIMELINE_CARD (Union) deckt trotzdem jede
// etwaige day-card ab, statt sich auf reine entry-cards zu verlassen.

/** Deterministic 2020 timestamps: index 1 = oldest. One day apart per journal. */
function entryDate(base: string, index: number): string {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + (index - 1))
  return d.toISOString()
}

/** Fires an API request, waiting out the per-IP rate-limit window once on 429. */
async function apiCall(
  request: APIRequestContext,
  method: "get" | "post" | "delete",
  url: string,
  data?: unknown
) {
  let res = await request[method](url, data === undefined ? undefined : { data })
  if (res.status() === 429) {
    const retryAfter = Number(res.headers()["retry-after"] ?? "60")
    await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000))
    res = await request[method](url, data === undefined ? undefined : { data })
  }
  return res
}

async function deleteJournalIfExists(request: APIRequestContext, name: string) {
  const res = await apiCall(request, "get", "/api/journals")
  if (!res.ok()) throw new Error(`GET /api/journals failed: ${res.status()}`)
  const journals = (await res.json()) as Array<{ id: string; name: string }>
  const existing = journals.find((j) => j.name === name)
  if (existing) {
    const del = await apiCall(request, "delete", `/api/journals/${existing.id}`)
    if (!del.ok()) throw new Error(`DELETE journal ${name} failed: ${del.status()}`)
  }
}

async function createJournalWithEntries(
  request: APIRequestContext,
  name: string,
  prefix: string,
  count: number,
  baseDate: string
): Promise<string> {
  const created = await apiCall(request, "post", "/api/journals", { name, color: "#6B7280" })
  if (created.status() !== 201) {
    throw new Error(`POST /api/journals (${name}) failed: ${created.status()}`)
  }
  const { id } = (await created.json()) as { id: string }

  // Seeding 66 entries crosses the per-IP API rate limit (default 60/min) —
  // apiCall honours Retry-After instead of requiring env overrides.
  for (let i = 1; i <= count; i++) {
    const num = String(i).padStart(2, "0")
    const res = await apiCall(request, "post", "/api/entries", {
      journalId: id,
      text: `QA-Scroll ${prefix}-${num} — synthetic infinite-scroll fixture, safe to delete`,
      createdAt: entryDate(baseDate, i),
      photos: [],
    })
    if (!res.ok()) {
      throw new Error(`POST /api/entries (${prefix}-${num}) failed: ${res.status()}`)
    }
  }
  return id
}

/** Scrolls the timeline's Radix viewport (the one containing timeline cards — entry or day) to its bottom. */
async function scrollTimelineToBottom(page: Page) {
  await page.evaluate((cardSelector) => {
    const viewports = Array.from(
      document.querySelectorAll<HTMLElement>("[data-radix-scroll-area-viewport]")
    )
    const timeline = viewports.find((v) => v.querySelector(cardSelector))
    if (timeline) timeline.scrollTop = timeline.scrollHeight
  }, TIMELINE_CARD)
}

/**
 * Watches /api/entries responses for 429s so scroll loops can wait out the
 * per-IP rate-limit window instead of failing while the API is blocked.
 * Returns the ms until requests are allowed again (0 = not blocked).
 */
function installRateLimitWatch(page: Page): () => number {
  let blockedUntil = 0
  page.on("response", (res) => {
    const url = new URL(res.url())
    if (url.pathname === "/api/entries" && res.status() === 429) {
      const retryAfter = Number(res.headers()["retry-after"] ?? "5")
      blockedUntil = Math.max(blockedUntil, Date.now() + (retryAfter + 1) * 1000)
    }
  })
  return () => Math.max(0, blockedUntil - Date.now())
}

/**
 * Scrolls to the bottom repeatedly (infinite scroll needs one fetch round-trip
 * per page) until `text` is rendered or `maxRounds` is exhausted.
 */
async function scrollUntilVisible(page: Page, text: string, maxRounds: number): Promise<boolean> {
  const blockedFor = installRateLimitWatch(page)
  for (let round = 0; round < maxRounds; round++) {
    if ((await page.getByText(text).count()) > 0) return true
    const wait = blockedFor()
    if (wait > 0) await page.waitForTimeout(wait)
    await scrollTimelineToBottom(page)
    await page.waitForTimeout(500)
  }
  return (await page.getByText(text).count()) > 0
}

test.describe("Timeline infinite scroll — completeness across page boundaries", () => {
  let journalAId: string
  let journalBId: string

  // Scroll loops may sit out a full rate-limit window (60 s) — the 30 s
  // default test timeout would abort mid-wait.
  test.beforeEach(() => {
    test.setTimeout(180_000)
  })

  test.beforeAll(async ({ request }) => {
    // Seeding 66 entries + up to two Retry-After waits needs more than the 30 s hook default.
    test.setTimeout(360_000)
    // Idempotent re-seed: drop leftovers from previous runs, then recreate.
    await deleteJournalIfExists(request, JOURNAL_A)
    await deleteJournalIfExists(request, JOURNAL_B)
    journalAId = await createJournalWithEntries(request, JOURNAL_A, "A", COUNT_A, "2020-01-01T12:00:00Z")
    // Eigener, nicht überlappender Datumsbereich (Tages-Karte 03.09.): mit
    // demselben Start-Datum wie A würden gleiche Indizes auf denselben
    // Kalendertag fallen und in der ungefilterten "Alle Einträge"-Ansicht zu
    // day-cards falten.
    journalBId = await createJournalWithEntries(request, JOURNAL_B, "B", COUNT_B, "2020-06-01T18:00:00Z")
    // Let the per-IP rate-limit window reset so the UI's own /api/entries
    // requests during the tests are never answered with 429.
    await new Promise((r) => setTimeout(r, 61_000))
  })

  test('"Alle Einträge" requests page 3 when scrolling past two pages', async ({ page }) => {
    const pagesRequested = new Set<number>()
    page.on("request", (req) => {
      const url = new URL(req.url())
      if (url.pathname === "/api/entries" && url.searchParams.has("page")) {
        pagesRequested.add(Number(url.searchParams.get("page")))
      }
    })

    await page.goto("/")
    await ensureVaultUnlocked(page)
    await page.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })

    // Scroll until the third page has been requested. With the bug, loading
    // stops after two pages (50 entries) and no amount of scrolling fetches more.
    const blockedFor = installRateLimitWatch(page)
    for (let round = 0; round < 30 && !pagesRequested.has(3); round++) {
      const wait = blockedFor()
      if (wait > 0) await page.waitForTimeout(wait)
      await scrollTimelineToBottom(page)
      await page.waitForTimeout(500)
    }

    expect(
      Array.from(pagesRequested).sort((a, b) => a - b),
      `Timeline stopped paginating — pages requested: ${Array.from(pagesRequested).sort().join(", ")}. ` +
        "The infinite-scroll sentinel was never observed after remounting."
    ).toContain(3)
  })

  test("journal filter A shows all 34 entries down to the oldest", async ({ page }) => {
    await page.goto(`/?journal=${journalAId}`)
    await ensureVaultUnlocked(page)
    await page.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })

    const reachedOldest = await scrollUntilVisible(page, "QA-Scroll A-01", 15)
    expect(reachedOldest, "Oldest entry A-01 never became visible — journal timeline incomplete").toBe(true)
  })

  test("journal filter B shows all 32 entries down to the oldest", async ({ page }) => {
    await page.goto(`/?journal=${journalBId}`)
    await ensureVaultUnlocked(page)
    await page.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })

    const reachedOldest = await scrollUntilVisible(page, "QA-Scroll B-01", 15)
    expect(reachedOldest, "Oldest entry B-01 never became visible — journal timeline incomplete").toBe(true)
  })

  test("switching journals in-app after deep scrolling still paginates to the end", async ({ page }) => {
    // Edge case: deep scroll unmounts/remounts the virtualized sentinel many
    // times, then a journal switch resets page to 1 — pagination must still
    // work all the way down in the newly selected journal.
    await page.goto("/")
    await ensureVaultUnlocked(page)
    await page.waitForSelector(TIMELINE_CARD, { timeout: 15_000 })
    for (let round = 0; round < 5; round++) {
      await scrollTimelineToBottom(page)
      await page.waitForTimeout(400)
    }

    await page.getByText(JOURNAL_A, { exact: true }).first().click()
    await page.waitForTimeout(500)

    const reachedOldest = await scrollUntilVisible(page, "QA-Scroll A-01", 15)
    expect(reachedOldest, "After in-app journal switch the oldest entry A-01 never became visible").toBe(true)
  })
})
