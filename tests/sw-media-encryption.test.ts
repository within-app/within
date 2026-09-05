/**
 * Vault P2 (Sicherheitskonzept Offline-Daten §5.4) — der Service Worker
 * verschlüsselt den Medien-Cache.
 *
 * Behavioral-Harness statt Source-Regex: public/sw.js wird in einer
 * Node-Sandbox ausgeführt (Mock für self/caches/clients/fetch, echtes
 * WebCrypto aus Node ≥ 20). So werden Verschlüsselungs-Roundtrip,
 * Fail-closed-Verhalten und Format-Kompatibilität zur Seiten-Hälfte
 * (src/lib/offline/media-encryption.ts) wirklich ausgeführt, nicht nur
 * per Textmuster behauptet.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { generateDekRaw, importDek } from "../src/lib/vault/crypto"
import { encryptMediaResponse } from "../src/lib/offline/media-encryption"

const ORIGIN = "https://within.test"
const MEDIA_URL = `${ORIGIN}/media/photos/synthetic-a.jpg`
const PLAINTEXT = new TextEncoder().encode("synthetic-jpeg-bytes-0123456789")

// ── Cache-Storage-Mock (nur was sw.js nutzt; put lehnt 206 ab wie die echte API) ──

class MemCache {
  store = new Map<string, Response>()
  private key(req: Request | string): string {
    return typeof req === "string" ? new URL(req, ORIGIN).toString() : req.url
  }
  async match(req: Request | string): Promise<Response | undefined> {
    return this.store.get(this.key(req))?.clone()
  }
  async put(req: Request | string, res: Response): Promise<void> {
    if (res.status === 206) throw new TypeError("Partial response (status 206) is unsupported")
    this.store.set(this.key(req), res)
  }
  async delete(req: Request | string): Promise<boolean> {
    return this.store.delete(this.key(req))
  }
}

class MemCacheStorage {
  caches = new Map<string, MemCache>()
  async open(name: string): Promise<MemCache> {
    if (!this.caches.has(name)) this.caches.set(name, new MemCache())
    return this.caches.get(name)!
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

interface FakeClient {
  postMessage: (msg: unknown) => void
}

interface SwEnv {
  listeners: Record<string, ((event: unknown) => void)[]>
  cacheStorage: MemCacheStorage
  windowClients: FakeClient[]
  setFetch: (fn: (req: Request) => Promise<Response>) => void
  fetchCalls: Request[]
  skipWaitingCalls: number
  dispatchMessage: (data: unknown) => void
  dispatchFetch: (request: Request) => Promise<Response>
  dispatchActivate: () => Promise<void>
}

function makeSwEnv(): SwEnv {
  const listeners: SwEnv["listeners"] = { install: [], activate: [], fetch: [], message: [] }
  const cacheStorage = new MemCacheStorage()
  const windowClients: FakeClient[] = []
  const fetchCalls: Request[] = []
  let fetchImpl: (req: Request) => Promise<Response> = async () => {
    throw new TypeError("offline")
  }

  const env: Partial<SwEnv> = {}
  const swClients = {
    matchAll: async () => windowClients,
    claim: async () => {},
  }
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners[type].push(fn),
    skipWaiting: () => {
      env.skipWaitingCalls = (env.skipWaitingCalls ?? 0) + 1
    },
    clients: swClients,
    location: { origin: ORIGIN },
  }
  const fetchFn = (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    fetchCalls.push(req)
    return fetchImpl(req)
  }

  const src = readFileSync(join(__dirname, "../public/sw.js"), "utf8")
  new Function("self", "caches", "clients", "fetch", src)(self, cacheStorage, swClients, fetchFn)

  const dispatchMessage = (data: unknown) => {
    for (const fn of listeners.message) fn({ data })
  }
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
  const dispatchActivate = async (): Promise<void> => {
    const waits: Promise<unknown>[] = []
    const event = {
      waitUntil: (p: Promise<unknown>) => {
        waits.push(Promise.resolve(p).catch(() => {}))
      },
    }
    for (const fn of listeners.activate) fn(event)
    await Promise.all(waits)
  }

  return Object.assign(env, {
    listeners,
    cacheStorage,
    windowClients,
    setFetch: (fn: (req: Request) => Promise<Response>) => {
      fetchImpl = fn
    },
    fetchCalls,
    skipWaitingCalls: 0,
    dispatchMessage,
    dispatchFetch,
    dispatchActivate,
  }) as SwEnv
}

async function makeKey() {
  return importDek(generateDekRaw())
}

function networkPhotoResponse(): Response {
  return new Response(PLAINTEXT.slice(), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(PLAINTEXT.length),
      // Seit dem HTTP-Cache-Fix (23.08.) antwortet der Server selbst mit
      // no-store — der SW reicht Netz-Antworten unverändert durch.
      "Cache-Control": "private, no-store",
    },
  })
}

describe("SW-Medien-Cache verschlüsselt", () => {
  it("Netz-Hit mit Schlüssel: liefert aus, schreibt aber NIE in den Cache (kein Auto-Cache)", async () => {
    // Offline liegen nur noch gepinnte Medien — der Pin-Flow (media-cache.ts)
    // ist der einzige Cache-Schreiber. Vorher cachte der SW jedes online
    // angesehene Foto: ohne LRU-Tracking wuchs der Speicher unbegrenzt und
    // Unpin war gegen die Auto-Kopien wirkungslos.
    const env = makeSwEnv()
    const key = await makeKey()
    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.setFetch(async () => networkPhotoResponse())

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PLAINTEXT)

    const cache = await env.cacheStorage.open("within-media-v2")
    expect(cache.store.size).toBe(0)
  })

  it("Cache-Hit mit Schlüssel: entschlüsselt einen von der Seite geschriebenen Eintrag (Pin-Flow-Format)", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))

    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.status).toBe(200)
    expect(served.headers.get("Content-Type")).toBe("image/jpeg")
    // Klartext existiert nur in der Auslieferung — keine Zwischenschicht darf ihn persistieren.
    expect(served.headers.get("Cache-Control")).toContain("no-store")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PLAINTEXT)
  })

  it("Cache-Hit ohne Schlüssel offline: Platzhalter statt Ciphertext oder Fehler", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.status).toBe(200)
    expect(served.headers.get("Content-Type")).toContain("image/svg+xml")
    expect(served.headers.get("Cache-Control")).toContain("no-store")
    // Der verschlüsselte Eintrag bleibt liegen — nach dem Entsperren ist das Foto wieder da.
    expect(cache.store.has(MEDIA_URL)).toBe(true)
  })

  it("SW-Neustart ohne Schlüssel: holt den Schlüssel per MEDIA_KEY_REQUEST vom Client (Pull)", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const requests: unknown[] = []
    env.windowClients.push({
      postMessage: (msg) => {
        requests.push(msg)
        if ((msg as { type?: string })?.type === "MEDIA_KEY_REQUEST") {
          env.dispatchMessage({ type: "MEDIA_KEY", key })
        }
      },
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(requests).toContainEqual({ type: "MEDIA_KEY_REQUEST" })
    expect(served.headers.get("Content-Type")).toBe("image/jpeg")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PLAINTEXT)
  })

  it("Netz-Hit ohne Schlüssel: liefert aus, schreibt aber NICHTS in den Cache (fail closed)", async () => {
    const env = makeSwEnv()
    env.setFetch(async () => networkPhotoResponse())

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PLAINTEXT)

    const cache = await env.cacheStorage.open("within-media-v2")
    expect(cache.store.size).toBe(0)
  })

  it("MEDIA_KEY_CLEAR (Lock) wirft den Schlüssel weg: danach wieder Platzhalter", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.dispatchMessage({ type: "MEDIA_KEY_CLEAR" })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("Content-Type")).toContain("image/svg+xml")
  })

  it("falscher Schlüssel (z.B. Cache aus früherem Vault): Eintrag wird verworfen, Platzhalter", async () => {
    const env = makeSwEnv()
    const oldKey = await makeKey()
    const newKey = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(oldKey, networkPhotoResponse()))
    env.dispatchMessage({ type: "MEDIA_KEY", key: newKey })
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("Content-Type")).toContain("image/svg+xml")
    // Selbstheilung: der unentschlüsselbare Eintrag blockiert den Key nicht dauerhaft.
    expect(cache.store.has(MEDIA_URL)).toBe(false)
  })

  it("Range-Requests (Video-Seek) gehen am Cache vorbei: online Netz, offline Platzhalter", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    env.dispatchMessage({ type: "MEDIA_KEY", key })

    const partial = new Response(PLAINTEXT.slice(0, 2), {
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-1/${PLAINTEXT.length}` },
    })
    env.setFetch(async () => partial)

    const ranged = new Request(`${ORIGIN}/media/videos/synthetic.mp4`, {
      headers: { range: "bytes=0-1" },
    })
    const served = await env.dispatchFetch(ranged)
    expect(served.status).toBe(206)
    const cache = await env.cacheStorage.open("within-media-v2")
    expect(cache.store.size).toBe(0)

    env.setFetch(async () => {
      throw new TypeError("offline")
    })
    const offline = await env.dispatchFetch(ranged.clone())
    expect(offline.headers.get("Content-Type")).toContain("image/svg+xml")
  })

  it("Offline-Platzhalter landet nie im Cache", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("Content-Type")).toContain("image/svg+xml")
    const cache = await env.cacheStorage.open("within-media-v2")
    expect(cache.store.size).toBe(0)
  })

  it("activate purgt den Klartext-Cache within-media-v1 und behält v2 (Migration §5.4)", async () => {
    const env = makeSwEnv()
    await env.cacheStorage.open("within-media-v1")
    const v2 = await env.cacheStorage.open("within-media-v2")
    const key = await makeKey()
    await v2.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))

    await env.dispatchActivate()

    expect(await env.cacheStorage.has("within-media-v1")).toBe(false)
    expect(await env.cacheStorage.has("within-media-v2")).toBe(true)
    expect(v2.store.has(MEDIA_URL)).toBe(true)
  })

  it("SKIP_WAITING funktioniert weiter neben den neuen Message-Typen", async () => {
    const env = makeSwEnv()
    env.dispatchMessage({ type: "SKIP_WAITING" })
    expect(env.skipWaitingCalls).toBe(1)
  })
})

describe("SW-Marker-Header x-within-sw (HTTP-Cache-Fix)", () => {
  // Seit die Medien-Route selbst `private, no-store` sendet, kann der
  // Guard des Pin-Flows SW-Antworten nicht mehr am Cache-Control
  // erkennen. Der SW markiert deshalb alles, was NICHT frisch vom Netz
  // kommt, mit einem expliziten Header: Platzhalter und Cache-Entschlüsselung.
  // Frische Netz-Antworten bleiben unmarkiert (cachebar für den Pin-Flow).

  it("Offline-Platzhalter trägt x-within-sw: placeholder", async () => {
    const env = makeSwEnv()
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("Content-Type")).toContain("image/svg+xml")
    expect(served.headers.get("x-within-sw")).toBe("placeholder")
  })

  it("Cache-Hit-Entschlüsselung trägt x-within-sw: cache-decrypt (B12-Adoption)", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    const cache = await env.cacheStorage.open("within-media-v2")
    await cache.put(MEDIA_URL, await encryptMediaResponse(key, networkPhotoResponse()))
    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.setFetch(async () => {
      throw new TypeError("offline")
    })

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("Content-Type")).toBe("image/jpeg")
    expect(served.headers.get("x-within-sw")).toBe("cache-decrypt")
  })

  it("frische Netz-Antwort bleibt unmarkiert — der Pin-Flow darf sie cachen", async () => {
    const env = makeSwEnv()
    const key = await makeKey()
    env.dispatchMessage({ type: "MEDIA_KEY", key })
    env.setFetch(async () => networkPhotoResponse())

    const served = await env.dispatchFetch(new Request(MEDIA_URL))
    expect(served.headers.get("x-within-sw")).toBeNull()
  })

  it("Format-Kontrakt: Seiten-Konstanten (media-encryption.ts) matchen die SW-Literale", async () => {
    const enc = await import("../src/lib/offline/media-encryption")
    expect(enc.SW_SERVED_HEADER).toBe("x-within-sw")
    expect(enc.SW_SERVED_PLACEHOLDER).toBe("placeholder")
    expect(enc.SW_SERVED_CACHE_DECRYPT).toBe("cache-decrypt")
  })
})
