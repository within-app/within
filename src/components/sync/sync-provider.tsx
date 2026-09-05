"use client"

import { createContext, useContext } from "react"
import { useSync, type SyncState } from "@/hooks/useSync"

interface SyncContextValue extends SyncState {
  triggerSync: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue | null>(null)

/** Mounts the sync engine once at the root layout level so all routes get
 *  online/offline event handling, not just page.tsx. */
export function SyncProvider({ children }: { children: React.ReactNode }) {
  const syncState = useSync()
  return <SyncContext.Provider value={syncState}>{children}</SyncContext.Provider>
}

/** Consume the root-level SyncState. Must be inside <SyncProvider>. */
export function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncContext must be inside SyncProvider")
  return ctx
}
