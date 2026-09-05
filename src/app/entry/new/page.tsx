"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { JournalSidebar } from "@/components/journal-sidebar"
import { EntryEditor } from "@/components/editor/entry-editor"
import { loadJournals } from "@/lib/journals/load-journals"
import { useI18n } from "@/components/locale-provider"
import type { Journal } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"

function NewEntryPage() {
  const { messages } = useI18n()
  const searchParams = useSearchParams()
  const defaultJournalId = searchParams.get("journal") ?? undefined
  // ?draft= is set by the Web Share Target handler (/share page).
  const draft = searchParams.get("draft") ?? undefined
  const [journals, setJournals] = useState<Journal[]>([])

  useEffect(() => {
    void loadJournals().then(setJournals)
  }, [])

  return (
    <SidebarProvider defaultOpen={false} className="!min-h-0 h-dvh overflow-hidden">
      <JournalSidebar
        journals={journals}
        selectedJournalId={defaultJournalId ?? null}
        onJournalSelect={() => {}}
        activeFilters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        availableTags={[]}
      />
      <SidebarInset className="overflow-hidden flex flex-col page-enter" style={{ minHeight: 0 }}>
        <header className="flex shrink-0 items-center gap-2 border-b px-4 pt-safe" style={{ minHeight: "calc(3rem + var(--safe-top))" }}>
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-medium text-muted-foreground">{messages.editor.pages.newTitle}</h1>
        </header>
        <div className="flex-1 min-h-0 overflow-hidden">
          {journals.length > 0 ? (
            <EntryEditor
              journals={journals}
              defaultJournalId={defaultJournalId}
              defaultText={draft}
            />
          ) : (
            <div className="p-8 space-y-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function NewEntryPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8"><Skeleton className="h-8 w-48" /></div>}>
      <NewEntryPage />
    </Suspense>
  )
}
