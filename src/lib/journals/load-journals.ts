/**
 * Network-first journal list with an IndexedDB fallback.
 *
 * Every editor entry point fetched /api/journals live. Offline that fetch throws,
 * the journal list stayed empty, and entry-editor.tsx fell back to journalId "".
 * Such an edit is queued locally but rejected by POST /api/sync/upsert with
 * 400 "Invalid UUID" on every retry — the entry never reaches the server and is
 * only visible on the device (split-brain).
 *
 * Caching the list on every successful online load gives the offline editor a
 * real journal id to write.
 *
 * The pre-vault localStorage copy ("within.journals.cache") is gone:
 * journal names are content and belong in the encrypted IDB cache only.
 * use-vault-lock.ts deletes the legacy key after setup/unlock.
 */
import { realIDBAdapter } from "@/lib/sync/idb"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { Journal } from "@/types/journal"

interface LoadJournalsOptions {
  fetchFn?: typeof globalThis.fetch
  idb?: IDBAdapter
}

export async function loadJournals(options: LoadJournalsOptions = {}): Promise<Journal[]> {
  const { fetchFn = globalThis.fetch, idb = realIDBAdapter } = options

  let journals: Journal[] | null = null
  try {
    const res = await fetchFn("/api/journals")
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as Journal[]
    if (!Array.isArray(body)) throw new Error("Unerwartete Antwort von /api/journals")
    journals = body
  } catch {
    // Offline or server error — fall back to the last cached list.
    try {
      return (await idb.getJournals?.()) ?? []
    } catch {
      // IDB unavailable or vault locked — no cached list.
      return []
    }
  }

  // Cache writes are best-effort: the online path already has its data.
  try {
    await idb.putJournals?.(journals)
  } catch {
    // ignore — quota, private mode, version change, vault locked
  }
  return journals
}
