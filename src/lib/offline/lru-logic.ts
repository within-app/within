/** One cached full-res media URL tracked in IDB. */
export interface MediaLRUEntry {
  url: string
  entryId: string
  cachedAt: string
  lastAccessedAt: string
  sizeBytes: number
}

/** 200 MiB default offline media cache budget. */
export const DEFAULT_MEDIA_BUDGET_BYTES = 200 * 1024 * 1024

/**
 * Returns the set of URLs to evict to bring the total under budgetBytes.
 * Pinned entries (entryId in pinnedEntryIds) are never selected for eviction.
 * Eviction order: oldest lastAccessedAt first.
 */
export function selectEvictionTargets(
  entries: MediaLRUEntry[],
  pinnedEntryIds: Set<string>,
  budgetBytes: number
): string[] {
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0)
  if (totalBytes <= budgetBytes) return []

  const evictable = entries
    .filter((e) => !pinnedEntryIds.has(e.entryId))
    .sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt))

  const toEvict: string[] = []
  let remaining = totalBytes
  for (const e of evictable) {
    if (remaining <= budgetBytes) break
    toEvict.push(e.url)
    remaining -= e.sizeBytes
  }
  return toEvict
}
