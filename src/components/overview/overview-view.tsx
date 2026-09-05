"use client"

import { useState, useEffect } from "react"
import { format } from "date-fns"
import { ChevronRight } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toZonedDate } from "@/lib/timezone"
import type { JournalStats } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { idbToStats } from "@/lib/sync/idb-to-views"
import { getDateFnsLocale, formatNumber } from "@/lib/i18n"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"
import { useI18n } from "@/components/locale-provider"

/**
 * Pure data loader — exported for unit testing.
 * Network first, IndexedDB fallback, null when both fail (skeletons remain).
 */
export async function loadOverviewStats(
  journalId: string | null,
  deps: {
    fetchImpl?: typeof fetch
    getAllEntries?: () => Promise<Parameters<typeof idbToStats>[0]>
  } = {}
): Promise<JournalStats | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const getAllEntries = deps.getAllEntries ?? (() => realIDBAdapter.getAllEntries())
  const params = new URLSearchParams()
  if (journalId) params.set("journalId", journalId)
  try {
    const res = await fetchImpl(`/api/stats?${params}`)
    // A 503 (honest DB-failure answer) carries an {error} body, not stats —
    // parsing it as JournalStats crashes the render. Route it to the IDB fallback.
    if (!res.ok) throw new Error(`stats request failed: ${res.status}`)
    return (await res.json()) as JournalStats
  } catch {
    // Network failed — derive stats from IndexedDB
    try {
      return idbToStats(await getAllEntries(), journalId)
    } catch {
      return null
    }
  }
}

interface OverviewViewProps {
  journalId: string | null
  /** Bump to force a refetch of the stats — the parent signals
   *  deletes/edits this way (stale-data guard). */
  refreshNonce?: number
  /** Öffnet die Vollbild-Lese-Ansicht "An diesem Tag". */
  onOpenOnThisDay?: () => void
}

export function OverviewView({ journalId, refreshNonce = 0, onOpenOnThisDay }: OverviewViewProps) {
  const { messages, locale } = useI18n()
  const [stats, setStats] = useState<JournalStats | null>(null)

  // Fetch stats
  useEffect(() => {
    let cancelled = false
    void loadOverviewStats(journalId).then((s) => {
      if (!cancelled && s) setStats(s)
    })
    return () => {
      cancelled = true
    }
  }, [journalId, refreshNonce])

  const todayLabel = format(toZonedDate(new Date()), messages.date.dayMonthLong, { locale: getDateFnsLocale(locale) })

  return (
    <ScrollArea className="flex-1">
      <div className="px-3 pt-4 pb-6 space-y-1.5">

        {/* ── DayOne-style stats grid ────────────────────────── */}
        <div className="grid grid-cols-2 gap-1.5">

          {/* SERIE — spans 2 rows (left column) */}
          <div className="row-span-2 rounded-xl bg-muted/60 border border-border/20 p-4 flex flex-col justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
              {messages.overview.streak}
            </span>
            <div>
              {stats ? (
                <p className="text-5xl font-bold tabular-nums leading-none text-foreground">
                  {formatNumber(stats.streak, locale)}
                </p>
              ) : (
                <div className="h-12 w-14 rounded-lg bg-muted animate-pulse" />
              )}
              <p className="text-[10px] text-muted-foreground/50 mt-2 leading-none">
                {messages.overview.streakSubtitle}
              </p>
            </div>
          </div>

          {/* EINTRÄGE */}
          <StatCell label={messages.overview.entries} value={stats?.totalEntries} locale={locale} />

          {/* MEDIEN */}
          <StatCell label={messages.overview.media} value={stats?.totalMedia} locale={locale} />

          {/* TAGE */}
          <StatCell label={messages.overview.days} value={stats?.totalDays} locale={locale} />

          {/* LÄNDER */}
          <StatCell label={messages.overview.countries} value={stats?.totalCountries} locale={locale} />
        </div>

        {/* ── AN DIESEM TAG — öffnet die Vollbild-Lese-Ansicht ─ */}
        <button
          onClick={onOpenOnThisDay}
          className="w-full text-left px-4 py-3.5 flex items-center justify-between rounded-xl border bg-muted/60 border-border/20 transition-colors duration-fast cursor-pointer hover:bg-accent/50"
        >
          <div>
            <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50 block mb-1.5">
              {messages.overview.onThisDay}
            </span>
            <div className="flex items-baseline gap-2">
              {stats ? (
                <span className="text-3xl font-bold tabular-nums leading-none text-foreground">
                  {formatNumber(stats.onThisDayCount, locale)}
                </span>
              ) : (
                <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
              )}
              <span className="text-[11px] text-muted-foreground/55">{todayLabel}</span>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        </button>
      </div>
    </ScrollArea>
  )
}

// ── Sub-components ──────────────────────────────────────────

/** Exported for unit testing. undefined = loading (skeleton), null = unknown
 *  (offline fallback has no data for this stat — shown as "–", not a wrong 0). */
export function StatCell({
  label,
  value,
  locale = DEFAULT_LOCALE,
}: {
  label: string
  value: number | null | undefined
  locale?: Locale
}) {
  return (
    <div className="rounded-xl bg-muted/60 border border-border/20 px-4 py-3.5 flex flex-col justify-between min-h-[72px]">
      <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
        {label}
      </span>
      {value === undefined ? (
        <div className="h-7 w-12 rounded-md bg-muted animate-pulse mt-1.5" />
      ) : (
        <p className="text-2xl font-bold tabular-nums leading-none text-foreground mt-1.5">
          {value === null ? "–" : formatNumber(value, locale)}
        </p>
      )}
    </div>
  )
}
