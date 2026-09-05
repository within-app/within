/**
 * React hook for offline pin state + actions.
 *
 * Manages entry pin records in IDB and drives Cache Storage population via
 * media-cache.ts. Browser-only; uses dynamic imports to avoid SSR issues.
 */
"use client"

import { useState, useEffect, useCallback } from "react"
import { useI18n } from "@/components/locale-provider"
import { useSyncContext } from "@/components/sync/sync-provider"

interface OfflinePinState {
  isPinned: boolean
  caching: boolean
  error: string | null
}

export function useOfflinePin(
  entryId: string,
  mediaUrls: string[]
): OfflinePinState & { pin: () => Promise<void>; unpin: () => Promise<void> } {
  const [isPinned, setIsPinned] = useState(false)
  const [caching, setCaching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { messages } = useI18n()
  // Pin-Sync: jede Pin/Unpin-Absicht wird als Op gequeued und über
  // den Sync zum Server gepusht (offline: beim nächsten Sync).
  const { triggerSync } = useSyncContext()

  // Load initial pin state from IDB on mount.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { realIDBAdapter } = await import("@/lib/sync/idb")
        const pin = await realIDBAdapter.getPin(entryId)
        if (!cancelled) setIsPinned(pin !== undefined)
      } catch {
        // IDB unavailable (e.g. private browsing) — treat as unpinned.
      }
    }
    void load()
    return () => { cancelled = true }
  }, [entryId])

  const pin = useCallback(async () => {
    setError(null)
    setCaching(true)
    try {
      const [{ realIDBAdapter }, { cacheMediaUrls }, { queuePinOp }, { localPinRecord }] =
        await Promise.all([
          import("@/lib/sync/idb"),
          import("@/lib/offline/media-cache"),
          import("@/lib/sync/pin-ops"),
          import("@/lib/offline/pin-rules"),
        ])
      // Record pin first so the LRU eviction in cacheMediaUrls protects these URLs.
      // localPinRecord flaggt eine leere URL-Liste als mediaUrlsPending — sonst
      // hätte ein Offline-Pin ohne gecachte Medien-Liste nie Fotos im Cache.
      await realIDBAdapter.putPin(localPinRecord(entryId, mediaUrls, new Date().toISOString()))
      await cacheMediaUrls(entryId, mediaUrls)
      await queuePinOp(realIDBAdapter, entryId, true)
      setIsPinned(true)
      void triggerSync()
    } catch (err) {
      setError(err instanceof Error ? err.message : messages.common.unknownError)
    } finally {
      setCaching(false)
    }
  }, [entryId, mediaUrls, messages, triggerSync])

  const unpin = useCallback(async () => {
    setError(null)
    try {
      const [{ realIDBAdapter }, { uncacheEntryMedia }, { queuePinOp }] = await Promise.all([
        import("@/lib/sync/idb"),
        import("@/lib/offline/media-cache"),
        import("@/lib/sync/pin-ops"),
      ])
      await realIDBAdapter.deletePin(entryId)
      await uncacheEntryMedia(entryId)
      await queuePinOp(realIDBAdapter, entryId, false)
      setIsPinned(false)
      void triggerSync()
    } catch (err) {
      setError(err instanceof Error ? err.message : messages.common.unknownError)
    }
  }, [entryId, messages, triggerSync])

  return { isPinned, caching, error, pin, unpin }
}
