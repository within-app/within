/**
 * Local Docker self-test — PWA offline sync checks.
 *
 * Run against http://localhost:4000 with the dev compose stack:
 *   docker compose -f docker-compose.dev.yml up --build
 *   E2E_BASE_URL=http://localhost:4000 E2E_PASSWORD=localtest npx playwright test tests/e2e/pwa-offline-sync.spec.ts
 *
 * Acceptance criteria covered:
 *   AC3 — PWA manifest + service-worker check via localhost
 *   AC3 — Offline timeline reads from IndexedDB (Gap A)
 *   AC3 — Offline navigation to /entry/new served from SW shell (Gap B)
 *   AC4 — Offline → sync round-trip (headless Playwright assertion)
 *   Offline calendar / overview / map read from IndexedDB
 *   Offline incident — cleared CacheStorage must never yield ERR_FAILED;
 *     shell precache self-heals on the next online navigation
 *   Offline incident — a SW installed while logged out must never
 *     precache '/' as a redirected response; offline cold start after login
 *     serves a usable response instead of ERR_FAILED
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import { ensureVaultUnlocked } from "./helpers/vault"
import { openEntryByMarker, expectEntryInTimeline } from "./helpers/timeline"

// Minimal inline types — keeps this test self-contained without cross-root imports
interface SyncEntry {
  id: string; journalId: string; text: string
  createdAt: string; updatedAt: string; revisionId: string
  starred: boolean; tags: string[]
  locationName: string | null; locationLat: number | null; locationLng: number | null
  weatherDescription: string | null; weatherTempCelsius: number | null; weatherIcon: string | null
}

// Deterministic IDs that match scripts/seed-dev.sql
const DEV_JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

// Synthetic IDs used only in tests — no collision risk with seed data
const SYNC_API_ENTRY_ID   = "ef000000-0000-4000-8000-000000000001"
const BROWSER_SYNC_ENTRY_ID = "ef000000-0000-4000-8000-000000000002"

function makeSyncEntry(id: string, journalId: string, text: string): SyncEntry {
  const now = new Date().toISOString()
  return {
    id,
    journalId,
    text,
    createdAt: now,
    updatedAt: now,
    revisionId: id.replace("ef0", "ef1"),
    starred: false,
    tags: [],
    locationName: null,
    locationLat: null,
    locationLng: null,
    weatherDescription: null,
    weatherTempCelsius: null,
    weatherIcon: null,
  }
}

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
    // Wait until React hydrates and the useEffect in SwRegister fires
    await page.waitForLoadState("networkidle")

    // Use evaluate with an event-driven wait for clients.claim() to run.
    // navigator.serviceWorker.controller becomes non-null once the SW activates
    // and calls clients.claim(). This avoids waitForFunction with an async
    // predicate, which resolved prematurely in Playwright v1.61.
    const isControlled = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          if (navigator.serviceWorker?.controller) {
            resolve(true)
            return
          }
          const timer = setTimeout(() => resolve(false), 9_000)
          navigator.serviceWorker?.addEventListener("controllerchange", () => {
            clearTimeout(timer)
            resolve(true)
          })
        })
    )

    expect(isControlled).toBe(true)
  })
})

// ── Offline timeline from IDB (Gap A) ─────────────────────────────────────────

test.describe("Offline timeline — IDB fallback (Gap A)", () => {
  test("timeline shows IDB entries when API is unreachable", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    // Seed a synthetic entry directly into the app's IndexedDB
    const idbEntryId = "ef000000-0000-4000-8000-000000000010"
    const idbText    = "Synthetic offline IDB timeline entry e2e-1076"
    const now        = new Date().toISOString()

    await page.evaluate(
      async ({ eid, jid, text, ts }) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("within-sync", 3)
          req.onupgradeneeded = (ev) => {
            const db = (ev.target as IDBOpenDBRequest).result
            for (const [name, opts] of [
              ["entries",        { keyPath: "id" }],
              ["editQueue",      { keyPath: "entryId" }],
              ["conflictCopies", { keyPath: "id" }],
              ["meta",           { keyPath: "key" }],
              ["pinnedEntries",  { keyPath: "entryId" }],
              ["mediaLRU",       { keyPath: "url" }],
            ] as [string, IDBObjectStoreParameters][]) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts)
            }
          }
          req.onsuccess = () => {
            const db  = req.result
            const txn = db.transaction("entries", "readwrite")
            txn.objectStore("entries").put({
              id: eid, journalId: jid, text,
              createdAt: ts, updatedAt: ts,
              revisionId: "ef100000-0000-4000-8000-000000000010",
              starred: false, tags: [],
              locationName: null, locationLat: null, locationLng: null,
              weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
            })
            txn.oncomplete = () => resolve()
            txn.onerror   = () => reject(txn.error)
          }
          req.onerror = () => reject(req.error)
        })
      },
      { eid: idbEntryId, jid: DEV_JOURNAL_ID, text: idbText, ts: now }
    )

    // Block all /api/entries requests so the timeline fetch fails and falls back to IDB
    await page.route("**/api/entries**", (route) => route.abort("failed"))

    // Navigate to homepage — timeline will load, API fails, IDB fallback fires
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    await ensureVaultUnlocked(page)

    // Entry card should appear with the IDB text as title/preview.
    // Tages-Karte (03.09.): "heute" kann durch den Mount-Sync oben schon
    // weitere Einträge tragen — expectEntryInTimeline deckt beide Layouts ab.
    await expectEntryInTimeline(page, idbText, { timeout: 10_000 })
  })
})

// ── Offline UI click-flow ─────────────────────────────────────────────────────

/** Seed a SyncEntry into the app's IDB store (DB_VERSION=2). */
async function seedIDBEntry(
  page: Page,
  entry: {
    id: string; journalId: string; text: string
    createdAt: string; updatedAt: string; revisionId: string
    starred: boolean; tags: string[]
    locationName: string | null; locationLat: number | null; locationLng: number | null
    weatherDescription: string | null; weatherTempCelsius: number | null; weatherIcon: string | null
    deletedAt?: string | null; thumbnailDataUrl?: string | null
  }
) {
  await page.evaluate(
    async (e: typeof entry) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("within-sync", 3)
        req.onupgradeneeded = (ev) => {
          const db = (ev.target as IDBOpenDBRequest).result
          for (const [name, opts] of [
            ["entries",        { keyPath: "id" }],
            ["editQueue",      { keyPath: "entryId" }],
            ["conflictCopies", { keyPath: "id" }],
            ["meta",           { keyPath: "key" }],
            ["pinnedEntries",  { keyPath: "entryId" }],
            ["mediaLRU",       { keyPath: "url" }],
          ] as [string, IDBObjectStoreParameters][]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts)
          }
        }
        req.onsuccess = () => {
          const db  = req.result
          const txn = db.transaction("entries", "readwrite")
          txn.objectStore("entries").put({ ...e, deletedAt: e.deletedAt ?? null, thumbnailDataUrl: e.thumbnailDataUrl ?? null })
          txn.oncomplete = () => resolve()
          txn.onerror   = () => reject(txn.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    entry
  )
}

test.describe("Offline entry detail — IDB click-flow", () => {
  test("clicking an entry card offline renders entry text, not 'Eintrag nicht gefunden'", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const entryId   = "ef000000-0000-4000-8000-000000000020"
    const entryText = "Offline detail test entry e2e-1405"
    const now       = new Date().toISOString()

    await seedIDBEntry(page, {
      id: entryId, journalId: DEV_JOURNAL_ID,
      text: entryText,
      createdAt: now, updatedAt: now,
      revisionId: "ef100000-0000-4000-8000-000000000020",
      starred: false, tags: [],
      locationName: null, locationLat: null, locationLng: null,
      weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    })

    // Block API so timeline + detail both fall back to IDB
    await page.route("**/api/entries**", (route) => route.abort("failed"))
    await page.context().setOffline(true)

    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    // Offline-Kaltstart: der DEK ist weg, der PinLockScreen steht vor der
    // Timeline — Unlock läuft komplett lokal, auch ohne Netz.
    await ensureVaultUnlocked(page)

    // Tages-Karte (03.09.): entry-card nur, wenn der Eintrag allein an seinem
    // Tag steht — sonst über die Tages-Vorschau (openEntryByMarker deckt beides ab).
    await openEntryByMarker(page, entryText, undefined, 10_000)

    // The IDB fallback must render the entry content, never the empty-state message
    await expect(page.getByText("Eintrag nicht gefunden")).not.toBeVisible({ timeout: 5_000 })
    // getByText matcht Karte UND Detail (Strict-Mode-
    // Violation) — das Detail rendert den Text als Heading, die Karte nicht.
    await expect(page.getByRole("heading", { name: entryText })).toBeVisible({ timeout: 5_000 })

    await page.context().setOffline(false)
  })
})

test.describe("Offline new-entry — inline editor click-flow", () => {
  test("'Neuer Eintrag' opens editor offline, save queues edit in IDB", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    // Ensure the SW has activated and journals have loaded at least once
    await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })

    await page.context().setOffline(true)

    // Click the header "Neuer Eintrag" button
    await page.click('button[title="Neuer Eintrag (⌘N)"]')

    // The inline editor must appear — assert the textarea is visible
    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })

    // Type an entry and trigger save-and-close
    const offlineText = "Offline queued entry e2e-1405"
    await textarea.fill(offlineText)

    // Click the "Fertig" / save-and-close button
    const fertigBtn = page.getByRole("button", { name: /Fertig|Speichern/i })
    await fertigBtn.click()

    // After save: the editor should close (textarea gone) and the SyncBadge
    // should show a pending count (≥1)
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    // Verify the edit landed in the IDB editQueue
    const queueCount = await page.evaluate(async () => {
      return new Promise<number>((resolve, reject) => {
        const req = indexedDB.open("within-sync", 3)
        req.onsuccess = () => {
          const db  = req.result
          const txn = db.transaction("editQueue", "readonly")
          const cr  = txn.objectStore("editQueue").count()
          cr.onsuccess = () => resolve(cr.result)
          cr.onerror   = () => reject(cr.error)
        }
        req.onerror = () => reject(req.error)
      })
    })
    expect(queueCount).toBeGreaterThanOrEqual(1)

    await page.context().setOffline(false)

    // Go online → engine should push the queued edit
    await page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )
  })
})

// ── AC3 offline save: entry in entries store + survives offline refresh ──────

test.describe("AC3 offline save — entries store + offline refresh", () => {
  test("entry saved offline appears in entries IDB store and in timeline after offline reload", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    // Wait for SW activation + journals loaded so all JS chunks are cached
    await page.waitForSelector('button[title="Neuer Eintrag (⌘N)"]', { timeout: 10_000 })

    await page.context().setOffline(true)

    await page.click('button[title="Neuer Eintrag (⌘N)"]')

    const textarea = page.locator("textarea").first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })

    const offlineText = "AC3 offline save survives refresh e2e-1664"
    await textarea.fill(offlineText)

    // Save and close — must not show "Offline-Speicherung fehlgeschlagen"
    await page.getByRole("button", { name: /Fertig|Speichern/i }).click()
    await expect(textarea).not.toBeVisible({ timeout: 5_000 })

    // No error banner must appear
    await expect(page.getByText(/Speicherung fehlgeschlagen/i)).not.toBeVisible({ timeout: 3_000 })

    // The entry must be in BOTH IDB stores:
    //   editQueue → pending push when online
    //   entries   → visible to offline timeline fallback
    // Seit Vault P2 liegen die Records verschlüsselt (Envelope) im Store —
    // ein Roh-IDB-Klartext-Match ist by design unmöglich. Hier zählen wir nur;
    // den INHALTS-Beweis liefert die Timeline nach dem Offline-Reload unten
    // (rendert nur, was aus dem Store entschlüsselbar ist).
    const stores = await page.evaluate(async () => {
      return new Promise<{ queueCount: number; entriesCount: number }>((resolve, reject) => {
        const req = indexedDB.open("within-sync", 3)
        req.onsuccess = () => {
          const db  = req.result
          const txn = db.transaction(["editQueue", "entries"], "readonly")

          const countReq   = txn.objectStore("editQueue").count()
          const entriesReq = txn.objectStore("entries").count()

          let queueCount = 0
          let entriesCount = 0

          countReq.onsuccess   = () => { queueCount = countReq.result }
          entriesReq.onsuccess = () => { entriesCount = entriesReq.result }

          txn.oncomplete = () => resolve({ queueCount, entriesCount })
          txn.onerror    = () => reject(txn.error)
        }
        req.onerror = () => reject(req.error)
      })
    })

    expect(stores.queueCount).toBeGreaterThanOrEqual(1)
    expect(stores.entriesCount).toBeGreaterThanOrEqual(1)

    // Offline page reload — timeline must show the entry from IDB
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    // Nach dem Reload ist der Vault gesperrt (DEK nur im RAM) — offline entsperren.
    await ensureVaultUnlocked(page)

    // Tages-Karte (03.09.): "heute" kann bereits mehrere Einträge tragen —
    // expectEntryInTimeline deckt entry-card UND day-card ab.
    await expectEntryInTimeline(page, offlineText, { timeout: 10_000 })

    await page.context().setOffline(false)
  })
})

// ── Offline → sync round-trip (AC4) ──────────────────────────────────────────

/**
 * Folgt der nextCursor-Pagination von /api/sync/changes, bis das gesuchte
 * Element gefunden oder das Ende erreicht ist. `since` sollte kurz vor dem
 * Push erfasst werden (z.B. `Date.now() - 60_000`) — der frisch gepushte
 * Eintrag liegt sonst (Cursor läuft aufsteigend ab `since`) auf der LETZTEN
 * Seite einer großen, wiederverwendeten Dev-DB (~27 Requests bei 1310
 * Einträgen seit 1970).
 */
async function findInChangesPaginated(
  request: APIRequestContext,
  predicate: (e: SyncEntry) => boolean,
  since: string,
  maxPages = 20
): Promise<SyncEntry | undefined> {
  let cursor: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const url = `/api/sync/changes?since=${encodeURIComponent(since)}&limit=50${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`
    const res = await request.get(url)
    expect(res.status()).toBe(200)
    const { entries, nextCursor } = (await res.json()) as { entries: SyncEntry[]; nextCursor: string | null }
    const found = entries.find(predicate)
    if (found) return found
    if (!nextCursor) return undefined
    cursor = nextCursor
  }
  return undefined
}

test.describe("Offline → sync (AC4)", () => {
  test("sync API: upsert then pull returns the entry", async ({ request }) => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const entry = makeSyncEntry(SYNC_API_ENTRY_ID, DEV_JOURNAL_ID, "Synthetic offline-sync test entry")

    // Simulate "push on reconnect"
    const pushRes = await request.post("/api/sync/upsert", {
      data: { entries: [entry] },
    })
    expect(pushRes.status()).toBe(200)
    const { accepted } = (await pushRes.json()) as { accepted: string[] }
    expect(accepted).toContain(SYNC_API_ENTRY_ID)

    // Simulate "initial pull after sync" — der Pull ist paginiert, der Eintrag
    // muss nicht auf der ersten Seite liegen.
    const found = await findInChangesPaginated(request, (e) => e.id === SYNC_API_ENTRY_ID, since)
    expect(found, `Eintrag ${SYNC_API_ENTRY_ID} nicht in /api/sync/changes seit ${since} gefunden`).toBeDefined()
    expect(found?.text).toBe("Synthetic offline-sync test entry")
  })

  test("browser: IDB queue flushed to server after going online", async ({ page, request }) => {
    // Load app so React + useSync hook initialise (and open the IDB)
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    // B07: Sync läuft nur bei entsperrtem Vault — ohne Unlock flusht nichts.
    await ensureVaultUnlocked(page)

    // Go offline (sets navigator.onLine=false, fires 'offline' event)
    await page.context().setOffline(true)

    // Write a queued edit directly to the app's IndexedDB
    const entryId   = BROWSER_SYNC_ENTRY_ID
    const journalId = DEV_JOURNAL_ID
    const now       = new Date().toISOString()

    await page.evaluate(
      async ({ eid, jid, ts }) => {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("within-sync", 3)
          req.onupgradeneeded = (ev) => {
            const db = (ev.target as IDBOpenDBRequest).result
            const storeSpecs: [string, IDBObjectStoreParameters][] = [
              ["entries",        { keyPath: "id" }],
              ["editQueue",      { keyPath: "entryId" }],
              ["conflictCopies", { keyPath: "id" }],
              ["meta",           { keyPath: "key" }],
              ["pinnedEntries",  { keyPath: "entryId" }],
              ["mediaLRU",       { keyPath: "url" }],
            ]
            for (const [name, opts] of storeSpecs) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts)
            }
          }
          req.onsuccess = () => {
            const db  = req.result
            const txn = db.transaction("editQueue", "readwrite")
            txn.objectStore("editQueue").put({
              entryId: eid,
              operation: "create",
              queuedAt: ts,
              payload: {
                id: eid, journalId: jid,
                text: "Browser offline-sync test entry",
                createdAt: ts, updatedAt: ts,
                revisionId: "ef100000-0000-4000-8000-000000000002",
                starred: false, tags: [],
                locationName: null, locationLat: null, locationLng: null,
                weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
              },
            })
            txn.oncomplete = () => resolve()
            txn.onerror   = () => reject(txn.error)
          }
          req.onerror = () => reject(req.error)
        })
      },
      { eid: entryId, jid: journalId, ts: now }
    )

    // Restore network — browser fires 'online' which triggers useSync.triggerSync().
    // Den Response-Listener VOR setOffline(false) registrieren: der Flush kann
    // schneller sein als ein danach registriertes waitForResponse (Race). `since`
    // kurz vor dem Push erfasst, siehe findInChangesPaginated.
    const since = new Date(Date.now() - 60_000).toISOString()
    const flushed = page.waitForResponse(
      (r) => r.url().includes("/api/sync/upsert") && r.status() === 200,
      { timeout: 20_000 }
    )
    await page.context().setOffline(false)
    await flushed

    // Verify the entry landed on the server — paginiert suchen (siehe oben).
    const synced = await findInChangesPaginated(request, (e) => e.id === entryId, since)
    expect(synced, `Eintrag ${entryId} nicht in /api/sync/changes seit ${since} gefunden`).toBeDefined()
    expect(synced?.text).toBe("Browser offline-sync test entry")
  })
})

// ── Offline calendar — IDB fallback ───────────────────────────────────────────

test.describe("Offline calendar — IDB fallback", () => {
  test("calendar view renders from IDB and shows dot for seeded entry", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    // Deterministischer Tag statt "heute": ein fremder Foto-Eintrag am
    // Laufdatum (Dev-DB-Altlast) erfüllt die alte img-ODER-Punkt-Probe auch
    // dann, wenn der geseedete IDB-Eintrag gar nicht rendert. Stattdessen den
    // ersten Tag des laufenden Monats bis heute suchen, der laut /api/calendar
    // noch KEINEN Eintrag trägt, und dort gezielt den Punkt fordern.
    const now = new Date()
    const monthStr = now.toISOString().slice(0, 7) // YYYY-MM (UTC)
    const calRes = await page.request.get(`/api/calendar?month=${monthStr}`)
    expect(calRes.ok()).toBeTruthy()
    const existing = (await calRes.json()) as Record<string, { count: number; thumbnail?: string }>

    let freeDay: string | undefined
    for (let d = 1; d <= now.getUTCDate(); d++) {
      const key = `${monthStr}-${String(d).padStart(2, "0")}`
      if (!(key in existing)) { freeDay = key; break }
    }
    if (!freeDay) {
      test.skip(true, "Kein Tag im laufenden Monat ohne bestehende Einträge — Kalender-Determinismus nicht prüfbar")
      return
    }

    await seedIDBEntry(page, {
      id: "ef000000-0000-4000-8000-000000000030",
      journalId: DEV_JOURNAL_ID,
      text: "Synthetic offline calendar IDB entry e2e-1118",
      createdAt: `${freeDay}T12:00:00.000Z`,
      updatedAt: `${freeDay}T12:00:00.000Z`,
      revisionId: "ef100000-0000-4000-8000-000000000030",
      starred: false, tags: [],
      locationName: null, locationLat: null, locationLng: null,
      weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    })

    // Block calendar API so the IDB fallback fires
    await page.route("**/api/calendar**", (route) => route.abort("failed"))

    // Switch to calendar view (text tab — no icon)
    await page.getByRole("button", { name: "Kalender" }).click()

    // The "Heute" anchor button is always rendered once CalendarView mounts.
    // Matches via aria-label (the visible text "Heute" is not the accessible name).
    await expect(
      page.getByRole("button", { name: "Zum heutigen Tag springen" })
    ).toBeVisible({ timeout: 10_000 })

    // Zelle des freien Tages innerhalb main, NICHT im ViewChunkWarmer (dessen
    // versteckte Kopie ist per :visible ausgeschlossen). Der laufende Monat ist
    // stets das erste (DOM-oberste) der initial drei gerenderten Monatsraster
    // (Startfenster: aktueller Monat + 2 davor), .first() trifft also die
    // richtige Zelle, keine gleichnamige aus einem der Vormonate.
    const targetDayNum = Number(freeDay.slice(8, 10))
    const targetCell = page
      .getByRole("main")
      .locator('[role="grid"]:visible button', { hasText: new RegExp(`^${targetDayNum}$`) })
      .first()

    // Kein fremder Foto-Eintrag möglich (Tag war frei) — nur noch der Punkt
    // zählt als Beweis, kein img-ODER-Punkt mehr. IDB-Fallback braucht einen
    // Moment, daher pollen statt sofort lesen.
    async function cellHasDot(): Promise<boolean> {
      if ((await targetCell.count()) === 0) return false
      return targetCell.evaluate((el) =>
        Array.from(el.querySelectorAll("div")).some((d) => {
          const c = typeof d.className === "string" ? d.className : ""
          return c.includes("bg-primary") && c.includes("rounded-full") && c.includes("h-[5px]")
        })
      )
    }
    await expect
      .poll(cellHasDot, {
        timeout: 10_000,
        message: `Kalenderzelle ${freeDay} zeigt keinen Punkt aus der IDB`,
      })
      .toBe(true)
  })
})

// ── Offline overview — IDB fallback ───────────────────────────────────────────

test.describe("Offline overview — IDB fallback", () => {
  test("overview shows stats derived from IDB when API is unreachable", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const now = new Date().toISOString()
    // Seed 2 entries so idbToStats returns totalEntries >= 2
    for (const [id, rev] of [
      ["ef000000-0000-4000-8000-000000000031", "ef100000-0000-4000-8000-000000000031"],
      ["ef000000-0000-4000-8000-000000000032", "ef100000-0000-4000-8000-000000000032"],
    ] as [string, string][]) {
      await seedIDBEntry(page, {
        id, journalId: DEV_JOURNAL_ID,
        text: `Synthetic offline overview IDB entry ${id} e2e-1118`,
        createdAt: now, updatedAt: now,
        revisionId: rev,
        starred: false, tags: [],
        locationName: null, locationLat: null, locationLng: null,
        weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
      })
    }

    // Block stats API so the IDB fallback fires
    await page.route("**/api/stats**", (route) => route.abort("failed"))

    // Switch to overview view (icon-only tab — select by title attribute)
    await page.click('button[title="Übersicht"]')

    const main = page.getByRole("main")

    // "Einträge" label must appear — the stats card rendered. exact:true avoids
    // strict-mode violation from sidebar "0 Einträge"/nav "Alle Einträge";
    // .and(:visible) excludes the ViewChunkWarmer's hidden aria-hidden copy
    // (mounts ≤15s, unmounts after 15s) — cheaper and more robust than waiting
    // for its "detached" state, which resolves immediately if the warmer never
    // even mounts (the strict-mode collision could then still hit later).
    const entriesLabel = main.getByText("Einträge", { exact: true }).and(page.locator("*:visible"))
    await expect(entriesLabel).toBeVisible({ timeout: 10_000 })

    // Stats must NOT be in skeleton state — idbToStats() always returns a non-null
    // object, so the animated-placeholder disappears only when IDB was consulted
    await expect(main.locator(".animate-pulse").first()).not.toBeVisible({ timeout: 5_000 })
  })
})

// ── Offline map — IDB fallback ─────────────────────────────────────────────────

test.describe("Offline map — IDB fallback", () => {
  test("map view renders IDB location markers when API is unreachable", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const now = new Date().toISOString()
    // Seed an entry with coordinates — idbToMapMarkers includes it as a marker
    await seedIDBEntry(page, {
      id: "ef000000-0000-4000-8000-000000000033",
      journalId: DEV_JOURNAL_ID,
      text: "Synthetic offline map IDB entry e2e-1118",
      createdAt: now, updatedAt: now,
      revisionId: "ef100000-0000-4000-8000-000000000033",
      starred: false, tags: [],
      locationName: "Berlin, Germany",
      locationLat: 52.52,
      locationLng: 13.405,
      weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    })

    // Block locations API so the IDB fallback fires
    await page.route("**/api/locations**", (route) => route.abort("failed"))

    // Switch to map view (icon-only tab — select by title attribute)
    await page.click('button[title="Karte"]')

    // Empty-state text must NOT appear — IDB markers render instead
    await expect(page.getByText("Noch keine Standortdaten")).not.toBeVisible({ timeout: 10_000 })

    // Marker count badge shows a digit + "Standort(e)" — proves at least 1 IDB marker rendered.
    // Uses regex to tolerate plural ("Standorte") and any pre-existing IDB location data.
    await expect(page.getByText(/\d+ Standort/)).toBeVisible({ timeout: 5_000 })
  })
})

// ── SW hardening — cleared CacheStorage (offline incident 2026-08-07) ────────
//
// The browser's "clear cache" action empties CacheStorage but keeps the SW
// registration. Because the shell precache is only filled in the install
// event (which never re-fires for an unchanged sw.js), the shell cache stayed
// empty forever and offline navigations died with net::ERR_FAILED
// (respondWith(undefined)).

/** Wait until the SW controls the page (clients.claim() ran). */
async function waitForSwControl(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        if (navigator.serviceWorker?.controller) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => resolve(false), 9_000)
        navigator.serviceWorker?.addEventListener("controllerchange", () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
  )
}

/** Delete every CacheStorage cache — the SW registration stays untouched. */
async function clearCacheStorage(page: Page) {
  await page.evaluate(async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
  })
}

test.describe("SW hardening — cleared CacheStorage (offline incident 2026-08-07)", () => {
  test("offline navigation with empty caches serves a usable response, not ERR_FAILED", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    expect(await waitForSwControl(page)).toBe(true)

    // Simulate the browser's "clear cache": CacheStorage emptied, SW registration kept.
    await clearCacheStorage(page)

    await page.context().setOffline(true)

    // Must not reject with net::ERR_FAILED — the SW nav fallback may never
    // resolve undefined, even when both the request URL and '/' miss the cache.
    await page.goto("/")

    // Usable response: with empty caches while offline the app shell cannot be
    // served, so the inline offline notice must render — never a browser error page.
    await expect(page.getByTestId("sw-offline-fallback")).toBeVisible({ timeout: 5_000 })

    await page.context().setOffline(false)
  })

  test("one online navigation after cache loss restores the shell precache and full offline", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)
    expect(await waitForSwControl(page)).toBe(true)

    // Seed an IDB entry for the final offline-timeline assertion
    const entryText = "Self-heal offline timeline entry 2026-08-07"
    const now = new Date().toISOString()
    await seedIDBEntry(page, {
      id: "ef000000-0000-4000-8000-000000000040",
      journalId: DEV_JOURNAL_ID,
      text: entryText,
      createdAt: now, updatedAt: now,
      revisionId: "ef100000-0000-4000-8000-000000000040",
      starred: false, tags: [],
      locationName: null, locationLat: null, locationLng: null,
      weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    })

    await clearCacheStorage(page)

    // One ordinary online navigation → the SW must self-heal the shell precache.
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    // Both NAV_PRECACHE entries must come back. '/login' is never visited here,
    // so only a real refill (not the visited-URL re-cache) can restore it.
    const refilled = await page.evaluate(async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const [root, login] = await Promise.all([caches.match("/"), caches.match("/login")])
        if (root && login) return true
        await new Promise((r) => setTimeout(r, 250))
      }
      return false
    })
    expect(refilled).toBe(true)

    // Full offline must work again: cached shell boots, timeline reads from IDB.
    await page.context().setOffline(true)
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    await ensureVaultUnlocked(page)

    // Tages-Karte (03.09.): "heute" kann bereits mehrere Einträge tragen —
    // expectEntryInTimeline deckt entry-card UND day-card ab.
    await expectEntryInTimeline(page, entryText, { timeout: 10_000 })

    await page.context().setOffline(false)
  })
})

// ── SW hardening — redirect-poisoned precache (offline incident 2026-08-09) ──
//
// A SW that installs while LOGGED OUT (real phone sequence: full site-data
// wipe logs the user out, the SW re-registers on /login) precached '/' via
// cache.addAll, which follows the '/' → 307 → /login redirect and stores a
// response with redirected: true under '/'. Chromium refuses redirected cache
// entries as navigation responses, so the offline cold start died with
// net::ERR_FAILED even though the cache was non-empty — the 2026-08-07
// hardening only guards against MISSING entries, not forbidden ones.

test.describe("SW hardening — redirect-poisoned precache (offline incident 2026-08-09)", () => {
  // The phone scenario starts LOGGED OUT — override the global auth state.
  test.use({ storageState: { cookies: [], origins: [] } })

  /** Register the SW while logged out (goto '/' lands on /login) and wait
   *  until the install precache has settled ('/login' is always precached). */
  async function installSwLoggedOut(page: Page) {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    expect(await waitForSwControl(page)).toBe(true)

    const precacheSettled = await page.evaluate(async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (await caches.match("/login")) return true
        await new Promise((r) => setTimeout(r, 250))
      }
      return false
    })
    expect(precacheSettled).toBe(true)
  }

  /** Log in through the API — same context, so the page shares the cookie jar. */
  async function loginViaApi(page: Page) {
    const res = await page.request.post("/api/auth/login", {
      data: { password: process.env.E2E_PASSWORD },
    })
    expect(res.ok()).toBe(true)
  }

  test("logged-out install never precaches '/' as a redirected response", async ({ page }) => {
    await installSwLoggedOut(page)

    // cache['/'] is either absent (redirecting path skipped — the first
    // logged-in online navigation fills it) or a clean non-redirected copy.
    // A redirected: true entry is exactly the poison Chromium refuses to
    // serve for navigations.
    const root = await page.evaluate(async () => {
      const r = await caches.match("/")
      return r ? { exists: true, redirected: r.redirected, url: r.url } : { exists: false }
    })
    if (root.exists) expect(root.redirected).toBe(false)
  })

  test("login → immediately offline → navigation serves a usable response, not ERR_FAILED", async ({ page }) => {
    await installSwLoggedOut(page)
    await loginViaApi(page)

    // Offline BEFORE any logged-in online navigation: cache['/'] still holds
    // whatever the logged-out install left behind.
    await page.context().setOffline(true)

    // Must not reject with net::ERR_FAILED — a poisoned entry may never be
    // served; the nav fallback has to fall through to a usable response.
    await page.goto("/")

    // Usable response: no clean '/' shell exists yet, so the inline offline
    // notice must render — never a browser error page.
    await expect(page.getByTestId("sw-offline-fallback")).toBeVisible({ timeout: 5_000 })

    await page.context().setOffline(false)
  })

  test("login → one online navigation → full offline cold start from IDB", async ({ page }) => {
    await installSwLoggedOut(page)
    await loginViaApi(page)

    // One ordinary online navigation — the network-first handler must store a
    // clean '/' shell that survives even an immediate SW shutdown (cache.put
    // is tied to event.waitUntil).
    await page.goto("/")
    await page.waitForLoadState("networkidle")
    await ensureVaultUnlocked(page)

    const entryText = "Redirect-poison offline timeline entry 2026-08-09"
    const now = new Date().toISOString()
    await seedIDBEntry(page, {
      id: "ef000000-0000-4000-8000-000000000050",
      journalId: DEV_JOURNAL_ID,
      text: entryText,
      createdAt: now, updatedAt: now,
      revisionId: "ef100000-0000-4000-8000-000000000050",
      starred: false, tags: [],
      locationName: null, locationLat: null, locationLng: null,
      weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    })

    // The '/' shell must be present AND clean (non-redirected) before going offline.
    const cleanShell = await page.evaluate(async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const r = await caches.match("/")
        if (r && !r.redirected) return true
        await new Promise((res) => setTimeout(res, 250))
      }
      return false
    })
    expect(cleanShell).toBe(true)

    // Offline cold start: cached shell boots, timeline reads from IDB.
    await page.context().setOffline(true)
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    await ensureVaultUnlocked(page)

    // Tages-Karte (03.09.): "heute" kann bereits mehrere Einträge tragen —
    // expectEntryInTimeline deckt entry-card UND day-card ab.
    await expectEntryInTimeline(page, entryText, { timeout: 10_000 })

    await page.context().setOffline(false)
  })
})
