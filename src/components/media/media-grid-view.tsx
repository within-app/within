"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { format } from "date-fns"
import { CloudAlert, CloudOff, ImageOff, Loader2, Play, Music, Video } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import { toZonedDate } from "@/lib/timezone"
import { getDateFnsLocale } from "@/lib/i18n"
import { useI18n } from "@/components/locale-provider"
import type { PaginatedMedia, MediaItem, Media } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { idbToMediaItems, type MirrorView } from "@/lib/sync/idb-to-media"
import { readCachedEntryMediaBox } from "@/lib/sync/entry-media-cache"
import {
  previewPeriodSince,
  readPreviewPeriod,
  readPreviewRegistry,
} from "@/lib/offline/preview-mirror"
import { withPendingTiles } from "@/lib/sync/pending-media"
import { loadPendingMediaTiles } from "@/lib/sync/pending-media-preview"
import { clearPreviewUrlCache } from "@/lib/sync/preview-urls"
import { chainSequential } from "@/lib/sync/run-chain"

interface MediaGridViewProps {
  journalId: string | null
  onEntrySelect: (id: string) => void
  /** Bumped after a sync that changed media (src/app/page.tsx,
   *  syncRequiresMediaRefresh). Without it the overview keeps a waiting tile
   *  badged "Wartet" after its upload landed — a false promise — and shows the
   *  server tile only after a reload. */
  refreshNonce?: number
  /** Set by the hidden ViewChunkWarmer copy. That instance exists to pull the
   *  JS chunk, is thrown away after 15 s, and nobody ever sees its tiles —
   *  decoding the whole waiting outbox there would be pure work on the phone,
   *  and a second URL cache decoding the same blobs next to the visible one. */
  chunkWarmup?: boolean
}

export function MediaGridView({
  journalId,
  onEntrySelect,
  refreshNonce,
  chunkWarmup,
}: MediaGridViewProps) {
  const { messages } = useI18n()
  const [allItems, setAllItems] = useState<MediaItem[]>([])
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [offline, setOffline] = useState(false)
  const [pendingTiles, setPendingTiles] = useState<MediaItem[]>([])
  const loaderRef = useRef<HTMLDivElement>(null)
  /** Preview URLs for photos still in the offline outbox, keyed by outbox id.
   *  Held for the component's lifetime and reused across reloads — the overview
   *  reloads on every filter change and on each infinite-scroll page, and
   *  recreating the URLs per load would leak one preview each time. */
  const pendingPreviewUrls = useRef(new Map<string, string>())
  /** Pending-media loads are chained — two overlapping runs would mutate
   *  the shared URL cache against each other (revoke/create races). */
  const pendingLoadChain = useRef<Promise<unknown>>(Promise.resolve())
  /** Set on unmount, checked by still-running load continuations — a URL
   *  created after clearPreviewUrlCache ran would otherwise never be revoked.
   *  The ViewChunkWarmer mounts and drops this view after 15 s, and decoding a
   *  handful of queued photos can outlast that. */
  const unmountedRef = useRef(false)
  useEffect(() => {
    // Zurücksetzen, nicht nur setzen: React ruft im Dev-StrictMode Effekt →
    // Cleanup → Effekt auf DERSELBEN Fiber auf. Bliebe die Flagge stehen,
    // würde jeder spätere Ladelauf verworfen und die Übersicht zeigte in der
    // Entwicklung dauerhaft null wartende Kacheln — genau der Fehler, den
    // dieser PR behebt.
    unmountedRef.current = false
    const cache = pendingPreviewUrls.current
    return () => {
      unmountedRef.current = true
      clearPreviewUrlCache(cache)
    }
  }, [])

  // Der Wartekorb ist die dritte Quelle der Übersicht, neben /api/media und der
  // IDB (Feldbefund: das Foto liegt auf dem Gerät, also gehört
  // es in die Übersicht). Bewusst in BEIDEN Zuständen, nicht nur offline: auch
  // online kann ein Upload laufen, hängen oder endgültig scheitern — dann fehlt
  // das Foto sonst überall. Gleiche Begründung wie in pending-media.ts für die
  // Timeline.
  //
  // Nicht an `page` gehängt: wartende Kacheln stehen vorn und haben mit der
  // Paginierung nichts zu tun — pro Scroll-Seite den ganzen Wartekorb neu zu
  // lesen wäre reine Arbeit und die halbe Rennfläche.
  useEffect(() => {
    if (chunkWarmup) return
    let cancelled = false
    chainSequential(pendingLoadChain, () =>
      loadPendingMediaTiles(pendingPreviewUrls.current, journalId)
    )
      .then((tiles) => {
        if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
        else if (!cancelled) setPendingTiles(tiles)
      })
      .catch((err: unknown) => {
        // Ein kaputter Wartekorb darf die Übersicht nicht mitreißen. Der
        // Unmount-Zweig muss auch hier laufen: ein Lauf, der nach dem
        // Aufräumen bei Foto n+1 wirft, hat für n Fotos bereits URLs in den
        // verwaisten Cache geschrieben.
        if (unmountedRef.current) clearPreviewUrlCache(pendingPreviewUrls.current)
        console.error("[within/media] loading waiting media failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [journalId, refreshNonce, chunkWarmup])

  // Reset when journal filter changes
  useEffect(() => {
    setPage(1)
    setAllItems([])
    setHasNextPage(false)
    setLoading(true)
    setOffline(false)
  }, [journalId, refreshNonce])

  // Fetch media — appends on page > 1, replaces on page 1
  useEffect(() => {
    const controller = new AbortController()

    if (page === 1) setLoading(true)
    else setLoadingMore(true)

    const params = new URLSearchParams({ page: String(page), perPage: "48" })
    if (journalId) params.set("journalId", journalId)

    fetch(`/api/media?${params}`, { signal: controller.signal })
      .then((r) => {
        // Error bodies ({error}) sind kein PaginatedMedia — ohne diesen Check
        // wird data.photos undefined und der Render crasht (statt Offline-Hinweis).
        if (!r.ok) throw new Error(`media request failed: ${r.status}`)
        return r.json()
      })
      .then((data: PaginatedMedia) => {
        if (page === 1) {
          setAllItems(data.photos)
        } else {
          setAllItems((prev) => [...prev, ...data.photos])
        }
        setHasNextPage(data.page < data.totalPages)
        setLoading(false)
        setLoadingMore(false)
      })
      .catch(async (err: unknown) => {
        if ((err as Error).name === "AbortError") return
        // Offline-Fallback („Gepinnte + Thumbnails"):
        // eine Kachel pro Eintrag aus dem Timeline-Thumbnail (IDB, data:-URL),
        // gepinnte Einträge mit bekannter Medien-Liste zeigen ihre echten
        // Foto-Kacheln aus dem verschlüsselten Pin-Cache. Erst wenn auch
        // lokal nichts liegt, bleibt der bisherige Offline-Hinweis.
        if (page === 1) {
          try {
            const [entries, pins] = await Promise.all([
              realIDBAdapter.getAllEntries(),
              realIDBAdapter.listPins(),
            ])
            const pinnedMedia = new Map<string, Media[]>()
            for (const pin of pins) {
              const box = await readCachedEntryMediaBox(realIDBAdapter, pin.entryId)
              // updatedAt null = Liste UNBEKANNT (kein Cache-Hit) — dann
              // greift die Thumbnail-Kachel, nicht eine leere echte Liste.
              if (box.updatedAt !== null) pinnedMedia.set(pin.entryId, box.media)
            }
            // Zeitraum-Spiegel: Registry = die Vorschauen, die
            // der Spiegel für den eingestellten Zeitraum verwaltet — der SW
            // liefert ihre Bytes offline aus dem verschlüsselten Cache.
            let mirror: MirrorView | null = null
            const period = await readPreviewPeriod()
            if (period !== "off") {
              const registry = await readPreviewRegistry()
              mirror = {
                since: previewPeriodSince(period, new Date()),
                items: registry.items,
                pinnedEntryIds: new Set(pins.map((p) => p.entryId)),
              }
            }
            const items = idbToMediaItems(entries, pinnedMedia, journalId, mirror)
            if (items.length > 0) {
              setAllItems(items)
              setHasNextPage(false)
            } else {
              setOffline(true)
            }
          } catch {
            setOffline(true)
          }
        }
        setLoading(false)
        setLoadingMore(false)
      })

    return () => controller.abort()
  }, [journalId, page, refreshNonce])

  // IntersectionObserver: auto-load next page when sentinel enters viewport
  useEffect(() => {
    if (!loaderRef.current || !hasNextPage || loadingMore || loading) return
    const el = loaderRef.current
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setPage((p) => p + 1)
      },
      { rootMargin: "150px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, loadingMore, loading])

  // Platzierung nach Datum, nicht nach Position — die Regel steht in
  // withPendingTiles, damit sie testbar ist und nicht in der Komponente hängt.
  const visibleItems = useMemo(
    () => withPendingTiles(allItems, pendingTiles),
    [allItems, pendingTiles]
  )

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <MediaGridSkeleton />
      </div>
    )
  }

  if (offline && visibleItems.length === 0) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-3 text-muted-foreground/50 p-8 text-center">
        <ImageOff className="h-10 w-10 opacity-30" />
        <p className="text-sm">{messages.media.offlineTitle}</p>
        <p className="text-xs opacity-70">{messages.media.offlineDescription}</p>
      </div>
    )
  }

  if (visibleItems.length === 0) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-3 text-muted-foreground/50 p-8 text-center">
        <ImageOff className="h-10 w-10 opacity-30" />
        <p className="text-sm">{messages.media.emptyTitle}</p>
        <p className="text-xs opacity-70">{messages.media.emptyDescription}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="grid gap-0.5 p-0.5 grid-cols-2 sm:grid-cols-3">
          {visibleItems.map((item) => {
            if (item.type === "video") {
              return (
                <VideoTile
                  key={item.id}
                  item={item}
                  onClick={() => onEntrySelect(item.entryId)}
                />
              )
            }
            if (item.type === "audio") {
              return (
                <AudioTile
                  key={item.id}
                  item={item}
                  onClick={() => onEntrySelect(item.entryId)}
                />
              )
            }
            return (
              <PhotoTile
                key={item.id}
                item={item}
                onClick={() => onEntrySelect(item.entryId)}
              />
            )
          })}
        </div>

        {/* Infinite scroll sentinel + loading indicator */}
        <div ref={loaderRef} className="flex items-center justify-center py-6 min-h-[60px]">
          {loadingMore && (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export function PhotoTile({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  const { messages, locale } = useI18n()
  const dateLabel = format(toZonedDate(new Date(item.createdAt)), messages.date.dayMonthShort, { locale: getDateFnsLocale(locale) })
  const gallery = messages.detail.gallery
  // Das aria-label des Buttons verdeckt den Badge-Text für Screenreader —
  // der Zustand muss deshalb mit ins Label, nicht nur ins Bild.
  const stateLabel = !item.pending ? null : item.uploadStuck ? gallery.uploadFailed : gallery.pending

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative group block overflow-hidden cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      )}
      style={{ aspectRatio: "1 / 1" }}
      aria-label={[messages.media.photoAlt(dateLabel), stateLabel].filter(Boolean).join(" — ")}
    >
      <img
        src={item.thumbnailPath ?? item.filePath}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-slow group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        style={{ display: "block" }}
        onError={(e) => {
          const img = e.currentTarget
          if (img.src !== item.filePath) img.src = item.filePath
        }}
      />

      {/* Warte-Kennzeichen — oben links, weil unten links das Hover-Datum
          sitzt und beide sich sonst überlagern. Dieselbe Aussage wie in der
          Galerie der Einzelansicht: ohne sie ist eine lokale Vorschau nicht von einem
          hochgeladenen Foto zu unterscheiden. Eine ausgereizte Datei
          geht NIE mehr hoch, „Wartet" wäre dort ein falsches Versprechen. */}
      {item.pending && (item.uploadStuck ? (
        <span
          className="absolute top-1.5 left-2 flex items-center gap-1 rounded bg-red-600/80 px-1.5 py-0.5 text-[10px] font-medium text-white"
          title={item.uploadError ?? gallery.uploadFailedTitle}
        >
          <CloudAlert className="h-3 w-3" />
          {gallery.uploadFailed}
        </span>
      ) : (
        <span
          className="absolute top-1.5 left-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white"
          title={gallery.pendingTitle}
        >
          <CloudOff className="h-3 w-3" />
          {gallery.pending}
        </span>
      ))}

      {/* Gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-slow" />

      {/* Journal color bar — top edge */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px] opacity-0 group-hover:opacity-100 transition-opacity duration-slow"
        style={{ backgroundColor: item.journalColor }}
      />

      {/* Date label — bottom-left on hover */}
      <span className="absolute bottom-1.5 left-2 text-[10px] font-medium text-white/90 opacity-0 group-hover:opacity-100 transition-opacity duration-slow leading-none drop-shadow-sm">
        {dateLabel}
      </span>
    </button>
  )
}

function VideoTile({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  const { messages, locale } = useI18n()
  const dateLabel = format(toZonedDate(new Date(item.createdAt)), messages.date.dayMonthShort, { locale: getDateFnsLocale(locale) })
  const hasPoster = !!item.thumbnailPath
  const hasLoop = !!item.previewPath

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative group block overflow-hidden cursor-pointer bg-black",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      )}
      style={{ aspectRatio: "1 / 1" }}
      aria-label={messages.media.videoAlt(dateLabel)}
    >
      {hasPoster ? (
        <>
          {/* Poster frame — visible at rest, fades out on hover when loop exists */}
          <img
            src={item.thumbnailPath}
            alt=""
            loading="lazy"
            className={cn(
              "absolute inset-0 h-full w-full object-cover",
              hasLoop
                ? "transition-opacity duration-300 group-hover:opacity-0"
                : "transition-transform duration-slow group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
            )}
          />

          {/* Animated loop — loaded eagerly, visible only on hover */}
          {hasLoop && (
            <img
              src={item.previewPath}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-300"
            />
          )}
        </>
      ) : (
        /* No poster: generic video icon */
        <div className="absolute inset-0 flex items-center justify-center bg-muted/20">
          <Video className="h-8 w-8 text-white/50" />
        </div>
      )}

      {/* Dark gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

      {/* Play badge — center */}
      <div className="absolute inset-0 flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity">
        <div className="rounded-full bg-black/50 p-2">
          <Play className="h-4 w-4 text-white fill-white" />
        </div>
      </div>

      {/* Duration badge — bottom-right */}
      {item.durationSeconds != null && (
        <span className="absolute bottom-1.5 right-2 text-[10px] font-medium text-white/90 leading-none drop-shadow-sm tabular-nums">
          {formatDuration(item.durationSeconds)}
        </span>
      )}

      {/* Journal color bar — top edge */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px] opacity-0 group-hover:opacity-100 transition-opacity duration-slow"
        style={{ backgroundColor: item.journalColor }}
      />

      {/* Date label — bottom-left on hover */}
      <span className="absolute bottom-1.5 left-2 text-[10px] font-medium text-white/90 opacity-0 group-hover:opacity-100 transition-opacity duration-slow leading-none drop-shadow-sm">
        {dateLabel}
      </span>
    </button>
  )
}

function AudioTile({ item, onClick }: { item: MediaItem; onClick: () => void }) {
  const { messages, locale } = useI18n()
  const dateLabel = format(toZonedDate(new Date(item.createdAt)), messages.date.dayMonthShort, { locale: getDateFnsLocale(locale) })
  const ext = item.filePath.split(".").pop()?.toUpperCase() ?? "AUDIO"

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative group flex flex-col items-center justify-center gap-2 overflow-hidden cursor-pointer",
        "bg-muted/30 border border-border/40",
        "hover:bg-muted/60 transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      )}
      style={{ aspectRatio: "1 / 1" }}
      aria-label={messages.media.audioAlt(dateLabel)}
    >
      {/* Journal color bar — top edge */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px]"
        style={{ backgroundColor: item.journalColor }}
      />

      {/* Music icon with play affordance */}
      <div className="relative flex items-center justify-center">
        <div className="rounded-full bg-primary/10 group-hover:bg-primary/20 transition-colors p-4">
          <Music className="h-6 w-6 text-primary" />
        </div>
        {/* Play overlay on hover */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <Play className="h-4 w-4 text-primary fill-primary" />
        </div>
      </div>

      {/* Format label */}
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        {ext}
      </span>

      {/* Duration */}
      {item.durationSeconds != null && (
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {formatDuration(item.durationSeconds)}
        </span>
      )}

      {/* Date label — bottom */}
      <span className="absolute bottom-1.5 text-[10px] font-medium text-muted-foreground/60 leading-none">
        {dateLabel}
      </span>
    </button>
  )
}

function MediaGridSkeleton() {
  return (
    <div className="grid gap-0.5 p-0.5 grid-cols-2 sm:grid-cols-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="bg-muted animate-pulse"
          style={{ aspectRatio: "1 / 1" }}
        />
      ))}
    </div>
  )
}
