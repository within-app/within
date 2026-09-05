"use client"

import { useState } from "react"
import { useSyncContext } from "@/components/sync/sync-provider"
import { WifiOff, RefreshCw, AlertTriangle, CloudCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { ConflictPanel } from "@/components/sync/ConflictPanel"
import { useI18n } from "@/components/locale-provider"

export function SyncBadge() {
  const { online, syncing, pendingCount, conflictCount, triggerSync, error } = useSyncContext()
  const { messages } = useI18n()
  const [conflictPanelOpen, setConflictPanelOpen] = useState(false)

  if (error && !syncing) {
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 transition-colors"
        aria-label={messages.sync.badge.errorAria}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
      </button>
    )
  }

  if (!online) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-label={messages.sync.badge.offlineAria}>
        <WifiOff className="h-3.5 w-3.5" />
        {pendingCount > 0 && (
          <span className="tabular-nums">{pendingCount}</span>
        )}
      </span>
    )
  }

  if (syncing) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-label={messages.sync.badge.syncingAria}>
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      </span>
    )
  }

  if (conflictCount > 0) {
    return (
      <>
        <button
          onClick={() => setConflictPanelOpen(true)}
          className={cn(
            "flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400",
            "hover:text-yellow-700 dark:hover:text-yellow-300 transition-colors"
          )}
          aria-label={messages.sync.badge.conflictsAria(conflictCount)}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="tabular-nums">{conflictCount}</span>
        </button>
        <ConflictPanel open={conflictPanelOpen} onOpenChange={setConflictPanelOpen} />
      </>
    )
  }

  if (pendingCount > 0) {
    return (
      <button
        onClick={triggerSync}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-label={messages.sync.badge.pendingAria(pendingCount)}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="tabular-nums">{pendingCount}</span>
      </button>
    )
  }

  return (
    <span className="flex items-center text-xs text-muted-foreground/60" aria-label={messages.sync.badge.syncedAria}>
      <CloudCheck className="h-3.5 w-3.5" />
    </span>
  )
}
