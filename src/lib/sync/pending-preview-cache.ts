/**
 * Pure cache maintenance for the timeline's preview URLs.
 *
 * The timeline holds one object URL per outbox id, reused across reloads
 * because the virtualiser remounts cards while scrolling and a remount
 * re-requests the URL — a revoke-then-recreate cycle would show a broken image.
 * This module owns the three rules that make that safe:
 *   1. an id already in the cache keeps its URL (reuse, no flicker),
 *   2. ids that left the outbox (uploaded, removed) are revoked and dropped,
 *   3. a failed URL creation caches nothing (no "" entries that shadow later
 *      attempts).
 *
 * Browser capabilities are injected so the rules are testable in node — the
 * regression this guards against ("URL recreated per load, old one revoked
 * immediately") kept all unit and e2e tests green before this existed.
 */

import type { MediaItem } from "@/types/journal"
import type { OutboxMedia } from "@/lib/sync/media-outbox"
import {
  groupPendingByEntry,
  pendingMediaFlags,
  toPendingMediaItem,
  type PendingEntryMeta,
  type PendingTimelineMedia,
} from "@/lib/sync/pending-media"
import { sortByQueuedAt } from "@/lib/sync/pending-media-rows"

export interface PreviewCacheOps {
  /** Preview URL for the item (downscaled where supported). "" = failed. */
  create(item: OutboxMedia): Promise<string>
  revoke(url: string): void
}

/**
 * Fold the outbox into per-entry timeline info while maintaining `urlCache`.
 * One URL per entry (the first pending photo in attach order) — a card shows a
 * single 84px thumbnail, so creating more buys nothing.
 */
export async function syncPendingTimelineMedia(
  items: OutboxMedia[],
  urlCache: Map<string, string>,
  ops: PreviewCacheOps
): Promise<Map<string, PendingTimelineMedia>> {
  const result = new Map<string, PendingTimelineMedia>()
  const live = new Set<string>()

  // Attach order, so "the first photo" matches what the detail shows.
  for (const [entryId, bucket] of groupPendingByEntry(sortByQueuedAt(items))) {
    const firstPhoto = bucket.find((i) => i.type === "photo")
    let thumbnail = ""
    if (firstPhoto) {
      live.add(firstPhoto.id)
      thumbnail = urlCache.get(firstPhoto.id) ?? (await ops.create(firstPhoto))
      if (thumbnail) urlCache.set(firstPhoto.id, thumbnail)
    }
    result.set(entryId, {
      ...pendingMediaFlags(bucket),
      thumbnail: thumbnail || undefined,
    })
  }

  revokeStale(urlCache, live, ops.revoke)

  return result
}

/**
 * The media overview's waiting tiles.
 *
 * Same cache rules as the timeline, different granularity: the overview shows
 * one tile PER waiting photo, not one preview per entry. Video and audio stay
 * out — a tile is a picture, and the overview's offline source already leaves
 * them out for the same reason.
 *
 * `entries` is what the device knows about the entries the files belong to
 * (journal and date). Unknown is not "foreign": a `journalId` filter only drops
 * a tile whose entry is known to belong elsewhere, so an entry created offline
 * — which no read has surfaced yet — keeps its tile. Same convention as
 * `updatedAt: null` in the entry-media cache.
 */
export async function syncPendingMediaTiles(
  items: OutboxMedia[],
  urlCache: Map<string, string>,
  ops: PreviewCacheOps,
  entries: ReadonlyMap<string, PendingEntryMeta>,
  journalId?: string | null
): Promise<MediaItem[]> {
  const tiles: MediaItem[] = []
  // Rule 2 is about files that LEFT the outbox. Everything still queued keeps
  // its URL, including what this run skips (wrong journal, video, audio) —
  // revoking those would re-decode the full-res blob on the next filter
  // toggle, exactly the downscale-decode spike the cache exists to avoid.
  const live = new Set(items.map((i) => i.id))

  // intentionally minimal: one downscaled decode per waiting photo, sequential
  // and uncapped. The outbox is bounded in BYTES (OUTBOX_BUDGET_BYTES, 250 MB),
  // not in file count, so a large queue means many decodes on the phone — the
  // subsampled `resizeWidth` decode keeps each one small (~2 MB instead of
  // ~200 MB peak) and sequencing keeps the peak at one, but the total is O(n)
  // per run. Upgrade path if a real queue ever hurts: decode on tile
  // intersection instead of up front. Not built on a guess.
  //
  // Attach order — the outbox comes back in random-UUID key order, and
  // the order decides which file is decoded first.
  for (const item of sortByQueuedAt(items)) {
    if (item.type !== "photo") continue
    const meta = entries.get(item.entryId)
    if (journalId && meta?.journalId && meta.journalId !== journalId) continue

    const url = urlCache.get(item.id) ?? (await ops.create(item))
    // Rule 3: a failed creation caches nothing — and renders nothing, an
    // empty src would be a broken image where the grid has no placeholder.
    if (!url) continue
    urlCache.set(item.id, url)
    tiles.push(toPendingMediaItem(item, url, meta))
  }

  revokeStale(urlCache, live, ops.revoke)

  // Neueste zuerst wie das übrige Raster (ORDER BY e.created_at DESC): die
  // Kachel trägt das Datum ihres Eintrags, ein Foto an einem alten Eintrag
  // gehört deshalb nicht vor eines von heute.
  return tiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Rule 2: ids that left the outbox lose their URL. */
function revokeStale(
  urlCache: Map<string, string>,
  live: ReadonlySet<string>,
  revoke: (url: string) => void
): void {
  for (const [id, url] of urlCache) {
    if (!live.has(id)) {
      revoke(url)
      urlCache.delete(id)
    }
  }
}
