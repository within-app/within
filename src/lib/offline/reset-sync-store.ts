/**
 * After a server restore (Settings → Backup → Restore) the server's data is a
 * different generation than what this device last synced — the sync cursor
 * this device holds is meaningless against it. This device must re-pull
 * everything from scratch instead of trusting that cursor, so we drop only
 * the offline sync store and media caches. Unlike resetVaultAndLocalData()
 * (vault.ts, "PIN vergessen" path) this does NOT touch the vault database or
 * the PIN — the device stays unlocked, it just re-syncs.
 */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

export async function resetSyncStore(): Promise<void> {
  await deleteDatabase("within-sync")
  try {
    await caches.delete("within-media-v1")
    await caches.delete("within-media-v2")
  } catch {
    // Cache API unavailable (non-secure context) — nothing cached there either.
  }
}
