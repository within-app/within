/**
 * Repair queued offline edits that carry an unusable journalId.
 *
 * Edits written before the journal cache existed have journalId "" (the editor's
 * fallback when /api/journals failed offline). POST /api/sync/upsert rejects them
 * with 400 "Invalid UUID" on every retry, so they stay queued forever and the
 * entry only ever exists on the device. Rewriting the id to the user's default
 * journal makes them syncable instead of silently stranding them.
 *
 * Pure function — no IDB access, so it is directly testable.
 */
import type { QueuedEdit } from "@/lib/sync/types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUsableJournalId(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value)
}

export interface QueueRepairResult {
  /** Edits whose journalId was rewritten — caller must persist these. */
  repaired: QueuedEdit[]
  /** entryIds that cannot be repaired because no journal is known locally. */
  unrepairable: string[]
}

/**
 * @param queue          the current edit queue
 * @param fallbackJournalId  id of the journal to adopt, or null when none is cached
 */
export function repairQueueJournalIds(
  queue: QueuedEdit[],
  fallbackJournalId: string | null
): QueueRepairResult {
  const repaired: QueuedEdit[] = []
  const unrepairable: string[] = []

  for (const edit of queue) {
    if (!edit.payload) continue
    if (isUsableJournalId(edit.payload.journalId)) continue

    if (!isUsableJournalId(fallbackJournalId)) {
      unrepairable.push(edit.entryId)
      continue
    }

    repaired.push({
      ...edit,
      payload: { ...edit.payload, journalId: fallbackJournalId as string },
    })
  }

  return { repaired, unrepairable }
}
