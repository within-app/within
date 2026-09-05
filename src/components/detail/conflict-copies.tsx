"use client"

import { useEffect, useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, History } from "lucide-react"
import { useI18n } from "@/components/locale-provider"
import { formatEntryDate, formatEntryTime } from "@/lib/format"
import type { ConflictCopy as ServerConflictCopy } from "@/lib/sync/types"

type ConflictCopy = Pick<ServerConflictCopy, "id" | "text" | "savedAt" | "updatedAt" | "tags">

/**
 * Zeigt serverseitig gesicherte Konfliktkopien (sync_conflict_copies) eines
 * Eintrags — eingeklappt, nur sichtbar wenn welche existieren. Offline oder
 * bei Fehlern bleibt der Abschnitt schlicht aus (kein eigener Fehlerzustand:
 * die Kopien sind ein Sicherheitsnetz, kein Kerninhalt).
 */
export function ConflictCopies({ entryId }: { entryId: string }) {
  const { messages, locale } = useI18n()
  const [copies, setCopies] = useState<ConflictCopy[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/entries/${entryId}/conflicts`)
      .then((r) => {
        if (!r.ok) throw new Error(`conflicts request failed: ${r.status}`)
        return r.json()
      })
      .then((data: { conflicts: ConflictCopy[] }) => {
        if (!cancelled) setCopies(data.conflicts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [entryId])

  if (copies.length === 0) return null

  return (
    <div className="mt-10">
      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-2 text-xs font-ui font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground">
          <History className="h-3.5 w-3.5" />
          {messages.conflictCopies.title(copies.length)}
          <ChevronDown className="h-3.5 w-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="mt-2 text-xs text-muted-foreground">{messages.conflictCopies.hint}</p>
          <div className="mt-3 space-y-4">
            {copies.map((c) => (
              <div key={c.id} className="rounded-md border p-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  {messages.conflictCopies.savedAt(
                    `${formatEntryDate(c.savedAt, locale)} · ${formatEntryTime(c.savedAt)}`
                  )}
                </p>
                {/* Bewusst Klartext statt Markdown-Render: Kopien sind Rohmaterial */}
                <p className="whitespace-pre-wrap text-sm">{c.text}</p>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
