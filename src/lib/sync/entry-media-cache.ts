/**
 * Remember an entry's server-side media so the offline view does not
 * lose the photos that are already uploaded.
 *
 * A `SyncEntry` deliberately carries no media at all (src/lib/sync/types.ts), so
 * `idbToEntryDetail` has nothing to report and returns `media: []`. Combined with
 * the pending-outbox merge that produces the worst possible result on an existing
 * entry: attach one photo offline and the three that were already uploaded vanish
 * from the view — the fix for one gap would create a scarier-looking one.
 *
 * What cannot be cached is the pixel data; what can is the *metadata* — three
 * short strings per row. Full-res bytes stay out of IndexedDB (still
 * out of scope): whether a cached path actually renders offline is up to the pin
 * / service-worker cache, and PhotoGallery already degrades to a placeholder when
 * it does not. Showing "there is a photo here, just not available offline" beats
 * showing nothing.
 *
 * Lives in the existing `meta` store for the same reason the journal list does:
 * a dedicated store forces a schema upgrade, and an upgrade is what
 * breaks a PWA whose shell still comes from the service worker cache.
 *
 * The IDB adapter is passed in rather than imported, so the round-trip is
 * testable with a plain stub (same split as the sync engine).
 */

import type { DateGroup, Media } from "@/types/journal"
import type { IDBAdapter } from "@/lib/sync/idb"
import { pendingMediaFlags } from "@/lib/sync/pending-media"

export const ENTRY_MEDIA_META_PREFIX = "entryMedia:"

export function entryMediaMetaKey(entryId: string): string {
  return `${ENTRY_MEDIA_META_PREFIX}${entryId}`
}

/** Just enough of the adapter to store a string — keeps test stubs trivial. */
export type MetaStore = Pick<IDBAdapter, "getMeta" | "setMeta" | "deleteMeta">

/** Window event fired when the cache write hits a storage quota — the
 *  sync badge listens and surfaces it, because on a phone the console is out
 *  of reach and a silently never-writing cache looks exactly like the bug this
 *  module fixes. */
export const STORAGE_ERROR_EVENT = "within:storage-error"

/** Quota errors are the one write-failure class worth surfacing. */
export function isQuotaError(err: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" || err.code === 22)
  )
}

/** Parsed cache value. `updatedAt` is the entry revision the list belongs to. */
export interface CachedEntryMedia {
  media: Media[]
  updatedAt: string | null
}

const EMPTY: CachedEntryMedia = { media: [], updatedAt: null }

/**
 * Cacheable form of a media list, stamped with the entry's `updatedAt`
 * so an offline read can detect that the entry changed since the list was
 * cached (photo deleted on another device → `DELETE /api/media` bumps
 * `updated_at` → the pull transports the mismatch).
 *
 * Pending rows are dropped: their `filePath` is a `blob:` URL that dies with
 * the page, so persisting one would resurrect a dead reference on the next
 * load.
 */
export function serializeEntryMedia(media: Media[], updatedAt: string | null): string {
  return JSON.stringify({ v: 2, updatedAt, media: media.filter((m) => !m.pending) })
}

/**
 * Tolerant parse — a corrupt or foreign value yields a miss, never a throw.
 *
 * Values read from IDB end up as `img src` and as pin fetch targets, and
 * the CSP is a single line of defense at this new trust boundary. So the shape
 * is validated hard: every non-pending row must point under /media/ (a
 * thumbnail too, when present); anything else — including a pending row
 * persisted by a foreign version, whose blob: URL is long dead — makes the
 * whole value a cache miss. Legacy v1 values (plain array, no updatedAt) are a
 * miss too: they cannot be staleness-checked and self-heal on the next
 * online visit.
 */
export function parseEntryMedia(raw: string | null): CachedEntryMedia {
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY
    const box = parsed as { v?: unknown; updatedAt?: unknown; media?: unknown }
    if (box.v !== 2 || typeof box.updatedAt !== "string" || !Array.isArray(box.media)) {
      return EMPTY
    }
    const media: Media[] = []
    for (const m of box.media as unknown[]) {
      if (typeof m !== "object" || m === null) return EMPTY
      const row = m as Media
      if (row.pending) continue // dead blob: leftovers from a foreign version
      if (
        typeof row.id !== "string" ||
        typeof row.type !== "string" ||
        typeof row.filePath !== "string" ||
        !row.filePath.startsWith("/media/")
      ) {
        return EMPTY
      }
      if (
        row.thumbnailPath !== undefined &&
        (typeof row.thumbnailPath !== "string" || !row.thumbnailPath.startsWith("/media/"))
      ) {
        return EMPTY
      }
      media.push(row)
    }
    return { media, updatedAt: box.updatedAt }
  } catch {
    // A malformed cache is a cache miss, not an error worth surfacing.
    return EMPTY
  }
}

/**
 * Store the media of an entry that was just loaded from the server.
 *
 * Overwrites rather than merges: the server list is authoritative, so a photo
 * deleted elsewhere disappears here too on the next online load.
 */
export async function cacheEntryMedia(
  idb: MetaStore,
  entryId: string,
  media: Media[],
  updatedAt: string | null
): Promise<void> {
  try {
    await idb.setMeta(entryMediaMetaKey(entryId), serializeEntryMedia(media, updatedAt))
  } catch (err) {
    // Logged for the desk, surfaced for the phone: a quota-dead cache
    // makes every offline visit look like the accepted "never visited online"
    // limit — without a signal that is indistinguishable from data loss.
    console.error("[within/entry-media] caching the entry media failed:", err)
    if (isQuotaError(err) && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(STORAGE_ERROR_EVENT, {
          detail: "Offline-Speicher voll — Medienlisten werden nicht mehr gesichert",
        })
      )
    }
  }
}

/**
 * Last known server media for an entry. [] when nothing was ever cached.
 *
 * Staleness is NOT checked here — a local offline edit legitimately
 * moves the IDB entry's updatedAt ahead of the cached stamp without touching
 * any media (a read-time comparison hid the server photos in exactly this
 * flow). Invalidation happens where the remote signal arrives: the sync pull
 * drops the key when the incoming updatedAt differs from the local copy
 * (engine.ts), and DELETE /api/media bumps updated_at to create that signal.
 */
export async function readCachedEntryMedia(
  idb: MetaStore,
  entryId: string
): Promise<Media[]> {
  return (await readCachedEntryMediaBox(idb, entryId)).media
}

/**
 * Wie readCachedEntryMedia, aber mit Herkunfts-Signal: `updatedAt === null`
 * heißt Cache-MISS — die Liste ist UNBEKANNT, nicht leer. Der Key wird
 * gedroppt, sobald der Pin-eigene updated_at-Bump gepullt wird; ohne dieses
 * Signal war offline „nie gesehen" von „hat keine Medien" nicht
 * unterscheidbar (Abwesenheit ist kein Beweis) und der Pin-Umschalter
 * verschwand nach einem Offline-Unpin.
 */
export async function readCachedEntryMediaBox(
  idb: MetaStore,
  entryId: string
): Promise<CachedEntryMedia> {
  try {
    return parseEntryMedia(await idb.getMeta(entryMediaMetaKey(entryId)))
  } catch (err) {
    console.error("[within/entry-media] reading the cached entry media failed:", err)
    return { media: [], updatedAt: null }
  }
}

/** Forget an entry's cached media (entry deleted or 404). */
export async function deleteCachedEntryMedia(idb: MetaStore, entryId: string): Promise<void> {
  try {
    await idb.deleteMeta?.(entryMediaMetaKey(entryId))
  } catch (err) {
    console.error("[within/entry-media] deleting the cached entry media failed:", err)
  }
}

/** What a timeline card can derive from a cached server media list. */
export function timelineInfoFromCachedMedia(media: Media[]): {
  photoCount: number
  hasAudio: boolean
  hasVideo: boolean
  thumbnail?: string
} {
  const firstPhoto = media.find((m) => m.type === "photo")
  return {
    ...pendingMediaFlags(media),
    thumbnail: firstPhoto ? firstPhoto.thumbnailPath ?? firstPhoto.filePath : undefined,
  }
}

/**
 * Fold the cached server media into offline timeline groups, so the
 * cards agree with the detail view (which reads the same cache). A SyncEntry
 * carries no media metadata, so the offline groups start at photoCount 0 —
 * without this an entry with three uploaded photos shows no media hint at all,
 * while its detail view shows all three. Entries without a cache entry stay
 * untouched (the accepted "never visited online" limit). Pending outbox counts
 * are added SEPARATELY by applyPendingMediaToGroups — base counts here, deltas
 * there, same layering as the detail view.
 */
export async function applyCachedMediaToGroups(
  idb: MetaStore,
  groups: DateGroup[]
): Promise<DateGroup[]> {
  return Promise.all(
    groups.map(async (group) => ({
      ...group,
      entries: await Promise.all(
        group.entries.map(async (entry) => {
          const cached = await readCachedEntryMedia(idb, entry.id)
          if (cached.length === 0) return entry
          const info = timelineInfoFromCachedMedia(cached)
          return {
            ...entry,
            photoCount: info.photoCount,
            hasAudio: info.hasAudio,
            hasVideo: info.hasVideo,
            thumbnail: entry.thumbnail ?? info.thumbnail,
          }
        })
      ),
    }))
  )
}
