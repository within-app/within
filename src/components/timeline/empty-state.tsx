"use client"

import { BookOpen, PencilLine, SearchX, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/locale-provider"

interface EmptyStateProps {
  journalName?: string
  isFiltered?: boolean
  onNewEntry?: () => void
  onClearFilters?: () => void
}

export function EmptyState({
  journalName,
  isFiltered,
  onNewEntry,
  onClearFilters,
}: EmptyStateProps) {
  const { messages } = useI18n()
  const t = messages.timeline.emptyState

  if (isFiltered) {
    return (
      <div
        className="flex flex-col items-center justify-center py-24 text-muted-foreground"
        data-testid="empty-state-no-results"
      >
        <SearchX className="h-12 w-12 mb-4 opacity-40" aria-hidden="true" />
        <p className="text-lg font-medium text-foreground">{t.noResultsTitle}</p>
        <p className="text-sm mt-1">{t.noResultsSubtitle}</p>
        {onClearFilters && (
          <Button
            variant="outline"
            size="sm"
            className="mt-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={onClearFilters}
          >
            <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t.resetFilters}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col items-center justify-center py-24 text-muted-foreground"
      data-testid="empty-state-no-entries"
    >
      <BookOpen className="h-12 w-12 mb-4 opacity-40" aria-hidden="true" />
      <p className="text-lg font-medium text-foreground">
        {t.noEntriesTitle(journalName)}
      </p>
      <p className="text-sm mt-1">{t.noEntriesSubtitle}</p>
      {onNewEntry && (
        <Button
          size="sm"
          className="mt-6 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={onNewEntry}
        >
          <PencilLine className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t.firstEntryCta}
        </Button>
      )}
    </div>
  )
}
