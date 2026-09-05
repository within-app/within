/**
 * Service-Worker-Cache-Hygiene:
 *
 * Der Static-Asset-Pfad schrieb per fire-and-forget cache.put — exakt
 * die Fehlerklasse eines Offline-Incidents (SW wird direkt nach
 * respondWith gekillt, der Put geht verloren): ein fehlender Next.js-Chunk
 * bricht den nächsten Offline-Kaltstart, obwohl die Shell da ist.
 *
 * Außerdem hielt SHELL_CACHE pro besuchter URL für immer einen HTML-Eintrag
 * (Eigendiagnose im sw.js-Header) — über Jahre tausende Einträge, steigender
 * Origin-Verbrauch und damit Browser-Eviction-Risiko für die ganze Origin
 * inkl. IndexedDB (storage.persist ist auf manchen Geräten nachweislich verweigert).
 *
 * Harness-Muster wie tests/sw-media-encryption.test.ts: public/sw.js läuft
 * wirklich in einer Node-Sandbox. Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const ORIGIN = "https://within.test"

class MemCache {
  store = new Map<string, Response>()
  putDelayMs = 0
  private key(req: Request | string): string {
    return typeof req === "string" ? new URL(req, ORIGIN).toString() : req.url
  }
  async match(req: Request | string): Promise<Response | undefined> {
    return this.store.get(this.key(req))?.clone()
  }
  async put(req: Request | string, res: Response): Promise<void> {
    if (this.putDelayMs > 0) await new Promise((r) => setTimeout(r, this.putDelayMs))
    this.store.set(this.key(req), res)
  }
  async delete(req: Request | string): Promise<boolean> {
    return this.store.delete(this.key(req))
  }
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url))
  }
}

class MemCacheStorage {
  caches = new Map<string, MemCache>()
  async open(name: string): Promise<MemCache> {
    if (!this.caches.has(name)) this.caches.set(name, new MemCache())
    return this.caches.get(name)!
  }
  /** CacheStorage.match — sucht über alle Caches (nutzt der Static-Pfad). */
  async match(req: Request | string): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(req)
      if (hit) return hit
    }
    return undefined
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()]
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name)
  }
}

function makeSwEnv() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {
    install: [], activate: [], fetch: [], message: [],
  }
  const cacheStorage = new MemCacheStorage()
  let fetchImpl: (req: Request) => Promise<Response> = async () => {
    throw new TypeError("offline")
  }
  const swClients = { matchAll: async () => [], claim: async () => {} }
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners[type].push(fn),
    skipWaiting: () => {},
    clients: swClients,
    location: { origin: ORIGIN },
  }
  const fetchFn = (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init)
    return fetchImpl(req)
  }
  const src = readFileSync(join(__dirname, "../public/sw.js"), "utf8")
  new Function("self", "caches", "clients", "fetch", src)(self, cacheStorage, swClients, fetchFn)

  const dispatchFetch = async (request: Request): Promise<Response> => {
    let responsePromise: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    const event = {
      request,
      respondWith: (p: Response | Promise<Response>) => {
        responsePromise = Promise.resolve(p)
      },
      waitUntil: (p: Promise<unknown>) => {
        waits.push(Promise.resolve(p).catch(() => {}))
      },
    }
    for (const fn of listeners.fetch) fn(event)
    if (!responsePromise) throw new Error("fetch handler did not respond")
    const res = await responsePromise
    await Promise.all(waits)
    return res
  }

  return {
    cacheStorage,
    dispatchFetch,
    setFetch: (fn: (req: Request) => Promise<Response>) => {
      fetchImpl = fn
    },
  }
}

function htmlResponse(): Response {
  return new Response("<!doctype html><title>within</title>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

function chunkResponse(): Response {
  return new Response("console.log('synthetic-chunk')", {
    status: 200,
    headers: { "Content-Type": "application/javascript" },
  })
}

describe("SW Static-Cache-Persistenz (B15)", () => {
  it("der Static-Asset-Put hängt am Event (waitUntil) — ein sofort gekillter SW verliert den Chunk nicht", async () => {
    const env = makeSwEnv()
    env.setFetch(async () => chunkResponse())
    // Verzögerter Put simuliert den Moment, in dem der Browser den SW direkt
    // nach respondWith beendet: nur ein waitUntil-registrierter Put ist dann
    // noch garantiert.
    const staticCache = await env.cacheStorage.open("within-static-v9")
    staticCache.putDelayMs = 20

    const url = `${ORIGIN}/_next/static/chunks/synthetic-abc123.js`
    await env.dispatchFetch(new Request(url))

    expect(staticCache.store.has(url)).toBe(true)
  })
})

describe("SW Shell-Cache-Deckel (B16)", () => {
  it("hält höchstens SHELL_EXTRA_CAP Nicht-Precache-HTML-Einträge (älteste fliegen raus)", async () => {
    const env = makeSwEnv()
    env.setFetch(async () => htmlResponse())

    for (let i = 0; i < 45; i++) {
      await env.dispatchFetch(
        new Request(`${ORIGIN}/entry/synthetic-${i}`, { headers: { accept: "text/html" } })
      )
    }

    const shell = await env.cacheStorage.open("within-shell-v9")
    const extraEntries = [...shell.store.keys()].filter(
      (url) => !url.endsWith("/") && !url.endsWith("/login")
    )
    expect(extraEntries.length).toBeLessThanOrEqual(40)
    // Die zuletzt besuchten URLs überleben, die ältesten wurden verdrängt.
    expect(shell.store.has(`${ORIGIN}/entry/synthetic-44`)).toBe(true)
    expect(shell.store.has(`${ORIGIN}/entry/synthetic-0`)).toBe(false)
  })
})
