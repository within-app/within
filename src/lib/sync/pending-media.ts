/**
 * Make media that is still waiting in the offline outbox visible.
 *
 * Both entry read paths describe media the *server* knows about: `/api/entries/<id>`
 * joins the `media` table, and the IDB `entries` store holds a `SyncEntry`, which
 * deliberately carries no image data (src/lib/sync/types.ts). A file picked while
 * offline exists only as a Blob in the `mediaOutbox` store. Until the
 * upload lands, every read path therefore reports the entry as having no photo at
 * all — indistinguishable from "the attachment was lost".
 *
 * This module synthesises `Media` rows from outbox records and folds them into
 * whatever the entry was loaded from. It is deliberately pure — no IDB, no DOM,
 * no `URL.createObjectURL` — so the merge rules are directly testable; the caller
 * supplies the preview URL whose lifetime it owns (same split as
 * media-outbox.ts ↔ idb.ts). The browser half lives in pending-media-preview.ts.
 */

import type { DateGroup, Media, MediaItem } from "@/types/journal"
import { isStuck, type OutboxMedia } from "@/lib/sync/media-outbox"

/** Prefix for synthetic ids, so a pending row can never collide with a DB id. */
export const PENDING_MEDIA_ID_PREFIX = "pending:"

export function pendingMediaId(outboxId: string): string {
  return `${PENDING_MEDIA_ID_PREFIX}${outboxId}`
}

export function isPendingMediaId(id: string): boolean {
  return id.startsWith(PENDING_MEDIA_ID_PREFIX)
}

/**
 * One outbox record as a `Media` row.
 *
 * `previewUrl` is the caller's object URL — or "" when it could not create one,
 * in which case the renderers fall back to their own placeholder instead of a
 * broken image. `thumbnailPath` stays unset on purpose: no server-side thumbnail
 * exists yet — the browser half attaches a locally downscaled preview
 * (pending-media-preview.ts) where the platform supports it.
 *
 * An item that exhausted its retries is flagged `uploadStuck` — it stays
 * visible, but the UI must say "failed", not "waiting": `selectFlushable` will
 * never pick it up again, and a "waiting" badge would be a false safety promise.
 */
export function toPendingMedia(item: OutboxMedia, previewUrl: string, order: number): Media {
  const stuck = isStuck(item)
  return {
    id: pendingMediaId(item.id),
    entryId: item.entryId,
    type: item.type,
    filePath: previewUrl,
    order,
    pending: true,
    clientMediaId: item.id,
    ...(stuck && { uploadStuck: true, uploadError: item.lastError }),
  }
}

/**
 * Append pending rows to the media an entry was loaded with.
 *
 * Server rows win. A file can legitimately exist in BOTH sources at once: the
 * upload confirms with an `id`, then the app dies (or `deleteOutboxMedia`
 * throws) before the outbox record is removed. Two guards therefore:
 * the id guard covers a repeated merge over the same object (React strict-mode
 * double invoke), and the clientMediaId guard drops a pending row whose outbox
 * id already shows up on a server row (the upload landed; the leftover outbox
 * record is retried and resolved by the server's idempotency key).
 */
export function mergePendingMedia(media: Media[], pending: Media[]): Media[] {
  const fresh = unmergedPending(media, pending)
  return fresh.length > 0 ? [...media, ...fresh] : media
}

/**
 * The two guards on their own, for callers that place the pending rows
 * differently: the media overview prepends them (a file attached seconds ago is
 * the newest thing in a grid sorted newest-first — appended after 48 server
 * tiles it would be exactly as invisible as before the fix).
 *
 * Generic over the row shape because both worlds need it: `Media` in the entry
 * views, `MediaItem` in the overview. Only `id` and `clientMediaId` decide.
 */
export function unmergedPending<T extends { id: string; clientMediaId?: string | null }>(
  media: T[],
  pending: T[]
): T[] {
  if (pending.length === 0) return []
  const known = new Set(media.map((m) => m.id))
  const uploaded = new Set(
    media.map((m) => m.clientMediaId).filter((id): id is string => Boolean(id))
  )
  return pending.filter(
    (m) => !known.has(m.id) && !(m.clientMediaId && uploaded.has(m.clientMediaId))
  )
}

/**
 * The media overview's list: waiting tiles folded into the server tiles, both
 * sorted newest-first.
 *
 * Placement is by date, not by position. A waiting tile carries the date of
 * ITS entry, so a photo attached offline to an entry from 2024 belongs among
 * the 2024 tiles — prepending it to a grid that is otherwise strictly
 * descending would put a 2024 label in the first cell. Today's attachment,
 * the ordinary case, still lands at the top because its date says so.
 *
 * The sort is stable, so server rows of the same entry keep the order_index
 * order the route gave them.
 */
export function withPendingTiles(items: MediaItem[], pending: MediaItem[]): MediaItem[] {
  const fresh = unmergedPending(items, pending)
  if (fresh.length === 0) return items
  return [...fresh, ...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** What a waiting tile needs from the entry its file belongs to. */
export interface PendingEntryMeta {
  journalId?: string | null
  createdAt?: string
}

/**
 * One waiting outbox photo as a media-overview tile.
 *
 * `previewUrl` must be a real object URL — the caller drops items whose URL
 * creation failed rather than rendering an `<img src="">`, which the overview
 * has no placeholder for. It doubles as `filePath`: offline only the downscaled
 * preview exists, and a click opens the entry anyway (same trade-off the mirror
 * tiles in idb-to-media.ts already make).
 *
 * `createdAt` follows the entry when the device knows it, so the tile sorts and
 * dates itself like every other tile of that entry; `queuedAt` is the fallback
 * for an entry created offline that no read has surfaced yet.
 */
export function toPendingMediaItem(
  item: OutboxMedia,
  previewUrl: string,
  meta?: PendingEntryMeta
): MediaItem {
  const stuck = isStuck(item)
  return {
    id: pendingMediaId(item.id),
    entryId: item.entryId,
    type: item.type,
    filePath: previewUrl,
    createdAt: meta?.createdAt ?? item.queuedAt,
    journalColor: "",
    pending: true,
    clientMediaId: item.id,
    ...(stuck && { uploadStuck: true, uploadError: item.lastError }),
  }
}

/**
 * Fold the outbox into a list of already-loaded reading rows.
 *
 * The day preview and "on this day" both get finished rows from the server and
 * both have to add what is still waiting locally — the rule lives here once
 * instead of twice in the views. `load` is injected (it touches IDB and object
 * URLs); the caller owns the URLs it creates and decides how the reads are
 * paced.
 *
 * `startOrder` is the row's own media count, so waiting files line up behind
 * the ones already uploaded. A row whose outbox read fails stays as it was —
 * losing the waiting file is bad, losing the whole day is worse.
 */
export async function foldPendingIntoRows<T extends { id: string; media: Media[] }>(
  rows: T[],
  load: (entryId: string, startOrder: number) => Promise<Media[]>
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      // `media` kann bei Server-Zeilen fehlen (loadFullEntries castet, statt zu
      // prüfen). Dann wird die Zeile normalisiert zurückgegeben — sie
      // unverändert durchzureichen hieße nur, den TypeError eine Zeile später
      // beim Aufrufer auszulösen.
      const media = row.media ?? []
      const waiting = await Promise.resolve()
        .then(() => load(row.id, media.length))
        .catch(() => [])
      if (waiting.length === 0) return row.media ? row : { ...row, media }
      return { ...row, media: mergePendingMedia(media, waiting) }
    })
  )
}

/** What a timeline card needs to know about the files waiting for its entry. */
export interface PendingTimelineMedia {
  photoCount: number
  hasAudio: boolean
  hasVideo: boolean
  /** Local preview for the card. Optional — absent when no object URL exists. */
  thumbnail?: string
}

export function pendingMediaFlags(
  items: Pick<OutboxMedia, "type">[]
): { photoCount: number; hasAudio: boolean; hasVideo: boolean } {
  return {
    photoCount: items.filter((i) => i.type === "photo").length,
    hasAudio: items.some((i) => i.type === "audio"),
    hasVideo: items.some((i) => i.type === "video"),
  }
}

/** Bucket the outbox by entry. No index needed — the outbox holds a handful of files. */
export function groupPendingByEntry(items: OutboxMedia[]): Map<string, OutboxMedia[]> {
  const grouped = new Map<string, OutboxMedia[]>()
  for (const item of items) {
    const bucket = grouped.get(item.entryId)
    if (bucket) bucket.push(item)
    else grouped.set(item.entryId, [item])
  }
  return grouped
}

/**
 * Fold pending-media info into timeline entries, whichever source the groups
 * came from — the online path suffers the same blind spot as the offline one
 * (upload running, failed, or out of retries all leave the file in the outbox
 * while the server happily serves the entry without it).
 *
 * Counts add up rather than replace, and a server thumbnail is never overwritten:
 * an already-uploaded photo is the better preview, and it survives a reload.
 */
export function applyPendingMediaToGroups(
  groups: DateGroup[],
  byEntry: Map<string, PendingTimelineMedia>
): DateGroup[] {
  if (byEntry.size === 0) return groups
  let touched = false

  const next = groups.map((group) => ({
    ...group,
    entries: group.entries.map((entry) => {
      const pending = byEntry.get(entry.id)
      if (!pending) return entry
      touched = true
      return {
        ...entry,
        photoCount: entry.photoCount + pending.photoCount,
        hasAudio: entry.hasAudio || pending.hasAudio,
        hasVideo: entry.hasVideo || pending.hasVideo,
        thumbnail: entry.thumbnail ?? pending.thumbnail,
      }
    }),
  }))

  return touched ? next : groups
}
