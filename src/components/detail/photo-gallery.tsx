"use client"

import { useState, useRef, useCallback } from "react"
import { ChevronLeft, ChevronRight, X, ImageOff, CloudOff, CloudAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { Media } from "@/types/journal"
import { nextIndex, prevIndex, swipeDirection, preloadUrls, lightboxPhoto } from "@/lib/lightbox-utils"
import { useI18n } from "@/components/locale-provider"

const SWIPE_THRESHOLD = 50

interface PhotoGalleryProps {
  photos: Media[]
}

export function PhotoGallery({ photos }: PhotoGalleryProps) {
  const { messages } = useI18n()
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pointerStartX = useRef<number | null>(null)
  const total = photos.length
  // Die Liste kann schrumpfen, während die Lightbox offen ist (Netzabriss oder
  // Entpinnen filtert Server-Zeilen heraus) — ein Index hinter dem Ende zeigt
  // dann nichts mehr an, statt beim Rendern auf undefined zu greifen.
  const current = lightboxPhoto(photos, lightboxIndex)

  const close = useCallback(() => {
    setLightboxIndex(null)
    // Return focus to the thumbnail button that opened the lightbox
    requestAnimationFrame(() => lastTriggerRef.current?.focus())
  }, [])

  const goNext = useCallback(() =>
    setLightboxIndex(i => (i === null ? null : nextIndex(i, total))), [total])

  const goPrev = useCallback(() =>
    setLightboxIndex(i => (i === null ? null : prevIndex(i, total))), [total])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); goNext() }
    if (e.key === "ArrowLeft")  { e.preventDefault(); goPrev() }
    // Esc is handled by Radix Dialog
  }, [goNext, goPrev])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerStartX.current = e.clientX
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (pointerStartX.current === null) return
    const dir = swipeDirection(pointerStartX.current, e.clientX, SWIPE_THRESHOLD)
    pointerStartX.current = null
    if (dir === "next") goNext()
    else if (dir === "prev") goPrev()
  }, [goNext, goPrev])

  if (total === 0) return null

  const isSingle = total === 1
  const isThree = total === 3
  const urls = lightboxIndex !== null ? preloadUrls(lightboxIndex, photos) : []

  const openAt = (index: number, trigger: HTMLButtonElement | null) => {
    lastTriggerRef.current = trigger
    setLightboxIndex(index)
  }

  return (
    <>
      {/* Photo grid */}
      <div
        className="grid gap-[6px]"
        style={{ gridTemplateColumns: isSingle ? "1fr" : "1fr 1fr" }}
      >
        {photos.map((photo, index) => (
          <button
            key={photo.id}
            onClick={(e) => openAt(index, e.currentTarget)}
            className={[
              "relative overflow-hidden rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "group",
              isThree && index === 0 ? "col-span-2" : "",
            ].filter(Boolean).join(" ")}
            style={{ height: isSingle ? "auto" : 220, display: "block" }}
            aria-label={
              photo.pending
                ? messages.detail.gallery.photoOpenPending(index + 1, total)
                : messages.detail.gallery.photoOpen(index + 1, total)
            }
          >
            <GalleryImage
              src={photo.thumbnailPath || photo.filePath}
              fallbackSrc={photo.filePath}
              className="w-full h-full object-cover motion-safe:transition-transform motion-safe:duration-300 group-hover:scale-[1.02]"
              style={isSingle ? { maxHeight: 420, width: "100%" } : undefined}
            />

            {/* Offline badge — the file is stored locally and goes up on reconnect.
                Without it a local preview is indistinguishable from an uploaded
                photo, and the user cannot tell what is safe on the server yet.
                A file that exhausted its retries will NEVER go up again
                (selectFlushable skips it) — "Wartet" would be a false safety
                promise for a photo that never leaves the device. */}
            {photo.pending && (photo.uploadStuck ? (
              <span
                className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-red-600/80 px-1.5 py-0.5 text-[10px] font-medium text-white"
                title={photo.uploadError ?? messages.detail.gallery.uploadFailedTitle}
              >
                <CloudAlert className="h-3 w-3" />
                {messages.detail.gallery.uploadFailed}
              </span>
            ) : (
              <span
                className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white"
                title={messages.detail.gallery.pendingTitle}
              >
                <CloudOff className="h-3 w-3" />
                {messages.detail.gallery.pending}
              </span>
            ))}
          </button>
        ))}
      </div>

      {/* Hidden preload images for adjacent photos (thumbnail-sized, Pi-safe).
          preloadUrls dedupes — in a 2-photo gallery prev and next are the same
          photo, which would render duplicate React keys. */}
      {urls.map(url => (
        <img key={url} src={url} alt="" aria-hidden="true" className="hidden" />
      ))}

      {/* Lightbox */}
      <Dialog open={lightboxIndex !== null} onOpenChange={open => { if (!open) close() }}>
        <DialogContent
          className="max-w-4xl p-0 bg-black/95 border-0 shadow-overlay"
          aria-describedby={undefined}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        >
          <DialogTitle className="sr-only">
            {lightboxIndex !== null
              ? messages.detail.gallery.photoOf(lightboxIndex + 1, total)
              : messages.detail.gallery.photoFallback}
          </DialogTitle>
          {lightboxIndex !== null && current && (
            <div className="relative flex items-center justify-center min-h-[60vh]">
              <img
                src={current.filePath}
                alt={messages.detail.gallery.photoOf(lightboxIndex + 1, total)}
                className="max-w-full max-h-[85vh] object-contain select-none"
                draggable={false}
              />

              {/* Close */}
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-3 right-3 h-8 w-8 rounded-full bg-black/50 text-white hover:bg-white/20 hover:text-white"
                onClick={close}
                aria-label={messages.detail.gallery.close}
              >
                <X className="h-4 w-4" />
              </Button>

              {/* Prev / Next */}
              {total > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute left-3 h-9 w-9 rounded-full bg-black/50 text-white hover:bg-white/20 hover:text-white"
                    onClick={goPrev}
                    aria-label={messages.detail.gallery.previousImage}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-3 h-9 w-9 rounded-full bg-black/50 text-white hover:bg-white/20 hover:text-white"
                    onClick={goNext}
                    aria-label={messages.detail.gallery.nextImage}
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                </>
              )}

              {/* Counter pill */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
                <span className="font-ui text-[11px] font-medium text-white/80 bg-black/50 px-2.5 py-1 rounded-full">
                  {lightboxIndex + 1} / {total}
                </span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function GalleryImage({
  src,
  fallbackSrc,
  className,
  style,
}: {
  src: string
  fallbackSrc?: string
  className?: string
  style?: React.CSSProperties
}) {
  const [imgSrc, setImgSrc] = useState(src)
  const [error, setError] = useState(false)
  const [lastSrc, setLastSrc] = useState(src)

  // With revocable blob: URLs the error path is now regularly reachable.
  // Without this reset a once-failed image would swallow every later, valid src
  // (e.g. the server thumbnail after the upload landed) until a random remount.
  if (lastSrc !== src) {
    setLastSrc(src)
    setImgSrc(src)
    setError(false)
  }

  if (error) {
    return (
      <div className="w-full h-full bg-muted flex items-center justify-center">
        <ImageOff className="h-6 w-6 text-muted-foreground/40" />
      </div>
    )
  }

  return (
    <img
      src={imgSrc}
      alt=""
      className={className}
      style={style}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (fallbackSrc && imgSrc !== fallbackSrc) {
          setImgSrc(fallbackSrc)
        } else {
          setError(true)
        }
      }}
    />
  )
}
