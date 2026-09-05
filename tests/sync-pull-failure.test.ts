/**
 * Pull-Fehler waren komplett stumm:
 * pull() brach bei !ok einfach mit break ab, SyncResult kannte kein
 * Pull-Fehlerfeld, das Sync-Badge zeigte „synchronisiert". Ein 503 von
 * /api/sync/changes (ehrliche DB-Fehler-Antwort, Projektregel) oder ein
 * Netzabriss mitten im Pull sah damit exakt wie Erfolg aus — Änderungen vom
 * anderen Gerät kamen nie an, ohne jeden Hinweis.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createSyncEngine } from "@/lib/sync/engine"
import type { IDBAdapter } from "@/lib/sync/idb"

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function makeIdb() {
  const meta = new Map<string, string>()
  return {
    listQueue: async () => [],
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => {
      meta.set(key, value)
    },
    getEntry: async () => undefined,
    putEntry: async () => {},
    deleteEntry: async () => {},
    putConflict: async () => {},
    listConflicts: async () => [],
    clearConflict: async () => {},
    enqueueEdit: async () => {},
    dequeueEdit: async () => {},
  } as unknown as IDBAdapter
}

describe("Pull-Fehler sichtbar machen (B03)", () => {
  it("503 auf /api/sync/changes setzt pullFailed im SyncResult", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(503, { error: "Daten derzeit nicht verfügbar", code: "db_unavailable" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const result = await createSyncEngine(makeIdb()).sync()
    expect(result.pullFailed).toBe(true)
  })

  it("erfolgreicher Pull: pullFailed ist false", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/settings")) return jsonResponse(200, {})
      if (url.includes("/api/sync/changes")) {
        return jsonResponse(200, { entries: [], nextCursor: null, serverTime: "2026-08-01T10:00:00.000Z" })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch

    const result = await createSyncEngine(makeIdb()).sync()
    expect(result.pullFailed).toBe(false)
  })
})
