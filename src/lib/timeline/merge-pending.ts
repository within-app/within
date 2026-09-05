/**
 * Merge IDB-queued pending entries into server date groups.
 *
 * Online timeline shows only server entries. This function adds entries that
 * are in the local IDB editQueue (created/updated offline, not yet pushed to
 * the server) so the user sees their own pending work immediately.
 */

import type { DateGroup, TimelineEntry } from "@/types/journal"
import type { QueuedEdit } from "@/lib/sync/types"
import { toTimelineEntry } from "@/lib/sync/idb-to-timeline"
import { dateKey } from "@/lib/timezone"

/**
 * Returns a new DateGroup[] that includes all server entries plus any pending
 * IDB queue entries whose IDs are not already present on the server side.
 * Pending entries carry `pending: true` on their TimelineEntry.
 * Groups are sorted newest-first.
 */
export function mergePendingIntoDateGroups(
  serverGroups: DateGroup[],
  pendingQueue: QueuedEdit[]
): DateGroup[] {
  // Fast-path: nothing pending
  const relevant = pendingQueue.filter((q) => q.operation !== "delete" && q.payload !== null)
  if (relevant.length === 0) return serverGroups

  // Build set of IDs already represented in server groups
  const serverIds = new Set<string>()
  for (const group of serverGroups) {
    for (const entry of group.entries) serverIds.add(entry.id)
  }

  // Convert unseen queue entries to pending TimelineEntry objects; queued
  // updates to server-known ids REPLACE the stale server card — before, they
  // were skipped and the timeline showed the old server text without a
  // pending marker, reading like a lost edit.
  const toMerge: TimelineEntry[] = []
  const replaceById = new Map<string, QueuedEdit>()
  for (const edit of relevant) {
    if (serverIds.has(edit.entryId)) {
      replaceById.set(edit.entryId, edit)
      continue
    }
    toMerge.push({ ...toTimelineEntry(edit.payload!), pending: true })
  }

  if (toMerge.length === 0 && replaceById.size === 0) return serverGroups

  // Clone server groups (shallow — we may mutate entries arrays); swap in the
  // pending version where a queued update exists. UI-only fields the sync
  // protocol does not carry (journalColor, media flags, server thumbnail)
  // stay from the server card.
  const merged: DateGroup[] = serverGroups.map((g) => ({
    ...g,
    entries: g.entries.map((entry) => {
      const edit = replaceById.get(entry.id)
      if (!edit) return entry
      const fresh = toTimelineEntry(edit.payload!)
      return {
        ...fresh,
        journalColor: entry.journalColor,
        thumbnail: fresh.thumbnail ?? entry.thumbnail,
        photoCount: entry.photoCount,
        hasAudio: entry.hasAudio,
        hasVideo: entry.hasVideo,
        pending: true,
      }
    }),
  }))

  for (const entry of toMerge) {
    const key = dateKey(new Date(entry.createdAt))
    const existing = merged.find((g) => g.date === key)
    if (existing) {
      // Pending entry goes first within the day (it's the newest local edit)
      existing.entries = [entry, ...existing.entries]
    } else {
      merged.push({ date: key, formattedDate: key, entries: [entry] })
    }
  }

  merged.sort((a, b) => b.date.localeCompare(a.date))
  return merged
}
