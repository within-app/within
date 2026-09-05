/**
 * Full-res offline media cache — browser-only.
 *
 * Uses Cache Storage for the actual bytes and IDB (via realIDBAdapter) for
 * LRU metadata. Never import in server code.
 *
 * Budget: DEFAULT_MEDIA_BUDGET_BYTES (200 MiB). Pinned entries survive LRU.
 */
"use client"

import { realIDBAdapter } from "@/lib/sync/idb"
import { getSessionDek } from "@/lib/vault/vault"
import { selectEvictionTargets, DEFAULT_MEDIA_BUDGET_BYTES } from "@/lib/offline/lru-logic"
import { isCacheablePinResponse, pinnablePhotoUrls } from "@/lib/offline/pin-rules"
import type { Media } from "@/types/journal"
import {
  encryptMediaResponse,
  isEncryptedMediaResponse,
  SW_SERVED_HEADER,
} from "@/lib/offline/media-encryption"

// v2 holds only encrypted envelopes (media-encryption.ts). The v1
// plaintext cache is purged on migration (SW activate + reconcileMediaLRU).
export const MEDIA_CACHE_NAME = "within-media-v2"

/**
 * Fetch a set of URLs, store them ENCRYPTED in Cache Storage, record LRU
 * metadata in IDB, then evict oldest non-pinned entries if over budget.
 *
 * Fail closed without a session DEK: no plaintext may ever rest in Cache
 * Storage. Pinning is UI-gated behind the unlocked vault, so a
 * missing key here is a programming error, not a user path.
 */
export async function cacheMediaUrls(
  entryId: string,
  urls: string[],
  budgetBytes = DEFAULT_MEDIA_BUDGET_BYTES
): Promise<void> {
  if (typeof caches === "undefined") return
  const dek = getSessionDek()
  if (!dek) return
  const cache = await caches.open(MEDIA_CACHE_NAME)
  const now = new Date().toISOString()

  for (const url of urls) {
    try {
      const existing = await realIDBAdapter.getMediaLRU(url)
      if (existing) {
        // Already cached — update access time and entryId association.
        await realIDBAdapter.putMediaLRU({ ...existing, lastAccessedAt: now, entryId })
        continue
      }
      const response = await fetch(url)
      // Offline answers the SW's 200er SVG placeholder for uncached
      // /media/ URLs. Storing it here would permanently shadow the real photo
      // (cache-first, excluded from activate cleanup) — it must never be cached.
      // Erkennung über den SW-Marker-Header, nicht mehr über no-store — das
      // sendet der Server jetzt selbst.
      if (
        !isCacheablePinResponse({
          ok: response.ok,
          contentType: response.headers.get("content-type"),
          swServed: response.headers.get(SW_SERVED_HEADER),
        })
      ) {
        // Der Pin-Fetch läuft durch den SW — liegt der Eintrag schon
        // verschlüsselt im Cache, antwortet der SW mit der ENTSCHLÜSSELTEN
        // Response (Marker cache-decrypt). Die ist zu Recht nicht cachebar,
        // aber der vorhandene Eintrag gehört ADOPTIERT (LRU-Zeile schreiben) —
        // sonst purgt der nächste Reconcile den gepinnten Eintrag als untracked.
        // SVG-Platzhalter fallen hier nicht rein: bei denen existiert
        // kein verschlüsselter Cache-Eintrag.
        const existingEntry = await cache.match(url)
        if (existingEntry && isEncryptedMediaResponse(existingEntry)) {
          const cachedBytes = (await existingEntry.clone().arrayBuffer()).byteLength
          await realIDBAdapter.putMediaLRU({
            url,
            entryId,
            cachedAt: now,
            lastAccessedAt: now,
            sizeBytes: cachedBytes,
          })
        }
        continue
      }
      const sizeBytes = parseInt(response.headers.get("content-length") ?? "0", 10) || 0
      // Plaintext size as the LRU heuristic — the GCM envelope adds only
      // IV + tag (28 bytes), irrelevant against a 200 MiB budget.
      await cache.put(url, await encryptMediaResponse(dek, response))
      await realIDBAdapter.putMediaLRU({
        url,
        entryId,
        cachedAt: now,
        lastAccessedAt: now,
        sizeBytes,
      })
    } catch {
      // Network failure for individual URL — skip, don't abort the whole pin.
    }
  }

  await runEviction(budgetBytes)
}

/**
 * Remove cache entries and IDB metadata for the given entry.
 * Called on unpin to free space without waiting for LRU eviction.
 */
export async function uncacheEntryMedia(entryId: string): Promise<void> {
  if (typeof caches === "undefined") return
  const cache = await caches.open(MEDIA_CACHE_NAME)
  const all = await realIDBAdapter.getAllMediaLRU()
  const owned = all.filter((e) => e.entryId === entryId)
  await Promise.all(
    owned.map(async (e) => {
      await cache.delete(e.url)
      await realIDBAdapter.deleteMediaLRU(e.url)
    })
  )
}

/**
 * Remove ONE cached URL plus its LRU row (Preview-Spiegel-Aufräumen).
 * Bytes und LRU-Zeile gehen immer zusammen — ein Cache-Eintrag
 * ohne Zeile wäre für reconcileMediaLRU untracked, eine Zeile ohne Eintrag
 * ein Geist im Eviction-Budget.
 */
export async function uncacheMediaUrl(url: string): Promise<void> {
  if (typeof caches === "undefined") return
  const cache = await caches.open(MEDIA_CACHE_NAME)
  await cache.delete(url)
  await realIDBAdapter.deleteMediaLRU(url)
}

/** Returns true if the URL is currently in Cache Storage. */
export async function isMediaCached(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false
  const cache = await caches.open(MEDIA_CACHE_NAME)
  const hit = await cache.match(url)
  return hit !== undefined
}

/**
 * Evict oldest non-pinned URLs until total size is under budgetBytes.
 * Called automatically after caching, and can be called externally too.
 */
async function runEviction(
  budgetBytes = DEFAULT_MEDIA_BUDGET_BYTES
): Promise<void> {
  if (typeof caches === "undefined") return
  const [allLRU, allPins] = await Promise.all([
    realIDBAdapter.getAllMediaLRU(),
    realIDBAdapter.listPins(),
  ])
  const pinnedIds = new Set(allPins.map((p) => p.entryId))
  const toEvict = selectEvictionTargets(allLRU, pinnedIds, budgetBytes)
  if (toEvict.length === 0) return

  const cache = await caches.open(MEDIA_CACHE_NAME)
  await Promise.all(
    toEvict.map(async (url) => {
      await cache.delete(url)
      await realIDBAdapter.deleteMediaLRU(url)
    })
  )
}

/** Normalise absolute (real Cache API keys) and relative (LRU rows) URLs to
 *  one comparable form. The base only matters for relative inputs. */
function mediaPath(url: string): string {
  const u = new URL(url, "http://sw.invalid")
  return u.pathname + u.search
}

/**
 * Migration + self-healing, both directions. Idempotent; runs after
 * every unlock.
 *
 * 1. Drop the pre-migration plaintext cache (v1).
 * 2. Delete LRU rows without a cache entry — purged v1 entries would leave
 *    ghost rows whose sizeBytes inflate the eviction budget forever (pinned
 *    rows are never evicted, so the eviction loop cannot heal them).
 * 3. Delete cache entries without an LRU row (offline media is pins-only).
 *    Rows are written exclusively by the pin flow, so an untracked entry is
 *    auto-cache legacy — or was written by a not-yet updated SW — and
 *    escapes unpin and the eviction budget.
 */
export async function reconcileMediaLRU(): Promise<void> {
  if (typeof caches === "undefined") return
  // SW activate purges v1 too — this covers devices where the page updates
  // before the new SW takes control.
  await caches.delete("within-media-v1")
  const cache = await caches.open(MEDIA_CACHE_NAME)
  const all = await realIDBAdapter.getAllMediaLRU()
  await Promise.all(
    all.map(async (e) => {
      if (!(await cache.match(e.url))) await realIDBAdapter.deleteMediaLRU(e.url)
    })
  )
  const tracked = new Set(all.map((e) => mediaPath(e.url)))
  await Promise.all(
    (await cache.keys()).map(async (req) => {
      if (!tracked.has(mediaPath(req.url))) await cache.delete(req)
    })
  )

  // 4. Pins, deren Eintrag nicht mehr existiert (Tombstone vom anderen
  //    Gerät, Lösch-Race) — Pin-Record, LRU-Zeilen und Cache-Bytes freigeben.
  //    Gepinnte Zeilen heilt die Eviction nie selbst; ohne diesen Schritt
  //    zählen tote Bytes für immer gegen das 200-MiB-Budget.
  //    Nachgeschärft: „fehlt im lokalen Store" ist KEIN
  //    Löschbeweis — ein online angelegter, sofort gepinnter Eintrag liegt
  //    erst nach dem nächsten Sync-Pull lokal; der alte Check entpinnte ihn
  //    beim nächsten Unlock still. Beweis ist allein die Server-Antwort
  //    404/410 (die Route filtert deleted_at, deckt also auch Tombstones ab);
  //    offline oder bei jedem Anfrage-Fehler: No-op, der nächste Unlock prüft
  //    erneut — nie aus Abwesenheit auf Löschbarkeit schließen.
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    for (const pin of await realIDBAdapter.listPins()) {
      if (await realIDBAdapter.getEntry(pin.entryId)) continue
      try {
        const res = await fetch(`/api/entries/${encodeURIComponent(pin.entryId)}`, {
          method: "HEAD",
        })
        if (res.status === 404 || res.status === 410) {
          await realIDBAdapter.deletePin(pin.entryId)
          await uncacheEntryMedia(pin.entryId)
        }
      } catch {
        // Netz kippte mitten im Abgleich — stehen lassen statt raten.
      }
    }
  }

  // 5. Fehlende Medien lebender Pins nachladen (Pin-Sync) — ein offline
  //    gesetzter Pin hatte nie die Chance zu cachen, ein per Sync adoptierter
  //    kennt seine URLs noch gar nicht.
  await backfillPinnedMedia()
}

/**
 * Backfill für den Pin-Sync: Pins mit `mediaUrlsPending` (per Pull adoptiert
 * — der Sync-Feed trägt keine Medien-Metadaten) lösen ihre URLs über
 * GET /api/entries/[id] auf; danach werden für ALLE Pins fehlende
 * Cache-Einträge nachgeladen. Läuft nach jedem Sync (useSync) und nach
 * jedem Unlock (reconcileMediaLRU). Best effort und fail closed: ohne
 * Session-DEK passiert nichts, Fehler lassen den Pin unverändert stehen —
 * der nächste Lauf probiert es erneut. Gelöscht wird hier NIE (Waisen-Pins
 * räumt allein der server-bestätigte Tombstone-Schritt oben).
 */
export async function backfillPinnedMedia(): Promise<void> {
  if (typeof caches === "undefined") return
  if (typeof navigator !== "undefined" && navigator.onLine === false) return
  if (!getSessionDek()) return
  const cache = await caches.open(MEDIA_CACHE_NAME)

  for (const pin of await realIDBAdapter.listPins()) {
    let current = pin
    if (pin.mediaUrlsPending) {
      try {
        const res = await fetch(`/api/entries/${encodeURIComponent(pin.entryId)}`)
        if (!res.ok) continue // 404 wird über den Tombstone-Schritt oben server-bestätigt geräumt; Rest: nächster Lauf
        const detail = (await res.json()) as { media?: Media[] }
        current = {
          entryId: pin.entryId,
          pinnedAt: pin.pinnedAt,
          mediaUrls: pinnablePhotoUrls(detail.media ?? []),
        }
        await realIDBAdapter.putPin(current)
      } catch {
        continue // Netz kippte — pending stehen lassen, nächster Lauf
      }
    }

    const missing: string[] = []
    for (const url of current.mediaUrls ?? []) {
      const hasRow = await realIDBAdapter.getMediaLRU(url)
      const hasEntry = await cache.match(url)
      if (!hasRow || !hasEntry) missing.push(url)
    }
    if (missing.length > 0) await cacheMediaUrls(current.entryId, missing)
  }
}

/**
 * Touch LRU access time for a URL (call when serving cached media to client).
 * No-op if URL is not in IDB metadata.
 */
export async function touchMediaLRU(url: string): Promise<void> {
  const existing = await realIDBAdapter.getMediaLRU(url)
  if (!existing) return
  await realIDBAdapter.putMediaLRU({ ...existing, lastAccessedAt: new Date().toISOString() })
}
