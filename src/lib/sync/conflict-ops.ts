import type { IDBAdapter } from "@/lib/sync/idb"
import type { ConflictCopy } from "@/lib/sync/types"
import { safeUUID } from "@/lib/sync/queue-edit"

/** Restore a conflict copy: enqueue an edit with its text, then clear it. */
export async function restoreConflict(idb: IDBAdapter, conflict: ConflictCopy): Promise<void> {
  const current = await idb.getEntry(conflict.entryId)
  if (current) {
    await idb.enqueueEdit({
      entryId: conflict.entryId,
      operation: "update",
      payload: {
        ...current,
        text: conflict.text,
        tags: conflict.tags,
        updatedAt: new Date().toISOString(),
        revisionId: safeUUID(),
      },
      queuedAt: new Date().toISOString(),
    })
  }
  await idb.clearConflict(conflict.id)
}

/** Dismiss a conflict copy without restoring it. */
export async function dismissConflict(idb: IDBAdapter, id: string): Promise<void> {
  await idb.clearConflict(id)
}
