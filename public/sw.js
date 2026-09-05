// Online-first app-shell cache with offline sync passthrough.
// API routes and dynamic data always hit the network.
// /api/sync/ routes are passed through unconditionally (never cached).
// Static assets (Next.js chunks, fonts, icons) are cached on first fetch.
// HTML navigation requests go network-first, fallback to cached shell.
// /media/ requests are served cache-first; offline + uncached
//           returns an inline SVG placeholder. Cache writes happen only in
//           the page-side pin flow (pins-only offline).

// Bump on any deploy that changes client/server contracts (IDB schema, API shape).
// SHELL_CACHE keeps one HTML entry per visited URL indefinitely, so a route that
// is not re-visited online after a deploy would keep serving the old build's HTML
// — and that HTML boots the old JS chunks, which are still in STATIC_CACHE.
// Bumping invalidates both caches in the activate handler. v4: fixed a stale-chunk edge case.
// v5: new IDB store `mediaOutbox`, editing moved inline.
// v6: MapLibre renderer swap — /map/ (worker pair, glyph PBFs) joins the
//     cache-first static assets so the map keeps working offline. The worker
//     pair is served unhashed, so maplibre-gl upgrades must bump SHELL_VER.
// v7: a SW installed while logged out precached
//     '/' as a redirect-followed response ('/' → 307 → /login, redirected:
//     true); Chromium refuses those as navigation answers (net::ERR_FAILED).
//     The bump discards poisoned shell caches on update; precache now skips
//     redirecting paths (see precacheShellPaths).
// v8: the media cache moves to the encrypted within-media-v2 (see the media
//     crypto section below, and Sicherheitskonzept Offline-Daten §5.4). The
//     bump also retires page chunks whose pin flow still wrote plaintext
//     into within-media-v1: after this SW takes control no cached HTML may
//     boot the old chunks.
// v9: the media route itself now sends
//     `private, no-store`, so the pin guard recognises SW-served responses
//     by the explicit x-within-sw marker instead of no-store. Old page
//     chunks still keying on no-store would silently cache NOTHING against
//     the hardened server — the bump retires them on SW update.
const SHELL_VER = 'v9';
const SHELL_CACHE = `within-shell-${SHELL_VER}`;
const STATIC_CACHE = `within-static-${SHELL_VER}`;
// v1 held plaintext photos and is purged by the activate cleanup (it is
// deliberately absent from the `valid` set); photos re-enter v2 encrypted on
// the next online view or re-pin.
const MEDIA_CACHE = 'within-media-v2';

// SW-Herkunfts-Marker: alles, was NICHT frisch
// vom Netz kommt (Platzhalter, Cache-Entschlüsselung), trägt diesen Header —
// der Pin-Guard der Seite (pin-rules.ts) erkennt SW-Antworten daran, nicht
// mehr am no-store (das sendet die Medien-Route jetzt selbst).
const SW_SERVED_HEADER = 'x-within-sw';
const SW_SERVED_PLACEHOLDER = 'placeholder';
const SW_SERVED_CACHE_DECRYPT = 'cache-decrypt';

// Inline SVG placeholder returned for uncached media when offline.
// Matches the ImageOff visual from lucide-react used elsewhere in the UI.
const OFFLINE_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="2" y1="2" x2="22" y2="22"/>
  <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/>
  <line x1="13.5" y1="6H6a2 2 0 0 0-2 2v10c0 .55.23 1.05.6 1.41"/>
  <path d="M14 14.5 17 11l-4.5-4.5"/>
  <path d="m7 18 4-4"/>
  <rect x="8" y="2" width="14" height="14" rx="2" ry="2"/>
</svg>`;

function offlinePlaceholderResponse() {
  return new Response(OFFLINE_PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
      // Expliziter Herkunfts-Marker für den Pin-Guard: seit der
      // Server selbst no-store sendet, ist der Header die Erkennung —
      // Literale gespiegelt in src/lib/offline/media-encryption.ts
      // (SW_SERVED_*), Kompatibilität fixiert tests/sw-media-encryption.test.ts.
      [SW_SERVED_HEADER]: SW_SERVED_PLACEHOLDER,
    },
  });
}

// Precache the two navigable shells. Other routes are cached on first visit.
const NAV_PRECACHE = ['/', '/login'];

// SHELL_CACHE kept one HTML entry per visited URL indefinitely (see the
// header comment) — thousands of entries over the years raise the origin's
// storage use and with it the browser's eviction risk for the WHOLE origin
// including IndexedDB (storage.persist is denied on the primary device).
// Cap the non-precache entries; the oldest-inserted fall out first. 40 keeps
// every realistically revisited route offline-capable.
const SHELL_EXTRA_CAP = 40;

async function pruneShellCache(cache) {
  try {
    const keys = await cache.keys();
    const extras = keys.filter((req) => {
      const path = new URL(req.url).pathname;
      return !NAV_PRECACHE.includes(path);
    });
    // Cache keys() returns insertion order — delete the oldest overflow.
    const overflow = extras.length - SHELL_EXTRA_CAP;
    for (let i = 0; i < overflow; i++) await cache.delete(extras[i]);
  } catch {
    // Pruning is hygiene, never worth breaking a response over.
  }
}

// Offline incident: the browser's "clear cache" empties CacheStorage
// but keeps the SW registration. install never re-fires for an unchanged sw.js,
// so the shell precache stayed empty and offline navigations resolved
// respondWith(undefined) → net::ERR_FAILED. Two-part hardening:
//   1. refillShellPrecache() restores lost NAV_PRECACHE entries in activate and
//      opportunistically after every successful online navigation.
//   2. The navigation fallback never resolves undefined — last resort is the
//      inline offline notice below instead of a browser error page.
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Within — offline</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;">
<main data-testid="sw-offline-fallback" style="padding:2rem;">
<h1 style="font-size:1.25rem;margin:0 0 .5rem;">Offline — App-Shell fehlt</h1>
<p style="margin:0;color:#94a3b8;">Within einmal online öffnen, danach funktioniert die App wieder offline.</p>
</main>
</body>
</html>`;

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Fetch-and-put each shell path individually WITHOUT following redirects.
// cache.addAll follows them and would store e.g. '/' → 307 → /login as a
// redirected response under '/', which Chromium refuses to serve for a
// navigation (an earlier offline incident). With redirect: 'manual' a
// redirecting path yields an opaqueredirect (not ok) and is skipped: logged
// out only '/login' is precached; '/' arrives redirect-free via the first
// logged-in online navigation. A network failure still rejects, so install
// keeps its retry-on-next-load semantics.
async function precacheShellPaths(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      const res = await fetch(path, { redirect: 'manual' });
      if (res.ok) await cache.put(path, res);
    })
  );
}

// Re-fetch any NAV_PRECACHE entry missing from the shell cache. Swallows all
// failures: an offline refill attempt must never break activation or a response
// — the next online navigation simply retries.
async function refillShellPrecache() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const missing = [];
    for (const path of NAV_PRECACHE) {
      if (!(await cache.match(path))) missing.push(path);
    }
    if (missing.length) await precacheShellPaths(cache, missing);
  } catch {
    // Offline or fetch failed — self-heal on a later online navigation.
  }
}

// ── Media crypto (Sicherheitskonzept Offline-Daten §5.4) ──────────
// Media-cache entries are AES-GCM ciphertext. The key is the vault's session
// DEK, handed over by the page via postMessage as a NON-EXTRACTABLE CryptoKey
// (structured clone keeps it non-extractable) — it exists only in SW memory
// and dies with the SW. Envelope format lives in src/lib/offline/media-encryption.ts;
// the pin flow (media-cache.ts) is the ONLY cache writer
// (by design: offline media = pinned entries only — the former
// auto-cache-on-view grew unbounded and escaped the unpin/eviction
// bookkeeping). The SW only DECRYPTS on serve; it cannot import modules from
// a static public/ script, so the decrypt half lives here twice. The
// cross-format compatibility is locked by tests/sw-media-encryption.test.ts.
const MEDIA_ENC_HEADER = 'x-within-enc';
const MEDIA_ENC_VERSION = 'v1';
const MEDIA_ENC_IV_HEADER = 'x-within-enc-iv';
const MEDIA_ENC_CT_HEADER = 'x-within-enc-ct';
// The SW is killed by the browser after seconds of idle; a restarted SW has
// no key. It then PULLS the key from the open page (MEDIA_KEY_REQUEST) —
// bounded wait, because a locked page never answers: after the timeout the
// request falls through to network/placeholder instead of erroring.
const MEDIA_KEY_WAIT_MS = 1000;

let mediaKey = null; // CryptoKey | null — RAM only, never persisted
let mediaKeyWaiters = [];

function requestMediaKey() {
  if (mediaKey) return Promise.resolve(mediaKey);
  return self.clients
    .matchAll({ type: 'window' })
    .then((clis) => {
      if (!clis.length) return null;
      for (const c of clis) c.postMessage({ type: 'MEDIA_KEY_REQUEST' });
      return new Promise((resolve) => {
        // A synchronously answering client (tests; fast page) may have set the
        // key before this executor runs.
        if (mediaKey) return resolve(mediaKey);
        const timer = setTimeout(() => {
          mediaKeyWaiters = mediaKeyWaiters.filter((w) => w !== settle);
          resolve(null);
        }, MEDIA_KEY_WAIT_MS);
        const settle = (key) => {
          clearTimeout(timer);
          resolve(key);
        };
        mediaKeyWaiters.push(settle);
      });
    })
    .catch(() => null);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isEncryptedMediaResponse(res) {
  return res.headers.get(MEDIA_ENC_HEADER) === MEDIA_ENC_VERSION;
}

// null on a wrong key or tampered ciphertext (GCM authenticates) — the caller
// drops the entry. `no-store` so no further layer persists the plaintext.
async function decryptMediaResponse(key, res) {
  const iv = res.headers.get(MEDIA_ENC_IV_HEADER);
  if (!isEncryptedMediaResponse(res) || !iv) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(iv) },
      key,
      await res.arrayBuffer()
    );
    return new Response(plain, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get(MEDIA_ENC_CT_HEADER) ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        // Marker "aus dem Cache entschlüsselt" — der Pin-Guard lehnt die
        // Antwort ab und ADOPTIERT stattdessen den vorhandenen Eintrag.
        [SW_SERVED_HEADER]: SW_SERVED_CACHE_DECRYPT,
      },
    });
  } catch {
    return null;
  }
}

self.addEventListener('install', (event) => {
  // Do not skipWaiting() unconditionally — the client sends SKIP_WAITING after the user confirms the update prompt.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => precacheShellPaths(cache, NAV_PRECACHE))
  );
});

// SKIP_WAITING: the client triggers activation after the user confirms the
// update prompt. MEDIA_KEY / MEDIA_KEY_CLEAR: the page pushes the media key
// on vault unlock and revokes it on lock (src/lib/vault/media-key-channel.ts).
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg?.type === 'MEDIA_KEY' && msg.key) {
    mediaKey = msg.key;
    for (const settle of mediaKeyWaiters.splice(0)) settle(mediaKey);
  }
  if (msg?.type === 'MEDIA_KEY_CLEAR') mediaKey = null;
});

self.addEventListener('activate', (event) => {
  // MEDIA_CACHE is excluded from cleanup so user-pinned offline media is preserved.
  const valid = new Set([SHELL_CACHE, STATIC_CACHE, MEDIA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !valid.has(k)).map((k) => caches.delete(k))))
      // Self-heal a wiped shell precache; never throws, so activation cannot break offline.
      .then(() => refillShellPrecache())
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Pass through: non-GET, cross-origin, all API calls (including /api/sync/).
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/')
  ) {
    return;
  }

  // /media/ — cache-first over ENCRYPTED entries; SVG
  // placeholder when offline or locked. The explicit pin
  // action (useOfflinePin → media-cache.ts) is the ONLY writer: the SW never
  // puts, so offline storage is exactly the pinned entries and unpin frees it.
  if (url.pathname.startsWith('/media/')) {
    // Range requests (video/audio seek) bypass the cache entirely: Cache
    // Storage rejects 206 responses, so ranged media was never cached — and
    // a GCM-encrypted entry cannot be range-sliced without decrypting the
    // whole file in memory. Offline seek gets the placeholder, the same
    // visible result as before (pins cover photos only).
    if (request.headers.get('range')) {
      event.respondWith(fetch(request).catch(() => offlinePlaceholderResponse()));
      return;
    }

    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached && isEncryptedMediaResponse(cached)) {
          const key = await requestMediaKey();
          if (key) {
            const plain = await decryptMediaResponse(key, cached);
            if (plain) return plain;
            // Wrong key or tampered entry (e.g. cache from a previous vault
            // generation) — drop it and fall through to the network path.
            await cache.delete(request);
          }
          // No key (locked, or the page did not answer): never serve
          // ciphertext — network below, placeholder when offline.
        } else if (cached) {
          // Plaintext entry — cannot happen in v2 via app code, but a foreign
          // writer could plant one. Fail closed: purge, refill encrypted.
          await cache.delete(request);
        }

        try {
          // Intentionally no cache.put here: auto-caching every viewed photo
          // bypassed the LRU bookkeeping (no rows → eviction blind, unpin
          // powerless) and grew storage without bound. Offline media is
          // opt-in via the pin action only (by design).
          return await fetch(request);
        } catch {
          // Offline + not cached/decryptable → SVG placeholder so the UI shows a clean state.
          return offlinePlaceholderResponse();
        }
      })
    );
    return;
  }

  // Cache-first for immutable static assets (Next.js hashed chunks, fonts, icons).
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/map/')
  ) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            // waitUntil, nicht fire-and-forget — dieselbe Fehlerklasse
            // wie der Shell-Put im Offline-Incident: wird der SW direkt
            // nach respondWith gekillt, ginge der Chunk sonst verloren und der
            // nächste Offline-Kaltstart bootet eine Shell ohne ihre Chunks.
            event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.put(request, clone)));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first for HTML navigation — always fresh, fallback to cached shell.
  // For uncached routes (e.g. /entry/new, /entry/[id]) that fail offline,
  // fall back to the precached '/' app shell so the SPA can hydrate from IDB.
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            // waitUntil: the SW may be killed right after respondWith settles;
            // a fire-and-forget put can silently lose the shell entry
            // (an earlier offline incident — the phone's one online cold
            // start did not reliably heal the cache).
            event.waitUntil(
              caches.open(SHELL_CACHE).then(async (c) => {
                await c.put(request, clone);
                // Deckel für Nicht-Precache-HTML-Einträge.
                await pruneShellCache(c);
              })
            );
            // Opportunistic self-heal: we are provably online, so restore any
            // NAV_PRECACHE entries a "clear cache" may have wiped (activate
            // does not re-fire in that case — sw.js is unchanged).
            event.waitUntil(refillShellPrecache());
          }
          return res;
        })
        .catch(() =>
          caches.match(request)
            // Serve guard: never deliver a redirected cache entry to a
            // navigation — Chromium turns it into net::ERR_FAILED. Fall
            // through to the next stage instead (heals caches poisoned
            // before the v7 redirect-free precache).
            .then((cached) => (cached && !cached.redirected ? cached : caches.match('/')))
            .then((cached) => (cached && !cached.redirected ? cached : offlineFallbackResponse()))
            // Never resolve undefined or reject: respondWith(undefined) and a
            // rejected cache lookup both surface as net::ERR_FAILED. Last
            // resort is the inline offline notice.
            .catch(() => offlineFallbackResponse())
        )
    );
    return;
  }
});
