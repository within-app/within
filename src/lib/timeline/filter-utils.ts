import type { ActiveFilters } from "@/types/journal"
import { DEFAULT_FILTERS } from "@/types/journal"

export function isFilterActive(filters: ActiveFilters, searchQuery: string): boolean {
  if (searchQuery.trim().length > 0) return true
  if (countPanelFilters(filters) > 0) return true
  if (filters.before !== DEFAULT_FILTERS.before) return true
  return false
}

/** Badge-Zahl am Filter-Button: die Panel-Filter (starred/tags/mediaType/
 *  pinned) — `before` hat seinen eigenen Monats-Chip unter der Toolbar. */
export function countPanelFilters(filters: ActiveFilters): number {
  return (
    (filters.starred ? 1 : 0) +
    (filters.tags.length > 0 ? 1 : 0) +
    (filters.mediaType ? 1 : 0) +
    (filters.pinned ? 1 : 0)
  )
}
