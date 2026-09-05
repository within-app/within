"use client"

import { useRef, useState, useEffect } from "react"
import { ImagePlus, Film, Music, X, ChevronUp, ChevronDown, Loader2, CloudOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { realIDBAdapter } from "@/lib/sync/idb"
import { isEntryQueuedLocally } from "@/lib/sync/queue-status"
import { safeUUID } from "@/lib/sync/queue-edit"
import { budgetRejection, isStuck, type OutboxMedia } from "@/lib/sync/media-outbox"
import { useI18n } from "@/components/locale-provider"
import {
  isDownscaleEnabled,
  tryDownscalePhoto,
  jpegName,
  UPLOAD_HARD_CAP_BYTES,
} from "@/lib/upload-downscale"
import type { Messages } from "@/lib/i18n"
import {
  ALLOWED_VIDEO_MIMES,
  ALLOWED_AUDIO_MIMES,
  getMaxMBForType,
  type UploadMediaType,
} from "@/lib/upload-security"

export interface UploadedPhoto {
  tempId: string
  filePath: string
  thumbnailPath?: string
  dbId?: string
  uploading?: boolean
  error?: string
  type?: "photo" | "video" | "audio"
  /** Object URL of a file queued offline — the preview source until upload. */
  localUrl?: string
  /** True while the file sits in the offline outbox. */
  queuedOffline?: boolean
}

interface PhotoUploaderProps {
  initialPhotos?: UploadedPhoto[]
  entryId?: string
  /** Returns the id the entry will have, allocating it if the entry was never
   *  saved. Offline attachments need it up front: the outbox is keyed by entry,
   *  and `/api/upload?entryId=` is what links the file after reconnect. */
  ensureEntryId?: () => string
  onChange: (photos: UploadedPhoto[]) => void
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine
}

/** Map an outbox record onto the editor's tile model, with a local preview. */
function toQueuedPhoto(
  item: OutboxMedia,
  objectUrls: { current: string[] },
  uploaderMessages: Messages["editor"]["uploader"]
): UploadedPhoto {
  let localUrl: string | undefined
  if (item.type === "photo" && typeof URL !== "undefined" && URL.createObjectURL) {
    localUrl = URL.createObjectURL(item.blob)
    objectUrls.current.push(localUrl)
  }
  return {
    tempId: item.id,
    filePath: "",
    type: item.type,
    localUrl,
    queuedOffline: true,
    // Only surface an error once the file has stopped retrying — a normal wait
    // is not a failure and must not look like one.
    error: isStuck(item) ? item.lastError ?? uploaderMessages.uploadFailed : undefined,
  }
}

// Video-/Audio-Allowlists und Größenlimits kommen aus upload-security.ts (eine
// Quelle). Bilder bleiben clientseitig enger als der Server (der nimmt
// image/* und prüft per sharp), damit z. B. HEIC nicht erst hochgeladen und dann
// abgelehnt wird. Im Client sieht getMaxMBForType nur die Code-Defaults —
// MAX_*_SIZE_MB aus der Server-ENV landet nicht im Bundle, maßgeblich bleibt
// die Server-Prüfung.
const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
const ACCEPT = [
  ...ALLOWED_IMAGE_MIMES, ...ALLOWED_VIDEO_MIMES, ...ALLOWED_AUDIO_MIMES,
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".m4v", ".mov", ".mp3", ".m4a", ".aac",
].join(",")

function detectType(mime: string): UploadMediaType | null {
  if ((ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime)) return "video"
  if ((ALLOWED_AUDIO_MIMES as readonly string[]).includes(mime)) return "audio"
  if (ALLOWED_IMAGE_MIMES.includes(mime)) return "photo"
  return null
}

export function PhotoUploader({ initialPhotos = [], entryId, ensureEntryId, onChange }: PhotoUploaderProps) {
  const { messages } = useI18n()
  const uploaderMessages = messages.editor.uploader
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [photos, setPhotos] = useState<UploadedPhoto[]>(initialPhotos)
  const photosRef = useRef(photos)
  photosRef.current = photos

  /** Object URLs created for offline previews — revoked on unmount. */
  const objectUrlsRef = useRef<string[]>([])
  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => urls.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  // Re-attach files still waiting in the outbox when the editor is reopened —
  // otherwise an offline restart looks like the photo was lost.
  useEffect(() => {
    if (!entryId || !realIDBAdapter.listOutboxMediaForEntry) return
    let cancelled = false
    void realIDBAdapter
      .listOutboxMediaForEntry(entryId)
      .then((queued) => {
        if (cancelled || queued.length === 0) return
        setPhotos((prev) => {
          const known = new Set(prev.map((p) => p.tempId))
          const restored = queued
            .filter((item) => !known.has(item.id))
            .map((item) => toQueuedPhoto(item, objectUrlsRef, uploaderMessages))
          return restored.length > 0 ? [...prev, ...restored] : prev
        })
      })
      .catch((err) => {
        console.error("[within/upload] reading the offline media outbox failed:", err)
      })
    return () => { cancelled = true }
    // uploaderMessages ist idempotent für die Wiederherstellung (known-Set-Guard)
  }, [entryId, uploaderMessages])

  // Cap parallel uploads at 3 to prevent Pi 4 OOM on camera-roll batches
  const uploadQueueRef = useRef<File[]>([])
  const activeUploadsRef = useRef(0)

  useEffect(() => {
    onChange(photos)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos])

  async function uploadFile(file: File) {
    const mediaType = detectType(file.type)
    if (!mediaType) {
      alert(uploaderMessages.formatNotAllowed)
      return
    }
    // Geräte-Schalter (Default aus): große Fotos speicherschonend verkleinern,
    // BEVOR sie Upload oder Offline-Queue erreichen — auf gehärteten Mobil-
    // Browsern crasht sonst der Tab am ~10-MB-Original (Befund).
    // Fail-closed: schlägt das Verkleinern fehl UND die Datei liegt über der
    // Kappe, wird sichtbar abgelehnt — nie still das Original durchreichen.
    if (mediaType === "photo" && isDownscaleEnabled(window.localStorage)) {
      const result = await tryDownscalePhoto(file)
      if (result.ok && result.changed) {
        file = new File([result.blob], jpegName(file.name), { type: "image/jpeg" })
      } else if (!result.ok && file.size > UPLOAD_HARD_CAP_BYTES) {
        alert(uploaderMessages.downscaleFailed)
        return
      }
    }
    const maxMB = getMaxMBForType(mediaType)
    const maxBytes = maxMB * 1024 * 1024
    if (file.size > maxBytes) {
      alert(uploaderMessages.tooLarge(maxMB, mediaType))
      return
    }

    const tempId = `temp-${Date.now()}-${Math.random()}`
    // Allocated up front so the online attempt and a possible offline
    // requeue share one idempotency key — if the fetch dies after the server
    // insert, the outbox retry finds the existing row instead of duplicating it.
    const clientMediaId = safeUUID()
    setPhotos((prev) => [...prev, { tempId, filePath: "", uploading: true, type: mediaType }])

    // Offline the upload can only fail — queue the file instead of showing
    // "Netzwerkfehler" and losing it.
    if (!isOnline()) {
      await queueOffline(file, tempId, mediaType, clientMediaId)
      return
    }

    // Der Ziel-Eintrag liegt noch (oder wieder) in der editQueue —
    // serverseitig existiert er nicht. Ein Direkt-Upload speichert die Datei
    // ohne media-Row und verknüpft sie nie (buildQueuedEdit trägt kein
    // photos-Feld). In die Outbox damit; flushMedia verknüpft nach dem Push.
    if (entryId && (await isEntryQueuedLocally(entryId))) {
      await queueOffline(file, tempId, mediaType, clientMediaId)
      return
    }

    const fd = new FormData()
    fd.append("file", file)
    if (entryId) fd.append("clientMediaId", clientMediaId)
    const url = entryId ? `/api/upload?entryId=${entryId}` : "/api/upload"

    try {
      const res = await fetch(url, { method: "POST", body: fd })
      if (!res.ok) {
        // Das File darf hier NIE verworfen werden —
        // eine Kamera-Aufnahme existiert nur in diesem Objekt. In die Outbox
        // damit (gleicher clientMediaId = Idempotenz): 5xx/429 retried
        // der Flush bounded, ein permanenter 4xx endet als markRejected mit dem
        // Server-Fehlertext auf der Kachel — Datei bleibt in IDB erhalten.
        await queueOffline(file, tempId, mediaType, clientMediaId)
        return
      }
      const data = await res.json() as {
        filePath: string
        thumbnailPath?: string
        id?: string
        type?: "photo" | "video" | "audio"
      }
      setPhotos((prev) =>
        prev.map((p) =>
          p.tempId === tempId
            ? {
                tempId,
                filePath: data.filePath,
                thumbnailPath: data.thumbnailPath,
                dbId: data.id,
                type: data.type ?? mediaType,
              }
            : p
        )
      )
    } catch {
      // The connection dropped mid-upload — same situation as being offline from
      // the start, so take the same route instead of discarding the file.
      // Same clientMediaId on purpose: the server may already hold the row.
      await queueOffline(file, tempId, mediaType, clientMediaId)
    }
  }

  /** Park the file in the IDB outbox and show it from a local object URL. */
  async function queueOffline(
    file: File,
    tempId: string,
    mediaType: "photo" | "video" | "audio",
    clientMediaId: string
  ) {
    function fail(message: string) {
      setPhotos((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, uploading: false, error: message } : p))
      )
    }

    const targetEntryId = entryId ?? ensureEntryId?.()
    if (!targetEntryId) {
      fail(uploaderMessages.offlineNoId)
      return
    }
    if (!realIDBAdapter.putOutboxMedia || !realIDBAdapter.listOutboxMedia) {
      fail(uploaderMessages.offlineNoStorage)
      return
    }

    try {
      const pending = await realIDBAdapter.listOutboxMedia()
      const overBudget = budgetRejection(pending, file.size)
      if (overBudget) {
        fail(overBudget)
        return
      }

      const item: OutboxMedia = {
        // The outbox id IS the idempotency key — flushMedia sends it as
        // clientMediaId, so it must equal what the online attempt already sent.
        id: clientMediaId,
        entryId: targetEntryId,
        blob: file,
        fileName: file.name || `offline-${mediaType}`,
        mimeType: file.type,
        type: mediaType,
        size: file.size,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      }
      await realIDBAdapter.putOutboxMedia(item)

      const queued = toQueuedPhoto(item, objectUrlsRef, uploaderMessages)
      setPhotos((prev) => prev.map((p) => (p.tempId === tempId ? queued : p)))
    } catch (err) {
      // Never swallow: on a phone the console is out of reach and a missing
      // thumbnail is indistinguishable from "no photo added".
      console.error("[within/upload] queueing the offline attachment failed:", err)
      const name = err instanceof Error && err.name && err.name !== "Error" ? ` (${err.name})` : ""
      fail(uploaderMessages.offlineFailed(name))
    }
  }

  function runNext() {
    while (activeUploadsRef.current < 3 && uploadQueueRef.current.length > 0) {
      const file = uploadQueueRef.current.shift()!
      activeUploadsRef.current++
      uploadFile(file).finally(() => {
        activeUploadsRef.current--
        runNext()
      })
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files) return
    uploadQueueRef.current.push(...Array.from(files))
    runNext()
  }

  async function removePhoto(photo: UploadedPhoto) {
    if (photo.queuedOffline && realIDBAdapter.deleteOutboxMedia) {
      try {
        await realIDBAdapter.deleteOutboxMedia(photo.tempId)
      } catch (err) {
        console.warn("[within/upload] removing the queued attachment failed:", err)
      }
      if (photo.localUrl) {
        URL.revokeObjectURL(photo.localUrl)
        objectUrlsRef.current = objectUrlsRef.current.filter((u) => u !== photo.localUrl)
      }
    }
    if (photo.dbId) {
      try {
        const res = await fetch(`/api/media/${photo.dbId}`, { method: "DELETE" })
        if (!res.ok) console.warn("[removePhoto] Media delete failed:", photo.dbId)
      } catch {
        console.warn("[removePhoto] Network error deleting media:", photo.dbId)
      }
    }
    setPhotos((prev) => prev.filter((p) => p.tempId !== photo.tempId))
  }

  function move(index: number, direction: -1 | 1) {
    setPhotos((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const readyItems = photos.filter((p) => !p.uploading && !p.error)

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50"
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFiles(e.dataTransfer.files)
        }}
      >
        <ImagePlus className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {uploaderMessages.dropzoneText}{" "}
          <span className="text-primary font-medium">{uploaderMessages.dropzoneSelect}</span>
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          {uploaderMessages.hint}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((photo, index) => (
            <div
              key={photo.tempId}
              className="relative group aspect-square rounded-md overflow-hidden bg-muted"
            >
              {photo.uploading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : photo.error ? (
                <div className="flex items-center justify-center h-full p-2">
                  <p className="text-xs text-destructive text-center">{photo.error}</p>
                </div>
              ) : photo.localUrl || photo.thumbnailPath || photo.type === "photo" ? (
                <img
                  src={photo.localUrl ?? photo.thumbnailPath ?? photo.filePath}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : photo.type === "video" ? (
                <div className="flex flex-col items-center justify-center h-full gap-1 text-muted-foreground">
                  <Film className="h-8 w-8" />
                  <span className="text-xs">{uploaderMessages.videoLabel}</span>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-1 text-muted-foreground">
                  <Music className="h-8 w-8" />
                  <span className="text-xs">{uploaderMessages.audioLabel}</span>
                </div>
              )}

              {/* Offline badge — the file is stored locally and goes up on reconnect */}
              {photo.queuedOffline && !photo.error && (
                <span
                  className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white"
                  title={uploaderMessages.pendingTitle}
                >
                  <CloudOff className="h-3 w-3" />
                  {uploaderMessages.pendingBadge}
                </span>
              )}

              {!photo.uploading && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-end justify-between p-1">
                  <button
                    type="button"
                    onClick={() => removePhoto(photo)}
                    className="bg-black/60 rounded p-0.5 hover:bg-black/80"
                    aria-label={uploaderMessages.removeAria}
                  >
                    <X className="h-3.5 w-3.5 text-white" />
                  </button>
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      className="bg-black/60 rounded p-0.5 hover:bg-black/80 disabled:opacity-30"
                      aria-label={uploaderMessages.moveUpAria}
                    >
                      <ChevronUp className="h-3.5 w-3.5 text-white" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === photos.length - 1}
                      className="bg-black/60 rounded p-0.5 hover:bg-black/80 disabled:opacity-30"
                      aria-label={uploaderMessages.moveDownAria}
                    >
                      <ChevronDown className="h-3.5 w-3.5 text-white" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {readyItems.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {uploaderMessages.mediaCount(readyItems.length)}
        </p>
      )}
    </div>
  )
}
