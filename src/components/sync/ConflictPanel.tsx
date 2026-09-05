"use client"

import { AlertTriangle, RotateCcw, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useConflicts } from "@/hooks/useConflicts"
import type { ConflictCopy } from "@/lib/sync/types"
import { useI18n } from "@/components/locale-provider"
import { localeTag } from "@/lib/i18n"

interface ConflictPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConflictPanel({ open, onOpenChange }: ConflictPanelProps) {
  const { conflicts, restore, dismiss } = useConflicts()
  const { messages, locale } = useI18n()

  async function handleRestore(conflict: ConflictCopy) {
    await restore(conflict)
    if (conflicts.length <= 1) onOpenChange(false)
  }

  async function handleDismiss(id: string) {
    await dismiss(id)
    if (conflicts.length <= 1) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            {messages.sync.conflicts.title(conflicts.length)}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-1">
          {messages.sync.conflicts.description}
        </p>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-3 pr-3">
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="rounded-lg border border-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {new Date(conflict.savedAt).toLocaleString(localeTag(locale), {
                    day: "numeric", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </p>
                <p className="text-sm line-clamp-4 whitespace-pre-wrap break-words">
                  {conflict.text || (
                    <span className="italic text-muted-foreground">{messages.sync.conflicts.noContent}</span>
                  )}
                </p>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => handleRestore(conflict)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {messages.sync.conflicts.restore}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1 text-muted-foreground"
                    onClick={() => handleDismiss(conflict.id)}
                  >
                    <X className="h-3 w-3" />
                    {messages.sync.conflicts.dismiss}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
