"use client"

import { use, useEffect, useState } from "react"
import { Suspense } from "react"
import { useRouter } from "next/navigation"
import { ChevronLeft } from "lucide-react"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { JournalSidebar } from "@/components/journal-sidebar"
import { EntryDetail } from "@/components/detail/entry-detail"
import { loadJournals } from "@/lib/journals/load-journals"
import type { Journal } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"
import { useI18n } from "@/components/locale-provider"

function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { messages } = useI18n()
  const [journals, setJournals] = useState<Journal[]>([])

  useEffect(() => {
    void loadJournals().then(setJournals)
  }, [])

  function handleJournalSelect(jId: string | null) {
    if (jId) {
      router.push(`/?journal=${jId}`)
    } else {
      router.push("/")
    }
  }

  return (
    <SidebarProvider defaultOpen={true}>
      <JournalSidebar
        journals={journals}
        selectedJournalId={null}
        onJournalSelect={handleJournalSelect}
        activeFilters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        availableTags={[]}
      />
      <SidebarInset className="page-enter">
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.back()}
            className="gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            {messages.common.back}
          </Button>
        </header>
        <main className="flex-1 overflow-hidden">
          <EntryDetail entryId={id} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function EntryPageWrapper({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  return (
    <Suspense
      fallback={
        <div className="p-8 space-y-4">
          <Skeleton className="h-[300px] w-full" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      }
    >
      <EntryPage params={params} />
    </Suspense>
  )
}
