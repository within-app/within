import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:4000"

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/test-results",
  snapshotDir: "./tests/e2e/screenshots",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  // Vault-PIN-Setup/-Unlock läuft PBKDF2 mit 600k Iterationen — der Playwright-
  // Default (30s) ist auf schwachen Runnern knapp. Einzelne Tests mit einem
  // persistenten Kaltstart-Context (mehrere Reloads/Logins) heben per
  // test.setTimeout weiter an.
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "tests/e2e/report", open: "never" }]],

  use: {
    baseURL,
    headless: true,
    // Saved after global-setup login
    storageState: "tests/e2e/.auth-state.json",
    screenshot: "only-on-failure",
    video: "off",
    // Stable viewport for visual regression comparisons
    viewport: { width: 1280, height: 800 },
  },

  globalSetup: "./tests/e2e/global-setup.ts",

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Root cause of the historical staging ERR_SSL_PROTOCOL_ERROR:
        // the old compose service name "app" is on Chromium's *static* HSTS preload
        // list (the entire .app gTLD is preloaded), so http://app:4000 was force-
        // upgraded to HTTPS — no flag disables that list. Fixed by renaming the
        // staging service to "webapp"; the flags below stay as belt-and-braces
        // for other insecure origins.
        launchOptions: {
          args: [
            "--disable-features=HttpsUpgrades,AutoupgradeMixedContent",
            `--unsafely-treat-insecure-origin-as-secure=${baseURL}`,
            // Docker's default /dev/shm is 64 MB — too small for Chromium renderer
            // processes, causing OOM crashes. This flag makes Chromium write to /tmp
            // instead, which is unbounded and backed by regular container memory.
            // Belt-and-suspenders for Docker's small default /dev/shm.
            "--disable-dev-shm-usage",
          ],
        },
      },
    },
  ],
})
