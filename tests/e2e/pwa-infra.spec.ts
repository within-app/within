/**
 * Local Docker self-test — PWA infrastructure checks.
 *
 * Run against http://localhost:4000 with the dev compose stack:
 *   docker compose -f docker-compose.dev.yml up --build
 *   E2E_BASE_URL=http://localhost:4000 E2E_PASSWORD=localtest npx playwright test tests/e2e/pwa-infra.spec.ts
 *
 * Acceptance criteria covered:
 *   AC3 — PWA manifest + service-worker check via localhost
 */

import { test, expect } from "@playwright/test"

// ── PWA infrastructure ────────────────────────────────────────────────────────

test.describe("PWA infrastructure (AC3)", () => {
  test("manifest.webmanifest returns 200 with required fields", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest")
    expect(res.status()).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      name: expect.any(String),
      start_url: "/",
      display: "standalone",
    })
  })

  test("sw.js returns 200", async ({ request }) => {
    const res = await request.get("/sw.js")
    expect(res.status()).toBe(200)
  })

  test("HTML page has <link rel=manifest>", async ({ page }) => {
    await page.goto("/")
    const href = await page.locator('link[rel="manifest"]').getAttribute("href")
    expect(href).toBeTruthy()
  })

  test("service worker registers and becomes active", async ({ page }) => {
    await page.goto("/")
    // Give the SW install/activate cycle a moment
    const active = await page.waitForFunction(
      () =>
        navigator.serviceWorker
          .getRegistration("/")
          .then((r) => r?.active != null),
      { timeout: 10_000 }
    )
    expect(await active.jsonValue()).toBe(true)
  })
})
