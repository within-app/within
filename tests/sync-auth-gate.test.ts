/**
 * PR4 — Sync nur mit Session (Absturz-Wurzel vom 05.08., Access-Log-Befund):
 * eine tote Session darf die Outbox (inkl. Multi-MB-Uploads) nie gegen 401er
 * replayen. sync() probt billig /api/settings und bricht bei 401/403 ab,
 * bevor irgendetwas gelesen oder gesendet wird; Netzwerkfehler der Probe
 * blockieren den Offline-Pfad nicht.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createSyncEngine } from "@/lib/sync/engine"
import type { IDBAdapter } from "@/lib/sync/idb"
import { isLoginPath } from "@/hooks/useSync"

const ORIGINAL_FETCH = globalThis.fetch

function makeIdb() {
  return {
    getMeta: vi.fn(async () => null),
    setMeta: vi.fn(async () => {}),
    listQueue: vi.fn(async () => []),
    putEntry: vi.fn(async () => {}),
    deleteEntry: vi.fn(async () => {}),
    listConflicts: vi.fn(async () => []),
    enqueueEdit: vi.fn(async () => {}),
    // kein listOutboxMedia → flushMedia ist ein No-op
  } as unknown as IDBAdapter & { getMeta: ReturnType<typeof vi.fn>; listQueue: ReturnType<typeof vi.fn> }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe("sync() auth gate", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  it("401 on the probe aborts the run before anything is read or sent", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "Nicht autorisiert", code: "unauthorized" }))
    const idb = makeIdb()
    const engine = createSyncEngine(idb)

    const result = await engine.sync()

    expect(result.authRequired).toBe(true)
    expect(result.pushed).toBe(0)
    expect(result.mediaUploaded).toBe(0)
    // Genau EIN Request (die Probe), und der ging auf /api/settings:
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/settings")
    // Die Engine hat die lokale DB nicht angefasst — keine Outbox-Reads:
    expect(idb.getMeta).not.toHaveBeenCalled()
    expect(idb.listQueue).not.toHaveBeenCalled()
  })

  it("403 aborts identically", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, {}))
    const engine = createSyncEngine(makeIdb())
    expect((await engine.sync()).authRequired).toBe(true)
  })

  it("a network error on the probe does NOT block the run (offline path intact)", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"))
    const idb = makeIdb()
    const engine = createSyncEngine(idb)

    const result = await engine.sync()

    expect(result.authRequired).toBeUndefined()
    expect(idb.getMeta).toHaveBeenCalled() // der normale Ablauf lief an
  })

  it("200 on the probe lets the run proceed", async () => {
    fetchMock.mockImplementation(async (url: string | URL) =>
      String(url).includes("/api/settings")
        ? jsonResponse(200, { locale: "de" })
        : jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2024-01-15T00:00:00.000Z" })
    )
    const idb = makeIdb()
    const engine = createSyncEngine(idb)

    const result = await engine.sync()

    expect(result.authRequired).toBeUndefined()
    expect(idb.listQueue).toHaveBeenCalled()
  })
})

describe("isLoginPath", () => {
  it("matches /login and subpaths, nothing else", () => {
    expect(isLoginPath("/login")).toBe(true)
    expect(isLoginPath("/login/")).toBe(true)
    expect(isLoginPath("/")).toBe(false)
    expect(isLoginPath("/settings")).toBe(false)
    expect(isLoginPath(null)).toBe(false)
    expect(isLoginPath(undefined)).toBe(false)
  })
})
