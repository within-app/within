"use client"

import { useState, useEffect, useRef } from "react"
import { format, parseISO } from "date-fns"
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, WifiOff } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { MarkdownContent } from "@/components/detail/markdown-content"
import { PhotoGallery } from "@/components/detail/photo-gallery"
import { AudioPlayer } from "@/components/detail/audio-player"
import { VideoPlayer } from "@/components/detail/video-player"
import { orderDetailMedia } from "@/components/detail/entry-detail"
import { formatEntryDate, formatEntryTime, extractTitle } from "@/lib/format"
import type { FullTimelineEntry } from "@/types/journal"
import { loadFullEntries, type ReadingData, type ReadingDeps } from "@/lib/timeline/day-entries"
import { withVisibleMedia } from "@/lib/offline/pin-rules"
import { foldPendingIntoRows } from "@/lib/sync/pending-media"
import { pendingMediaForDay } from "@/lib/sync/pending-media-preview"
import { revokePreviewUrls } from "@/lib/sync/preview-urls"
import { useOnline } from "@/hooks/use-online"
import { useOfflinePins } from "@/hooks/use-offline-pins"
import { getDateFnsLocale, getMessages } from "@/lib/i18n"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config"
import { useI18n } from "@/components/locale-provider"
import { dateKey, shiftDateKey } from "@/lib/timezone"

// ── Pure Tages-Anker-Helfer — exported for unit testing ─────────────────────
// Der Anker ist ein Kalendertag ohne Zeitpunkt (yyyy-MM-dd, App-Zone —
// Standard UTC), wie month_day_in serverseitig und idbToStats clientseitig.
// Beim Blättern dient das aktuelle Jahr als Kalender: der 29.02. existiert
// als eigener Tag nur, wenn das Ankerjahr ein Schaltjahr ist (beschlossene
// Semantik).

/** Heutiger Kalendertag der App-Zone als Anker. */
export function todayAnchor(now: Date = new Date()): string {
  return dateKey(now)
}

/** Einen Kalendertag vor/zurück — rollt über Monats- und Jahresgrenzen. */
export function stepDay(anchor: string, dir: 1 | -1): string {
  return shiftDateKey(anchor, dir)
}

/** MM-DD des Ankers — der Wert des onThisDay-API-Parameters. */
export function monthDayOf(anchor: string): string {
  return anchor.slice(5)
}

/** Anzeige-Label des Tages, z.B. "5. August". */
export function dayLabel(anchor: string, locale: Locale = DEFAULT_LOCALE): string {
  // Der Anker ist ein Kalendertag ohne Zeitpunkt — date-fns darf ihn lokal
  // parsen (parseISO liest "yyyy-MM-dd" als lokale Mitternacht, keine Zone).
  return format(parseISO(anchor), getMessages(locale).date.dayMonthLong, { locale: getDateFnsLocale(locale) })
}

/** Leerzustands-Text, z.B. "Keine Einträge am 3. August". */
export function emptyText(anchor: string, locale: Locale = DEFAULT_LOCALE): string {
  return getMessages(locale).onThisDay.noEntriesOn(dayLabel(anchor, locale))
}

// ── Daten-Loader — exported for unit testing ────────────────────────────────

/** Daten der Lese-Ansicht — Implementierung geteilt mit der Tages-Vorschau (day-entries.ts). */
export type OnThisDayData = ReadingData

/**
 * Network first, IndexedDB fallback, null when both fail — ein Request pro Tag
 * (onThisDay=MM-DD, full=true: Volltext + Medienliste aller Jahres-Treffer).
 */
export function loadOnThisDayFull(
  monthDay: string,
  journalId: string | null,
  deps: ReadingDeps = {}
): Promise<OnThisDayData | null> {
  return loadFullEntries({ onThisDay: monthDay }, journalId, deps)
}

// ── View ────────────────────────────────────────────────────────────────────

interface OnThisDayViewProps {
  journalId: string | null
  onClose: () => void
  /** Öffnet die normale Detailansicht des Eintrags (schließt diese Ansicht). */
  onEntryOpen?: (entryId: string) => void
}

export function OnThisDayView({ journalId, onClose, onEntryOpen }: OnThisDayViewProps) {
  const { messages, locale } = useI18n()
  const online = useOnline()
  const [anchor, setAnchor] = useState<string>(() => todayAnchor())
  // undefined = lädt, null = weder Netz noch IDB verfügbar
  const [data, setData] = useState<OnThisDayData | null | undefined>(undefined)
  const pinnedIds = useOfflinePins(online)

  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Back-Button/Geste: eigener
  // History-Eintrag beim Öffnen; pop schließt die Ansicht statt die App zu
  // verlassen. Gekapselt auf diese Ansicht — die URL bleibt unverändert,
  // der Service-Worker-Cache ist nicht betroffen.
  useEffect(() => {
    window.history.pushState({ onThisDay: true }, "")
    const onPop = () => onCloseRef.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.history.back()
    }
    window.addEventListener("popstate", onPop)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("popstate", onPop)
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  const monthDay = monthDayOf(anchor)
  useEffect(() => {
    let cancelled = false
    const previewUrls: string[] = []
    // Synchronisation MIT einem externen System (Server-Fetch); der einzige
    // synchrone setState ist das Lade-Skeleton — keine Kaskade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(undefined)
    void loadOnThisDayFull(monthDay, journalId)
      .then(async (d) => {
        // Wartende Dateien einmischen wie in der Tages-Vorschau: eine
        // Wartekorb-Lesung für alle Jahres-Treffer, Dekodieren nacheinander.
        if (cancelled || !d) {
          if (!cancelled) setData(d ?? null)
          return
        }
        // Scheitert der Einschub, kostet das die wartende Datei — nicht den
        // Tag. Ein `null` hier zeigte „weder Netz noch lokale Daten", obwohl
        // die Einträge längst geladen sind.
        let entries = d.entries
        try {
          entries = await foldPendingIntoRows(d.entries, pendingMediaForDay(previewUrls))
        } catch (err) {
          console.error("[within/on-this-day] folding in waiting media failed:", err)
        }
        if (cancelled) {
          // Das Aufräumen lief schon über ein damals leeres Array.
          revokePreviewUrls(previewUrls)
          return
        }
        setData({ ...d, entries })
      })
      .catch((err: unknown) => {
        console.error("[within/on-this-day] loading the day failed:", err)
        if (cancelled) revokePreviewUrls(previewUrls)
        else setData(null)
      })
    return () => {
      cancelled = true
      revokePreviewUrls(previewUrls)
    }
    // `online` ist der einzige Auslöser, den diese Ansicht hat (kein
    // reloadNonce): ohne ihn behielte ein Foto sein „Wartet" auch dann, wenn
    // der Upload längst durch ist, und das Server-Foto käme nie nach.
  }, [monthDay, journalId, online])

  function handleEntryOpen(entryId: string) {
    // back() räumt den eigenen History-Eintrag ab (popstate → onClose),
    // danach übernimmt die normale Detailansicht.
    window.history.back()
    onEntryOpen?.(entryId)
  }

  const entries = data?.entries ?? []

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col"
      role="dialog"
      aria-label={messages.onThisDay.title}
    >
      {/* Header: Zurück + Tages-Blättern */}
      <header className="shrink-0 border-b pt-safe">
        <div className="flex items-center px-2 py-2 gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.history.back()}
            className="gap-1 shrink-0"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">{messages.common.back}</span>
          </Button>

          <div className="flex-1 flex items-center justify-center gap-1 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setAnchor((a) => stepDay(a, -1))}
              aria-label={messages.onThisDay.previousDay}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-center min-w-[130px]">
              <p className="text-sm font-semibold leading-tight">{dayLabel(anchor, locale)}</p>
              <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
                {messages.onThisDay.title}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setAnchor((a) => stepDay(a, 1))}
              aria-label={messages.onThisDay.nextDay}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Symmetrie-Platzhalter, hält das Datum mittig */}
          <div className="w-[68px] sm:w-[88px] shrink-0" />
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto pb-16">
          {/* Offline-Hinweis */}
          {data?.offline && (
            <div className="flex items-center gap-2 mx-6 sm:mx-8 mt-4 px-3 py-2 rounded-lg bg-muted/60 text-muted-foreground text-xs">
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
              {messages.onThisDay.offlineNotice}
            </div>
          )}

          {/* Laden */}
          {data === undefined && (
            <div className="px-6 sm:px-8 py-10 space-y-4">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          )}

          {/* Weder Netz noch lokale Daten */}
          {data === null && (
            <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground/50 px-8 py-24 text-center">
              <WifiOff className="h-10 w-10 opacity-30" />
              <p className="text-sm font-medium">{messages.onThisDay.noDataTitle}</p>
              <p className="text-xs opacity-70">
                {messages.onThisDay.noDataDescription}
              </p>
            </div>
          )}

          {/* Leerzustand */}
          {data && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground/50 px-8 py-24 text-center">
              <CalendarDays className="h-10 w-10 opacity-30" />
              <p className="text-sm font-medium">{emptyText(anchor, locale)}</p>
            </div>
          )}

          {/* Einträge — neuestes Jahr oben, Jahres-Überschrift als Trenner */}
          <OnThisDayEntries
            entries={entries}
            online={online}
            pinnedIds={pinnedIds}
            onOpen={onEntryOpen ? handleEntryOpen : undefined}
          />

          {/* perPage-Deckel erreicht — nicht stillschweigend kappen */}
          {data && data.totalEntries > entries.length && (
            <p className="px-6 sm:px-8 py-4 text-xs text-muted-foreground/60 text-center">
              {messages.onThisDay.loadedCap(entries.length, data.totalEntries)}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Die Einträge der Lese-Ansicht — exportiert für die SSR-Renderprobe.
 *
 * Hier greift die Medien-Regel, die dieser Ansicht bisher ganz
 * fehlte: `OnThisDayEntry` wurde ohne Filter gerendert, also zeigte sie offline
 * auch die Server-Fotos ungepinnter Einträge — Bytes, die es offline nicht
 * gibt. Dazu die Ausnahme für wartende Dateien, die auf dem Gerät
 * liegen. Unbekannte Pins (`null`, Lesung läuft noch) zeigen alles.
 */
export function OnThisDayEntries({
  entries,
  online,
  pinnedIds,
  onOpen,
}: {
  entries: FullTimelineEntry[]
  online: boolean
  pinnedIds: ReadonlySet<string> | null
  onOpen?: (entryId: string) => void
}) {
  return (
    <>
      {entries.map((entry, i) => (
        <OnThisDayEntry
          key={entry.id}
          entry={withVisibleMedia(entry, online, pinnedIds?.has(entry.id) ?? true)}
          showYearHeader={entry.createdAt.slice(0, 4) !== (i > 0 ? entries[i - 1].createdAt.slice(0, 4) : null)}
          onOpen={onOpen ? () => onOpen(entry.id) : undefined}
        />
      ))}
    </>
  )
}

// ── Einzelner Eintrag in der Lese-Ansicht ───────────────────────────────────

/** Ein Eintrag der Lese-Ansicht — auch von der Tages-Vorschau genutzt (day-detail.tsx).
 *  Die Medien-Regel trägt inzwischen `withVisibleMedia`:
 *  beide Ansichten reichen eine bereits gefilterte Medienliste herein, hier
 *  entscheidet nur noch, ob überhaupt etwas da ist. Ein früheres `showMedia`
 *  war damit doppelt gemoppelt und ist entfallen. */
export function OnThisDayEntry({
  entry,
  showYearHeader,
  onOpen,
  pending = false,
}: {
  entry: FullTimelineEntry
  showYearHeader: boolean
  onOpen?: () => void
  /** Tages-Vorschau: Eintrag wartet noch in der Offline-Warteschlange (wie das EntryCard-Badge). */
  pending?: boolean
}) {
  const { messages, locale } = useI18n()
  const { title, body } = extractTitle(entry.text)
  const { photos, videos, audio } = orderDetailMedia(entry.media)

  return (
    <section className="px-6 sm:px-8">
      {showYearHeader && (
        <div className="flex items-center gap-3 pt-10 pb-2">
          <span className="text-3xl font-bold tabular-nums leading-none text-foreground">
            {entry.createdAt.slice(0, 4)}
          </span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}

      <article className="py-6">
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: entry.journalColor }}
            />
            <time className="text-xs font-ui font-medium uppercase tracking-widest text-muted-foreground truncate">
              {formatEntryDate(entry.createdAt, locale)} · {formatEntryTime(entry.createdAt)}
            </time>
            {pending && (
              <span className="flex items-center gap-1 text-[10.5px] text-primary/70 shrink-0" aria-label={messages.timeline.entryCard.pending}>
                <RefreshCw className="h-[9px] w-[9px] shrink-0" aria-hidden />
                {messages.timeline.entryCard.pending}
              </span>
            )}
          </div>
          {onOpen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpen}
              className="h-7 px-2 text-xs text-muted-foreground shrink-0"
            >
              {messages.onThisDay.open}
            </Button>
          )}
        </div>

        {title && (
          <h2 className="font-reading text-[24px] sm:text-[26px] font-semibold leading-[1.25] tracking-tight mb-4">
            {title}
          </h2>
        )}

        {body && <MarkdownContent content={body} />}
        {!title && entry.text && <MarkdownContent content={entry.text} />}

        {photos.length > 0 && (
          <div className="mt-6">
            <PhotoGallery photos={photos} />
          </div>
        )}
        {videos.map((video) => (
          <div key={video.id} className="mt-6">
            <VideoPlayer media={video} />
          </div>
        ))}
        {audio.map((audioFile) => (
          <div key={audioFile.id} className="mt-6">
            <AudioPlayer media={audioFile} />
          </div>
        ))}
      </article>
    </section>
  )
}
