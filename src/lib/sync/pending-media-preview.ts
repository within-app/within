/**
 * Browser half of the pending-media fix: read the offline outbox and
 * turn it into `Media` rows / timeline flags with a local preview URL.
 *
 * Split from the pure pending-media.ts for the same reason idb.ts is split from
 * media-outbox.ts: this half touches IndexedDB and `URL.createObjectURL` and so
 * cannot run in the node test environment.
 *
 * Object URLs are always caller-owned, in one of two shapes, because the two
 * consumers have genuinely different lifetimes:
 *   - entry detail → a plain array (`urlSink`), revoked when the load effect
 *     tears down. The whole view goes away with it, so nothing can re-request a
 *     revoked URL.
 *   - timeline → a `Map` keyed by outbox id, so a reload reuses the URL a card
 *     already has. The virtualiser unmounts and remounts cards while scrolling,
 *     and a remount re-requests the URL — a revoke-then-recreate cycle would
 *     show a broken image instead.
 * Either way the caller must release them; a leaked full-res photo per visit is
 * what turns a smooth list on the Pi-served phone build into a reload.
 */
"use client"

import { realIDBAdapter } from "@/lib/sync/idb"
import type { OutboxMedia } from "@/lib/sync/media-outbox"
import type { Media, MediaItem } from "@/types/journal"
import {
  type PendingEntryMeta,
  type PendingTimelineMedia,
} from "@/lib/sync/pending-media"
import {
  buildPendingMediaRows,
  makeDayPendingLoader,
  type PendingPreviewFactory,
} from "@/lib/sync/pending-media-rows"
import {
  syncPendingMediaTiles,
  syncPendingTimelineMedia,
} from "@/lib/sync/pending-preview-cache"
import { createPreviewUrl, revokePreviewUrls } from "@/lib/sync/preview-urls"


/** 220px detail tiles at 2× device pixel ratio. The media overview
 *  renders the same size class (2-3 columns), so it shares the width. */
const DETAIL_PENDING_THUMB_WIDTH = 440
/** 84px timeline thumbnail at 2× device pixel ratio. */
const TIMELINE_PENDING_THUMB_WIDTH = 168

/**
 * Object URL of a downscaled preview for a photo blob, or "" when the
 * platform cannot resize (→ caller falls back to the full-res URL, today's
 * behavior). The full-res photo is decoded ONCE here and freed via `close()`;
 * that transient decode is the price for never handing full-res pixels to the
 * grid/timeline `<img>`s, which would each hold their decode simultaneously.
 */
async function createThumbnailPreviewUrl(blob: Blob, targetWidth: number): Promise<string> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return ""
  let bitmap: ImageBitmap | null = null
  try {
    // Subsampled decode — mit resizeWidth dekodiert der Browser das Bild
    // direkt verkleinert und materialisiert nie die Full-Res-Pixel (bei einem
    // 48-MP-Foto der Unterschied zwischen ~2 MB und ~200 MB Peak). Fallback auf
    // den vollen Decode, wo die Option nicht unterstützt wird.
    try {
      bitmap = await createImageBitmap(blob, { resizeWidth: targetWidth, resizeQuality: "medium" })
    } catch {
      bitmap = await createImageBitmap(blob)
    }
    if (bitmap.width <= 0) return ""
    const scale = Math.min(1, targetWidth / bitmap.width)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext("2d")
    if (!ctx) return ""
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const thumbBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.8)
    )
    return thumbBlob ? createPreviewUrl(thumbBlob) : ""
  } catch (err) {
    // Downscaling is an optimization — failing loudly but falling back beats
    // showing no preview at all.
    console.error("[within/pending-media] creating the downscaled preview failed:", err)
    return ""
  } finally {
    bitmap?.close()
  }
}

/** The real browser capabilities behind the pure row builder. */
function previewFactory(thumbWidth: number): PendingPreviewFactory {
  return {
    createUrl: createPreviewUrl,
    createThumbUrl: (blob) => createThumbnailPreviewUrl(blob, thumbWidth),
  }
}

/**
 * Files still waiting for `entryId`, as `Media` rows ordered after `startOrder`.
 *
 * Returns [] on any failure — a broken outbox read must not take the entry view
 * down with it — but logs the cause first.
 */
export async function loadPendingMediaForEntry(
  entryId: string,
  startOrder: number,
  urlSink: string[]
): Promise<Media[]> {
  const items = await readOutbox(() => realIDBAdapter.listOutboxMediaForEntry?.(entryId))
  return buildPendingMediaRows(items, startOrder, urlSink, previewFactory(DETAIL_PENDING_THUMB_WIDTH))
}

/**
 * Pending-media info per entry for the timeline, keyed by entry id.
 *
 * One preview URL per entry (the first pending photo) — a card shows a single
 * 84px thumbnail, so decoding more full-res blobs than that buys nothing.
 *
 * `urlCache` maps outbox id → object URL and is both read and written: an id
 * already in it keeps its URL, and ids that left the outbox (uploaded, removed)
 * are revoked and dropped. So the cache neither grows across reloads nor hands a
 * remounting card a dead URL.
 */
export async function loadPendingMediaByEntry(
  urlCache: Map<string, string>
): Promise<Map<string, PendingTimelineMedia>> {
  const items = await readOutbox(() => realIDBAdapter.listOutboxMedia?.())
  return syncPendingTimelineMedia(items, urlCache, previewCacheOps(TIMELINE_PENDING_THUMB_WIDTH))
}

/**
 * Waiting photos as media-overview tiles, one per file.
 *
 * `urlCache` is maintained exactly as the timeline's: one URL per outbox id,
 * reused across reloads and revoked when the file leaves the outbox. The
 * overview reloads on every journal-filter change and on each page of infinite
 * scroll, so recreating URLs per load would leak one preview per reload.
 *
 * The entries the files belong to are read point-wise: the outbox holds a
 * handful of files, and `getAllEntries` on the online path would be an
 * unbounded read for a filter question. A missing entry stays unknown — see
 * `syncPendingMediaTiles`.
 */
export async function loadPendingMediaTiles(
  urlCache: Map<string, string>,
  journalId?: string | null
): Promise<MediaItem[]> {
  const items = await readOutbox(() => realIDBAdapter.listOutboxMedia?.())
  const ops = previewCacheOps(DETAIL_PENDING_THUMB_WIDTH)
  // Even an empty outbox runs the sync: it revokes URLs whose files are gone.
  const entries = await readEntryMeta(items)
  return syncPendingMediaTiles(items, urlCache, ops, entries, journalId)
}

/**
 * Journal and date of the entries the waiting PHOTOS belong to.
 *
 * Only photos get a tile, so an entry whose queued files are all video/audio
 * costs no read. The handful of reads run together — serialising them would
 * add a round-trip per entry to an effect that fires on every filter change.
 */
async function readEntryMeta(
  items: OutboxMedia[]
): Promise<Map<string, PendingEntryMeta>> {
  const ids = new Set(items.filter((i) => i.type === "photo").map((i) => i.entryId))
  const entries = new Map<string, PendingEntryMeta>()
  await Promise.all(
    [...ids].map(async (entryId) => {
      try {
        const entry = await realIDBAdapter.getEntry(entryId)
        if (entry) entries.set(entryId, { journalId: entry.journalId, createdAt: entry.createdAt })
      } catch (err) {
        // Unknown, not fatal: the tile falls back to queuedAt and skips the filter.
        console.error("[within/pending-media] reading the entry of a waiting file failed:", err)
      }
    })
  )
  return entries
}

/**
 * Downscale-or-full-res fallback, shared by both consumers — the rule
 * ("shrink where the platform can, otherwise hand out the full-res URL") must
 * not drift between the timeline and the overview.
 */
function previewCacheOps(thumbWidth: number) {
  return {
    create: async (item: OutboxMedia) =>
      (await createThumbnailPreviewUrl(item.blob, thumbWidth)) || createPreviewUrl(item.blob),
    revoke: (url: string) => revokePreviewUrls([url]),
  }
}

/**
 * Pending rows for every entry of a day.
 *
 * The day preview asks per entry and in parallel. Calling
 * `loadPendingMediaForEntry` in that loop would walk the whole outbox once per
 * entry (`listOutboxMediaForEntry` has no index, by design) and decode several
 * photos at once. This loader reads the outbox once for the whole day and
 * serialises the decodes; `urlSink` is the caller's, as everywhere else.
 */
export function pendingMediaForDay(
  urlSink: string[]
): (entryId: string, startOrder: number) => Promise<Media[]> {
  return makeDayPendingLoader(
    () => readOutbox(() => realIDBAdapter.listOutboxMedia?.()),
    (items, startOrder) =>
      buildPendingMediaRows(
        items,
        startOrder,
        urlSink,
        previewFactory(DETAIL_PENDING_THUMB_WIDTH)
      )
  )
}

/** Shared read guard: a missing adapter method is not an error, a throw is. */
async function readOutbox(
  read: () => Promise<OutboxMedia[]> | undefined
): Promise<OutboxMedia[]> {
  try {
    return (await read()) ?? []
  } catch (err) {
    console.error("[within/pending-media] reading the offline media outbox failed:", err)
    return []
  }
}
