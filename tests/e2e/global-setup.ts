import { request } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:4000"
const password = process.env.E2E_PASSWORD

const AUTH_STATE_PATH = path.join(__dirname, ".auth-state.json")

export default async function globalSetup() {
  if (!password) {
    throw new Error(
      "E2E_PASSWORD env var is required.\n" +
        "Set it to the app login password before running Playwright:\n" +
        "  E2E_PASSWORD=<password> npm run test:e2e"
    )
  }

  // Log in via API and capture the iron-session cookie
  const ctx = await request.newContext({ baseURL })
  const res = await ctx.post("/api/auth/login", { data: { password } })
  if (!res.ok()) {
    const body = await res.text()
    throw new Error(`Login failed (${res.status()}): ${body}`)
  }

  // Write the session cookie directly from the API context — no browser launch needed.
  // The previous approach (chromium.launch + page.goto) triggered ERR_SSL_PROTOCOL_ERROR
  // because the old service hostname "app" is on Chromium's static HSTS preload list
  // (whole .app gTLD) and was force-upgraded to HTTPS (the service was later renamed to webapp).
  // request.newContext().storageState() returns the same JSON format that
  // Playwright's test runner reads from the storageState: config option, so no
  // browser navigation is required.
  const state = await ctx.storageState()
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2))
  await ctx.dispose()

  console.log(`[global-setup] Auth state saved to ${AUTH_STATE_PATH}`)

  // Ensure the auth state file is gitignored
  const gitignorePath = path.join(__dirname, ".gitignore")
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, ".auth-state.json\ntest-results/\nreport/\nscreenshots/\n")
  }
}
