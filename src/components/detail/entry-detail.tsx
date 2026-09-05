"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Heart, ChevronLeft, Pencil, Trash2, FileX, WifiOff, Wifi, Loader2 } from "lucide-react"
import { useOfflinePin } from "@/hooks/useOfflinePin"
import { pinnablePhotoUrls, showPinToggle, visibleEntryMedia } from "@/lib/offline/pin-rules"
import { useSyncContext } from "@/components/sync/sync-provider"
import { MarkdownContent } from "@/components/detail/markdown-content"
import { PhotoGallery } from "@/components/detail/photo-gallery"
import { AudioPlayer } from "@/components/detail/audio-player"
import { VideoPlayer } from "@/components/detail/video-player"
import { EntryMetadata } from "@/components/detail/entry-metadata"
import { ConflictCopies } from "@/components/detail/conflict-copies"
import { DeleteDialog } from "@/components/editor/delete-dialog"
import { formatEntryDate, formatEntryTime, extractTitle } from "@/lib/format"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { JournalEntryDetail, Media } from "@/types/journal"
import { realIDBAdapter } from "@/lib/sync/idb"
import { deleteEntryWithOfflineFallback, deleteOutcomeUi } from "@/lib/sync/delete-entry"
import { idbToEntryDetail } from "@/lib/sync/idb-to-views"
import { mergePendingMedia } from "@/lib/sync/pending-media"
import {
  cacheEntryMedia,
  deleteCachedEntryMedia,
  readCachedEntryMediaBox,
} from "@/lib/sync/entry-media-cache"
import { loadPendingMediaForEntry } from "@/lib/sync/pending-media-preview"
import { revokePreviewUrls } from "@/lib/sync/preview-urls"
import { useI18n } from "@/components/locale-provider"

/** Pure helper — exported for unit testing. */
export function entryDetailFavouriteClasses(starred: boolean): string {
  return cn("h-4 w-4", starred ? "fill-heart text-heart" : "text-muted-foreground")
}

/** Pure helpers — exported for unit testing. */
export function entryDetailEyebrowClasses(): string {
  return "text-xs font-ui font-medium uppercase tracking-widest text-muted-foreground"
}

export function entryDetailTitleClasses(): string {
  return "font-reading text-[30px] sm:text-[32px] font-semibold leading-[1.2] tracking-tight mb-6"
}

/**
 * Pure helper — exported for unit testing.
 *
 * All media renders below the entry text, in this order. Nothing is held back
 * for a hero image above the text: the hero was a
 * deliberate design decision and is deliberately reversed.
 */
export function orderDetailMedia(media: Media[]): {
  photos: Media[]
  videos: Media[]
  audio: Media[]
} {
  return {
    photos: media.filter((m) => m.type === "photo"),
    videos: media.filter((m) => m.type === "video"),
    audio: media.filter((m) => m.type === "audio"),
  }
}

interface EntryDetailProps {
  entryId: string
  onBack?: () => void
  /** When set, editing happens inline instead of navigating to /entry/<id>/edit.
   *  The loaded entry is handed over so the editor needs no second fetch — which
   *  is what makes editing work offline at all. */
  onEdit?: (entry: JournalEntryDetail) => void
  /** Bump to force a refetch — used after an inline edit closes. */
  reloadNonce?: number
  /** Called after a successful delete — lets the parent refetch views that
   *  count this entry (timeline, overview stats). onBack alone can't carry
   *  that signal: it also fires on plain back-navigation. */
  onDeleted?: () => void
  /** Called after pin/unpin — the timeline with the „Offline verfügbar"
   *  filter must drop/add this entry live. */
  onPinChanged?: () => void
}

export function EntryDetail({ entryId, onBack, onEdit, reloadNonce = 0, onDeleted, onPinChanged }: EntryDetailProps) {
  const router = useRouter()
  const { messages, locale } = useI18n()
  const [entry, setEntry] = useState<JournalEntryDetail | null>(null)
  /** Verbund-E2E-Fund: offline ohne Cache-Hit ist die Medien-Liste
   *  UNBEKANNT, nicht leer — der Pin-Umschalter muss bedienbar bleiben. */
  const [mediaListUnknown, setMediaListUnknown] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Derive photo URLs once entry is loaded; stable empty array before load.
  // Pending photos are excluded on purpose: their filePath is a `blob:` URL, and
  // Cache Storage cannot hold one — offering it to useOfflinePin would make the
  // pin fail for the whole entry (rule + test: pin-rules.ts).
  const photoUrls = entry ? pinnablePhotoUrls(entry.media) : []
  const { isPinned, caching, pin, unpin } = useOfflinePin(entryId, photoUrls)
  const { online } = useSyncContext()

  const handlePinToggle = useCallback(async () => {
    if (isPinned) await unpin()
    else await pin()
    onPinChanged?.()
  }, [isPinned, pin, unpin, onPinChanged])

  useEffect(() => {
    const controller = new AbortController()
    /** Preview URLs this run created — revoked when it tears down. */
    const previewUrls: string[] = []
    let cancelled = false

    setLoading(true)
    setEntry(null)

    async function load() {
      let loaded: JournalEntryDetail | null = null
      let listUnknown = false
      try {
        const res = await fetch(`/api/entries/${entryId}`, { signal: controller.signal })
        // 404 is a server-side CONFIRMED "gone", not a network failure —
        // the IDB fallback would resurrect the deleted entry (tombstone not
        // pulled yet) complete with its cached photos. Show not-found and drop
        // the media cache; only 5xx/network errors keep the fallback.
        if (res.status === 404) {
          await deleteCachedEntryMedia(realIDBAdapter, entryId)
          if (cancelled) return
          setEntry(null)
          setLoading(false)
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        loaded = (await res.json()) as JournalEntryDetail
        // Remember the server's media list — a SyncEntry carries none, so without
        // this the offline view below has no way to know the entry has photos at
        // all, and an offline attachment would look like it replaced them.
        // Fire-and-forget: the view does not depend on the write order.
        void cacheEntryMedia(realIDBAdapter, entryId, loaded.media, loaded.updatedAt)
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        // Network failed — try the local IDB store as offline fallback
        try {
          const idbEntry = await realIDBAdapter.getEntry(entryId)
          if (idbEntry) {
            loaded = idbToEntryDetail(idbEntry)
            // Staleness is handled by the sync pull (it drops the key on
            // a remote updatedAt change) — no read-time check, a local offline
            // edit must not hide the server photos.
            const cachedBox = await readCachedEntryMediaBox(realIDBAdapter, entryId)
            loaded.media = cachedBox.media
            // Miss (updatedAt null) heißt UNBEKANNT, nicht leer — der
            // Pin-Umschalter bleibt dann sichtbar (showPinToggle).
            listUnknown = cachedBox.updatedAt === null
          }
        } catch {
          // IDB also unavailable; entry stays null → empty-state shown below
        }
      }

      // Files still in the offline outbox are merged for BOTH sources on purpose:
      // being online is no guarantee that a file already made it up (upload
      // running, failed, or out of retries), and then the server's copy of the
      // entry lacks it just as the IDB copy does.
      if (loaded && !cancelled) {
        const pending = await loadPendingMediaForEntry(entryId, loaded.media.length, previewUrls)
        if (pending.length > 0) {
          loaded = { ...loaded, media: mergePendingMedia(loaded.media, pending) }
        }
      }

      // The cleanup already ran and revoked an (then empty) previewUrls
      // array — any URL the pending load pushed AFTER that would leak a
      // full-res blob until page reload. The creator revokes what the teardown
      // could not see.
      if (cancelled) {
        revokePreviewUrls(previewUrls)
        return
      }
      setEntry(loaded)
      setMediaListUnknown(listUnknown)
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
      controller.abort()
      revokePreviewUrls(previewUrls)
    }
  }, [entryId, reloadNonce])

  const toggleStar = useCallback(async () => {
    if (!entry) return
    const next = { ...entry, starred: !entry.starred }
    setEntry(next)
    try {
      const res = await fetch(`/api/entries/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          journalId: entry.journalId,
          createdAt: entry.createdAt,
          starred: next.starred,
          tags: entry.tags.map((t) => t.name),
          locationName: entry.location?.name ?? null,
          locationLat: entry.location?.latitude ?? null,
          locationLng: entry.location?.longitude ?? null,
          weatherDescription: entry.weather?.description ?? null,
          weatherTempCelsius: entry.weather?.temperatureCelsius ?? null,
          weatherIcon: entry.weather?.icon ?? null,
        }),
      })
      if (!res.ok) {
        // fetch() wirft bei 4xx/5xx nicht — ohne diesen Check blieb der Stern
        // optimistisch gesetzt, obwohl der Server nie gespeichert hat.
        console.warn("[toggleStar] save failed:", res.status)
        setEntry(entry)
      }
    } catch {
      // Revert on failure
      setEntry(entry)
    }
  }, [entry])

  async function handleDelete() {
    if (!entry) return
    setIsDeleting(true)
    setDeleteError(null)
    // Offline queues a delete tombstone instead of failing (Randbefund);
    // local cleanup (IDB mirror, cached media list, outbox files) lives in the helper.
    const result = await deleteEntryWithOfflineFallback(entry.id, realIDBAdapter)
    // "failed" muss sichtbar scheitern — vorher schloss der Dialog
    // kommentarlos und der stehengebliebene Eintrag las sich wie ein Bug.
    if (!deleteOutcomeUi(result).leaveView) {
      setDeleteError(messages.editor.deleteFailed)
      setIsDeleting(false)
      return
    }
    onDeleted?.()
    if (onBack) {
      onBack()
    } else {
      router.push("/")
    }
  }

  if (loading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/50 p-8 text-center">
        <FileX className="h-10 w-10 opacity-30" />
        <p className="text-sm font-medium">{messages.detail.notFound.title}</p>
        <p className="text-xs opacity-70">{messages.detail.notFound.description}</p>
      </div>
    )
  }

  // Offline + ungepinnt bleiben nur die noch wartenden lokalen Dateien übrig;
  // die Abschnitte unten rendern ohnehin nur, wenn ihre
  // Liste nicht leer ist — ohne Wartende sieht die Ansicht aus wie bisher.
  const { photos, videos: videoFiles, audio: audioFiles } = orderDetailMedia(
    visibleEntryMedia(entry.media, online, isPinned)
  )

  const { title, body } = extractTitle(entry.text)

  return (
    <>
      <ScrollArea className="h-full">
        {/* Mobile back button */}
        {onBack && (
          <div className="md:hidden sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b px-2 py-2">
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
              <ChevronLeft className="h-4 w-4" />
              {messages.common.back}
            </Button>
          </div>
        )}

        <article className="max-w-3xl mx-auto pb-16">
          <div className="px-8 py-10">
            {/* Journal badge + date header + action buttons */}
            <div className="mb-8">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: entry.journalColor }}
                  />
                  <span className="text-xs font-ui font-medium text-muted-foreground">
                    {entry.journalName}
                  </span>
                </div>
                {/* Action buttons */}
                <div className="flex items-center gap-1 -mt-1 -mr-2 shrink-0">
                  {/* Offline pin — Sichtbarkeitsregel showPinToggle
                      (Feldbefund c + Verbund-E2E-Fund): Fotos bekannt,
                      ODER gepinnt (Unpin muss offline immer gehen), ODER
                      Medien-Liste unbekannt (Cache-Miss offline — unbekannt
                      ≠ leer, Re-Pin bleibt möglich via mediaUrlsPending). */}
                  {showPinToggle(photoUrls.length, isPinned, mediaListUnknown) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handlePinToggle}
                      disabled={caching}
                      aria-label={
                        caching
                          ? messages.detail.offlinePin.saving
                          : isPinned
                          ? messages.detail.offlinePin.unpin
                          : messages.detail.offlinePin.pin
                      }
                    >
                      {caching ? (
                        <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                      ) : isPinned ? (
                        <WifiOff className="h-4 w-4 text-primary" />
                      ) : (
                        <Wifi className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={toggleStar}
                    aria-label={entry.starred ? messages.detail.favourite.remove : messages.detail.favourite.add}
                  >
                    <Heart className={entryDetailFavouriteClasses(entry.starred)} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      if (onEdit) onEdit(entry)
                      else router.push(`/entry/${entry.id}/edit`)
                    }}
                    aria-label={messages.detail.edit}
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 hover:text-destructive"
                    onClick={() => setShowDeleteDialog(true)}
                    aria-label={messages.detail.delete}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
              <time className={entryDetailEyebrowClasses()}>
                {formatEntryDate(entry.createdAt, locale)} · {formatEntryTime(entry.createdAt)}
              </time>
            </div>

            {/* Title — Lora as hero */}
            {title && (
              <h1 className={entryDetailTitleClasses()}>
                {title}
              </h1>
            )}

            {/* Entry body (markdown) */}
            {body && <MarkdownContent content={body} />}
            {!title && entry.text && <MarkdownContent content={entry.text} />}

            {/* All media below the text — photos, then videos, then audio.
                No hero image above the title any more.
                Offline + ungepinnt: nur Text, keine Kacheln, kein Hinweis
                — ausgenommen Dateien, die noch auf
                ihren Upload warten (visibleEntryMedia). */}
            {photos.length > 0 && (
              <div className="mt-10">
                <PhotoGallery photos={photos} />
              </div>
            )}

            {/* Videos */}
            {videoFiles.map((video) => (
              <div key={video.id} className="mt-6">
                <VideoPlayer media={video} />
              </div>
            ))}

            {/* Audio */}
            {audioFiles.map((audio) => (
              <div key={audio.id} className="mt-6">
                <AudioPlayer media={audio} />
              </div>
            ))}

            {/* Metadata + Tags */}
            <Separator className="my-10" />
            <EntryMetadata
              location={entry.location}
              weather={entry.weather}
              tags={entry.tags}
              journalName={entry.journalName}
              journalColor={entry.journalColor}
            />

            {/* Server-gesicherte Konfliktkopien (nur sichtbar wenn vorhanden) */}
            <ConflictCopies entryId={entry.id} />
          </div>
        </article>
      </ScrollArea>

      {deleteError && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-destructive/10 px-4 py-2 text-xs text-destructive border border-destructive/20 shadow-sm"
        >
          {deleteError}
        </div>
      )}

      <DeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  )
}
