/**
 * When must open views reload after a sync run?
 *
 * Detail and timeline read server media and the outbox non-atomically while the
 * sync engine runs in parallel. If an upload lands exactly in that window, the
 * photo is in neither source and `cacheEntryMedia` even persists the stale list
 * — going offline afterwards hides the photo until the next online visit, and
 * a pin taken from the open detail view misses the fresh server path. The fix
 * is not to close the window but to heal it: after a sync run that uploaded
 * media, bump the existing reload nonces so open
 * views refetch — that repairs display, cache and pin list in one go.
 */

import type { SyncResult } from "@/lib/sync/types"

/** True when a sync run changed server-side media and open views are stale. */
export function syncRequiresMediaRefresh(result: SyncResult | null): boolean {
  return (result?.mediaUploaded ?? 0) > 0
}
