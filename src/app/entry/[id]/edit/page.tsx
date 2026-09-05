"use client"

import { use, useEffect, useState } from "react"
import { Suspense } from "react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { JournalSidebar } from "@/components/journal-sidebar"
import { EntryEditor } from "@/components/editor/entry-editor"
import type { Journal, JournalEntryDetail } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { loadJournals } from "@/lib/journals/load-journals"
import { idbToEntryDetail } from "@/lib/sync/idb-to-views"
import { useI18n } from "@/components/locale-provider"
import { DEFAULT_FILTERS } from "@/types/journal"

function EditEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { messages } = useI18n()
  const { id } = use(params)
  const [entry, setEntry] = useState<JournalEntryDetail | null>(null)
  const [journals, setJournals] = useState<Journal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      let entryData: JournalEntryDetail | null = null

      // Journals: network-first with IDB fallback
      const journalsData = await loadJournals()

      // Entry: network-first with IDB fallback (also handles 404 for pending entries)
      try {
        const r = await fetch(`/api/entries/${id}`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        entryData = await r.json() as JournalEntryDetail
      } catch {
        try {
          const idbEntry = await realIDBAdapter.getEntry(id)
          if (idbEntry) entryData = idbToEntryDetail(idbEntry)
        } catch { /* IDB unavailable */ }
      }

      setEntry(entryData)
      setJournals(journalsData)
      setLoading(false)
    }
    load()
  }, [id])

  return (
    <SidebarProvider defaultOpen={false} className="!min-h-0 h-dvh overflow-hidden">
      <JournalSidebar
        journals={journals}
        selectedJournalId={entry?.journalId ?? null}
        onJournalSelect={() => {}}
        activeFilters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        availableTags={[]}
      />
      <SidebarInset className="overflow-hidden flex flex-col page-enter" style={{ minHeight: 0 }}>
        <header className="flex shrink-0 items-center gap-2 border-b px-4 pt-safe" style={{ minHeight: "calc(3rem + var(--safe-top))" }}>
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-medium text-muted-foreground">{messages.editor.pages.editTitle}</h1>
        </header>
        <div className="flex-1 min-h-0 overflow-hidden">
          {loading ? (
            <div className="p-8 space-y-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : entry && journals.length > 0 ? (
            <EntryEditor initialEntry={entry} journals={journals} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {messages.editor.pages.notFound}
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function EditEntryPageWrapper({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-8 w-48" /></div>}>
      <EditEntryPage params={params} />
    </Suspense>
  )
}
