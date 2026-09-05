/**
 * Outbox for media picked while offline.
 *
 * Why an outbox at all: `SyncEntry` deliberately carries no image data
 * (src/lib/sync/types.ts) and the entry payload references server-side paths
 * (`filePath` / `thumbnailPath`) that cannot exist before an upload happened.
 * So an offline attachment cannot travel with the entry — it needs its own
 * queue, flushed once the connection is back.
 *
 * Order matters: `POST /api/sync/upsert` inserts the entry under the id the
 * client generated, and `POST /api/upload?entryId=<id>` writes the media row for
 * an entry that already exists. Media therefore goes AFTER the entry push, not
 * before — an upload for an entry the server has never seen writes the file but
 * silently skips the DB insert (src/app/api/upload/route.ts catches and returns
 * 201 without an `id`).
 *
 * Pure module — no IDB, no fetch — so the decision logic is directly testable
 * (same split as queue-edit.ts).
 */

import type { MediaType } from "@/types/journal"

/** One file waiting to be uploaded. Stored in the `mediaOutbox` IDB store. */
export interface OutboxMedia {
  /** Local id — doubles as the upload idempotency key: it is sent to
   *  `/api/upload` as `clientMediaId` and lands in `media.client_media_id`,
   *  which is what lets a retry find its already-inserted row and
   *  the merge drop a pending row whose upload already landed. */
  id: string
  /** Entry this file belongs to. For offline creates this is the client UUID. */
  entryId: string
  blob: Blob
  fileName: string
  mimeType: string
  type: MediaType
  size: number
  queuedAt: string
  /** Upload attempts so far — a permanently rejected file stops retrying. */
  attempts: number
  lastError?: string
}

/**
 * Hard ceiling for everything waiting in the outbox.
 *
 * `navigator.storage.persist()` is not granted on this device (verified:
 * `granted: false`), so the browser may evict the origin's IndexedDB under
 * pressure. Queuing unbounded originals — a 12 MP photo is ~5 MB — makes that
 * outcome likelier and hides it behind a "saved" checkmark. Over the budget the
 * attachment is refused loudly instead of dropped quietly.
 */
export const OUTBOX_BUDGET_BYTES = 250 * 1024 * 1024

/** After this many failed attempts a file stops being retried automatically. */
export const MAX_UPLOAD_ATTEMPTS = 5

export function outboxBytes(items: Pick<OutboxMedia, "size">[]): number {
  return items.reduce((sum, item) => sum + item.size, 0)
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0)
}

/**
 * Returns a user-facing refusal message when `incomingBytes` would push the
 * outbox past the budget, or null when it fits. Never silently truncates.
 */
export function budgetRejection(
  items: Pick<OutboxMedia, "size">[],
  incomingBytes: number,
  budget = OUTBOX_BUDGET_BYTES
): string | null {
  const used = outboxBytes(items)
  if (used + incomingBytes <= budget) return null
  return (
    `Offline-Speicher voll (${formatMB(used)} von ${formatMB(budget)} MB belegt) — ` +
    `die Datei wurde nicht angehängt. Geh online, damit die wartenden Medien hochgeladen werden.`
  )
}

/**
 * Files that may be uploaded right now, in attach order.
 *
 * `blockedEntryIds` are entries still sitting in the edit queue: their row does
 * not exist on the server yet, so an upload would orphan the file. Attempts are
 * bounded so a permanently rejected file cannot loop forever.
 *
 * Ordering: the outbox store returns key order, and keys are random UUIDs.
 * Uploading in `queuedAt` order keeps the server's `order_index` sequence
 * aligned with what the user saw when attaching (tie-break by id for stability).
 */
export function selectFlushable(
  items: OutboxMedia[],
  blockedEntryIds: Set<string>,
  maxAttempts = MAX_UPLOAD_ATTEMPTS
): OutboxMedia[] {
  return items
    .filter((item) => !blockedEntryIds.has(item.entryId) && item.attempts < maxAttempts)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id))
}

export type UploadVerdict = "attached" | "retry" | "rejected" | "orphaned"

/**
 * Interpret an `/api/upload` response.
 *
 * `ok` without an `id` means the file landed on disk but the media row was not
 * written — the entry is not on the server (yet). That is a retry, not a
 * success: treating it as done would leave the photo invisible forever.
 *
 * The server now refuses before writing bytes when the target
 * entry cannot take a media row — 409 (not pushed yet) keeps the retry
 * semantics of 201-without-id, 410 (entry deleted) means the file has no home
 * anymore and the outbox item should be dropped, not shown as stuck forever.
 */
export function classifyUploadResponse(res: {
  ok: boolean
  status: number
  body: { id?: string } | null
}): UploadVerdict {
  if (!res.ok) {
    // status 0 = fetch threw (offline again); 5xx = server hiccup — both retryable.
    if (res.status === 0 || res.status >= 500) return "retry"
    if (res.status === 409) return "retry"
    if (res.status === 410) return "orphaned"
    return "rejected"
  }
  return res.body?.id ? "attached" : "retry"
}

/** Next state for an item whose upload did not succeed. */
export function markAttempt(item: OutboxMedia, error: string): OutboxMedia {
  return { ...item, attempts: item.attempts + 1, lastError: error }
}

/** A rejected file stops retrying but stays in the outbox so it stays visible. */
export function markRejected(
  item: OutboxMedia,
  error: string,
  maxAttempts = MAX_UPLOAD_ATTEMPTS
): OutboxMedia {
  return { ...item, attempts: maxAttempts, lastError: error }
}

/** True once the item has exhausted its retries and needs the user's attention. */
export function isStuck(item: OutboxMedia, maxAttempts = MAX_UPLOAD_ATTEMPTS): boolean {
  return item.attempts >= maxAttempts
}
