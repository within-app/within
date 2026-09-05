"use client"

/**
 * Tages-Vorschau: Rechts alle Einträge eines Tages
 * vollständig untereinander, nur Lesen — je Eintrag ein „Öffnen"-Knopf in die
 * Einzelansicht mit Aktionen.
 *
 * Die Wahrheit ist die Tages-Karte: `entries` sind exakt ihre Einträge
 * (gefiltert wie die Timeline, inklusive ausstehender Offline-Einträge,
 * aufsteigend). Aus dem Kalender sind es die
 * Einträge des Tages-Requests — ungefiltert, ohne Timeline-Filter und ohne
 * ausstehende Offline-Einträge. Hier kommen nur Volltext und Medienliste dazu — ein Request
 * pro Tag (loadDayFull, full=true), IDB-Fallback offline; Einträge, die der
 * Server nicht kennt (ausstehend), holen ihren Text aus der IDB.
 *
 * Medien folgen der Regel: offline zeigt nur ein gepinnter Eintrag
 * Fotos — wie die Einzelansicht, in die „Öffnen" führt. Ausnahme
 * (visibleEntryMedia): Dateien, die noch auf ihren
 * Upload warten, liegen auf dem Gerät und werden immer gezeigt.
 */

import { useEffect, useState } from "react"
import { CalendarDays, ChevronLeft, WifiOff } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { OnThisDayEntry } from "@/components/on-this-day/on-this-day-view"
import { loadDayFull } from "@/lib/timeline/day-entries"
import { realIDBAdapter } from "@/lib/sync/idb"
import { readCachedEntryMedia } from "@/lib/sync/entry-media-cache"
import { withVisibleMedia } from "@/lib/offline/pin-rules"
import { foldPendingIntoRows } from "@/lib/sync/pending-media"
import { pendingMediaForDay } from "@/lib/sync/pending-media-preview"
import { revokePreviewUrls } from "@/lib/sync/preview-urls"
import { useOnline } from "@/hooks/use-online"
import { useOfflinePins } from "@/hooks/use-offline-pins"
import { formatEntryDate } from "@/lib/format"
import { useI18n } from "@/components/locale-provider"
import type { FullTimelineEntry, Media, TimelineEntry } from "@/types/journal"

/** Textquelle für Einträge, die der Tages-Request nicht liefert (ausstehend/offline). */
export interface DayRowLookup {
  text: (entryId: string) => Promise<string | null>
  media: (entryId: string) => Promise<Media[]>
  /** Dateien, die für diesen Eintrag noch im Wartekorb liegen — `startOrder`
   *  reiht sie hinter die schon hochgeladenen. Der Aufrufer besitzt die dabei
   *  erzeugten Object-URLs. */
  pending: (entryId: string, startOrder: number) => Promise<Media[]>
}

/**
 * Pure Verknüpfung — exportiert für den Unit-Test: Karten-Einträge (Wahrheit,
 * Reihenfolge) + Server-Volltexte; Lücken über die IDB, notfalls die Vorschau.
 */
export async function joinDayRows(
  cardEntries: TimelineEntry[],
  fullEntries: FullTimelineEntry[],
  lookup: DayRowLookup
): Promise<FullTimelineEntry[]> {
  const byId = new Map(fullEntries.map((e) => [e.id, e]))
  const base = await Promise.all(
    cardEntries.map(async (card) => {
      const hit = byId.get(card.id)
      return hit ? { ...hit, pending: card.pending } : fromLookup(card, lookup)
    })
  )
  // Beide Zweige brauchen den Einschub: die Server-Zeile kennt eine noch nicht
  // hochgeladene Datei nicht, und der offline angelegte Eintrag kommt ganz ohne
  // Medienliste. Dieselbe Regel wie in „An diesem Tag" — foldPendingIntoRows.
  return foldPendingIntoRows(base, lookup.pending)
}

async function fromLookup(
  card: TimelineEntry,
  lookup: DayRowLookup
): Promise<FullTimelineEntry> {
  const text = await lookup.text(card.id).catch(() => null)
  const media = text === null ? [] : await lookup.media(card.id).catch(() => [])
  return { ...card, text: text ?? card.previewText, media }
}

/** Lookup für einen Ladelauf. `urlSink` sammelt die Object-URLs der wartenden
 *  Dateien; der Aufrufer gibt sie beim Aufräumen frei (Muster entry-detail). */
function makeIdbLookup(urlSink: string[]): DayRowLookup {
  return {
    text: async (id) => (await realIDBAdapter.getEntry(id))?.text ?? null,
    media: (id) => readCachedEntryMedia(realIDBAdapter, id),
    // Eine Wartekorb-Lesung für den ganzen Tag, Dekodieren nacheinander —
    // die Zeilen fragen gleichzeitig (Promise.all), der Lader bremst.
    pending: pendingMediaForDay(urlSink),
  }
}

interface DayDetailProps {
  /** UTC-Tagesschlüssel (DateGroup.date), YYYY-MM-DD. */
  date: string
  /** Die Einträge der Tages-Karte — aufsteigend, gefiltert wie die Timeline. */
  entries: TimelineEntry[]
  journalId: string | null
  onBack?: () => void
  onOpenEntry: (id: string) => void
  /** Increment to refetch — Bearbeiten/Löschen/Sync (timelineNonce der Seite). */
  reloadNonce?: number
}

export function DayDetail({ date, entries, journalId, onBack, onOpenEntry, reloadNonce = 0 }: DayDetailProps) {
  const { messages, locale } = useI18n()
  const online = useOnline()
  // undefined = lädt
  const [rows, setRows] = useState<FullTimelineEntry[] | undefined>(undefined)
  const [offline, setOffline] = useState(false)
  const pinnedIds = useOfflinePins(online, reloadNonce)

  // Nur die Identität der Einträge, nicht das Array: `entries` kommt aus einem
  // useMemo über die Timeline-Ziele und bekommt bei jedem Sync-Tick ein neues
  // Array — daran zu hängen hieße, mitten in der offenen Tages-Vorschau die
  // Object-URLs der wartenden Fotos zu revoken und neu zu dekodieren, während
  // die <img>-Tags noch auf den alten URLs stehen (kaputte Bilder). Inhalt und
  // Reihenfolge folgen ohnehin `reloadNonce`.
  const entryIdsKey = entries.map((e) => e.id).join(",")

  useEffect(() => {
    let cancelled = false
    const previewUrls: string[] = []
    // Synchronisation MIT einem externen System (Server-Fetch); der einzige
    // synchrone setState ist das Lade-Skeleton — keine Kaskade. (Die frühere
    // eslint-disable-Zeile ist mit dem primitiven Dep entfallen, die Regel
    // meldet hier nichts mehr.)
    setRows(undefined)
    void loadDayFull(date, journalId)
      .then(async (data) => {
        // Vor dem Wartekorb prüfen: ein abgebrochener Lauf soll nicht noch für
        // jeden Eintrag des Tages Fotos dekodieren (Muster entry-detail).
        if (cancelled) return
        const joined = await joinDayRows(entries, data?.entries ?? [], makeIdbLookup(previewUrls))
        if (cancelled) {
          // Das Aufräumen lief schon über ein damals leeres Array — die
          // hier erzeugten URLs hätte sonst niemand mehr freigegeben.
          revokePreviewUrls(previewUrls)
          return
        }
        setRows(joined)
        setOffline(data === null || data.offline)
      })
      .catch((err: unknown) => {
        // Ohne diesen Zweig bliebe eine unbehandelte Rejection zurück und die
        // Vorschau stünde für immer im Lade-Skeleton.
        console.error("[within/day-detail] loading the day failed:", err)
        if (cancelled) revokePreviewUrls(previewUrls)
        else setRows([])
      })
    return () => {
      cancelled = true
      revokePreviewUrls(previewUrls)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entryIdsKey statt entries, siehe oben
  }, [date, journalId, entryIdsKey, reloadNonce])

  return (
    <ScrollArea className="h-full">
      {/* Mobile back button — wie EntryDetail */}
      {onBack && (
        <div className="md:hidden sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b px-2 py-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ChevronLeft className="h-4 w-4" />
            {messages.common.back}
          </Button>
        </div>
      )}

      <div className="max-w-3xl mx-auto pb-16" data-testid="day-detail">
        {offline && (
          <div className="flex items-center gap-2 mx-6 sm:mx-8 mt-4 px-3 py-2 rounded-lg bg-muted/60 text-muted-foreground text-xs">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            {messages.onThisDay.offlineNotice}
          </div>
        )}

        {rows === undefined && (
          <div className="px-6 sm:px-8 py-10 space-y-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        )}

        {rows && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground/50 px-8 py-24 text-center">
            <CalendarDays className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">
              {messages.onThisDay.noEntriesOn(formatEntryDate(`${date}T12:00:00.000Z`, locale))}
            </p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <DayDetailContent
            date={date}
            entries={rows}
            online={online}
            pinnedIds={pinnedIds}
            onOpenEntry={onOpenEntry}
          />
        )}
      </div>
    </ScrollArea>
  )
}

/** Reiner Inhalt der Tages-Vorschau — exportiert für die SSR-Renderprobe.
 *  `entries` in Kartenreihenfolge (aufsteigend). */
export function DayDetailContent({
  date,
  entries,
  online,
  pinnedIds,
  onOpenEntry,
}: {
  date: string
  entries: FullTimelineEntry[]
  online: boolean
  pinnedIds: ReadonlySet<string> | null
  onOpenEntry: (id: string) => void
}) {
  const { messages, locale } = useI18n()
  return (
    <>
      <header className="px-6 sm:px-8 pt-10">
        <p className="text-xs font-ui font-medium uppercase tracking-widest text-muted-foreground">
          {messages.common.entryCount(entries.length)}
        </p>
        {/* Über den UTC-Tagesschlüssel (Mittag-Anker), nicht über createdAt — der
            wäre lokal formatiert und könnte vom Tag der Karte abweichen. */}
        <h1 className="font-reading text-[26px] sm:text-[28px] font-semibold leading-[1.2] tracking-tight mt-2">
          {formatEntryDate(`${date}T12:00:00.000Z`, locale)}
        </h1>
      </header>
      {entries.map((entry) => (
        <OnThisDayEntry
          key={entry.id}
          // Regel plus Ausnahme: hochgeladene Fotos
          // brauchen offline einen Pin, wartende nie — sie liegen auf dem
          // Gerät. Unbekannte Pins (Lesung läuft noch) zeigen alles.
          entry={withVisibleMedia(entry, online, pinnedIds?.has(entry.id) ?? true)}
          showYearHeader={false}
          onOpen={() => onOpenEntry(entry.id)}
          pending={entry.pending}
        />
      ))}
    </>
  )
}
