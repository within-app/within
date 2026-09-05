"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import type { IDBAdapter } from "@/lib/sync/idb"
import type { ConflictCopy } from "@/lib/sync/types"
import { restoreConflict, dismissConflict } from "@/lib/sync/conflict-ops"

export function useConflicts() {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([])
  const idbRef = useRef<IDBAdapter | null>(null)

  const getIDB = useCallback(async () => {
    if (!idbRef.current) {
      const { realIDBAdapter } = await import("@/lib/sync/idb")
      idbRef.current = realIDBAdapter
    }
    return idbRef.current
  }, [])

  const refresh = useCallback(async () => {
    const idb = await getIDB()
    setConflicts(await idb.listConflicts())
  }, [getIDB])

  const restore = useCallback(async (conflict: ConflictCopy) => {
    const idb = await getIDB()
    await restoreConflict(idb, conflict)
    await refresh()
  }, [getIDB, refresh])

  const dismiss = useCallback(async (id: string) => {
    const idb = await getIDB()
    await dismissConflict(idb, id)
    await refresh()
  }, [getIDB, refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { conflicts, refresh, restore, dismiss }
}
