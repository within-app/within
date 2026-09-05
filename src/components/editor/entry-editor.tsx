"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Trash2, X, Loader2, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MetadataPanel } from "@/components/editor/metadata-panel"
import { PhotoUploader, type UploadedPhoto } from "@/components/editor/photo-uploader"
import { DeleteDialog } from "@/components/editor/delete-dialog"
import {
  saveSilently as libSaveSilently,
  saveAndClose as libSaveAndClose,
  type SaveResult,
} from "@/lib/editor/save-logic"
import type { Messages } from "@/lib/i18n"
import { buildQueuedEdit, safeUUID } from "@/lib/sync/queue-edit"
import { deleteEntryWithOfflineFallback } from "@/lib/sync/delete-entry"
import { realIDBAdapter } from "@/lib/sync/idb"
import { isEntryQueuedLocally } from "@/lib/sync/queue-status"
import { useI18n } from "@/components/locale-provider"
import type { Journal, JournalEntryDetail, Tag } from "@/types/journal"

/** Renders a SaveResult error in the active UI language; falls back to the
 *  German legacy text for results without a key. */
function saveErrorText(m: Messages, result: SaveResult): string | null {
  switch (result.errorKey) {
    case "offlineUnavailable": return m.errors.save.offlineUnavailable
    case "offlineFailed": return m.errors.save.offlineFailed(result.errorDetail ?? "")
    case "saveFailed": return m.errors.save.failed
    default: return result.error
  }
}

// isEntryQueuedLocally: kanonisch in @/lib/sync/queue-status — der
// PhotoUploader braucht dieselbe Prüfung fürs Upload-Ziel.

interface EntryEditorProps {
  initialEntry?: JournalEntryDetail | null
  journals: Journal[]
  defaultJournalId?: string
  /** Pre-filled text for new entries — used by the Web Share Target handler. */
  defaultText?: string
  /** When set, called on cancel/save-close instead of router.back(). Enables
   *  inline use from the root page without a route navigation. */
  onClose?: () => void
  /** Called instead of navigating to "/" after the entry was deleted — the
   *  inline caller has to drop its selection too. */
  onDeleted?: () => void
}

export function EntryEditor({ initialEntry, journals, defaultJournalId, defaultText, onClose, onDeleted }: EntryEditorProps) {
  const router = useRouter()
  const { messages } = useI18n()
  // isEdit starts from the prop but must flip true after autosave creates a new entry,
  // so the Delete button appears and handleDelete uses the correct ID.
  const [isEdit, setIsEdit] = useState(!!initialEntry)

  const firstJournalId = journals[0]?.id ?? ""
  const defaultId = defaultJournalId ?? firstJournalId

  // Editor state
  const [text, setText] = useState(initialEntry?.text ?? defaultText ?? "")
  const [journalId, setJournalId] = useState(initialEntry?.journalId ?? defaultId)
  const [createdAt, setCreatedAt] = useState<Date>(
    initialEntry?.createdAt ? new Date(initialEntry.createdAt) : new Date()
  )
  const [starred, setStarred] = useState(initialEntry?.starred ?? false)
  const [tags, setTags] = useState<Tag[]>(initialEntry?.tags ?? [])
  const [photos, setPhotos] = useState<UploadedPhoto[]>(
    initialEntry?.media
      .filter((m) => m.type === "photo")
      .map((m) => ({
        tempId: m.id,
        filePath: m.filePath,
        thumbnailPath: m.thumbnailPath,
        dbId: m.id,
      })) ?? []
  )

  const [locationName, setLocationName] = useState(initialEntry?.location?.name ?? "")
  const [locationLat, setLocationLat] = useState(
    initialEntry?.location?.latitude != null ? String(initialEntry.location.latitude) : ""
  )
  const [locationLng, setLocationLng] = useState(
    initialEntry?.location?.longitude != null ? String(initialEntry.location.longitude) : ""
  )

  const [isDirty, setIsDirty] = useState(false)
  /** Render-synced mirror of isDirty for the self-re-arming autosave timer. */
  const isDirtyRef = useRef(false)
  // eslint-disable-next-line react-hooks/refs
  isDirtyRef.current = isDirty
  const [isSaving, setIsSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  const [showMetaSheet, setShowMetaSheet] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Tracks the DB id of a new entry after the first silent POST — prevents duplicate rows. */
  const savedEntryIdRef = useRef<string | null>(null)
  /** Reactive mirror of savedEntryIdRef — triggers PhotoUploader re-render so uploads after
   *  the first autosave include ?entryId= and get a media row immediately. */
  const [savedEntryId, setSavedEntryId] = useState<string | null>(null)
  /** Client-side id reserved for an unsaved entry, so an offline attachment can
   *  be filed under the entry it belongs to before the first save.
   *  Deliberately NOT mirrored into savedEntryId state: that id drives the online
   *  `?entryId=` upload path and must stay empty until the server knows the row. */
  const offlineEntryIdRef = useRef<string | null>(null)
  /** Set when Cmd+Enter fires while a save is in flight — triggers save-and-close after it. */
  const pendingCloseRef = useRef(false)
  /** Stable ref to doSaveSilently so the autosave timer survives keystrokes (see effect below). */
  const doSaveSilentlyRef = useRef<() => Promise<void>>(async () => {})
  /** Stable ref to doSaveAndClose so doSaveSilently can invoke it without a dep cycle. */

  const doSaveAndCloseRef = useRef<() => Promise<void>>(async () => {})

  // Mark dirty on any field change; clear save error
  useEffect(() => { setIsDirty(true); setSaveError(null) }, [text, journalId, createdAt, starred, tags, photos, locationName, locationLat, locationLng])
  // Don't mark dirty on mount
  const isMounted = useRef(false)
  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; setIsDirty(false) }
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = `${ta.scrollHeight}px`
  }, [text])

  const buildPayload = useCallback(() => {
    const parsedLat = locationLat ? parseFloat(locationLat) : null
    const parsedLng = locationLng ? parseFloat(locationLng) : null
    return {
      text,
      journalId,
      createdAt: createdAt.toISOString(),
      starred,
      tags: tags.map((t) => t.name),
      photos: photos
        .filter((p) => !p.uploading && !p.error && p.filePath)
        .map((p) => ({ id: p.dbId, filePath: p.filePath!, thumbnailPath: p.thumbnailPath, type: p.type })),
      locationName: locationName.trim() || null,
      locationLat: parsedLat !== null && !isNaN(parsedLat) ? parsedLat : null,
      locationLng: parsedLng !== null && !isNaN(parsedLng) ? parsedLng : null,
      // Preserve existing weather data (editor has no weather UI, so keep original values)
      weatherDescription: initialEntry?.weather?.description ?? null,
      weatherTempCelsius: initialEntry?.weather?.temperatureCelsius ?? null,
      weatherIcon: initialEntry?.weather?.icon ?? null,
      // Pass the revision the client loaded so the PUT handler can detect concurrent sync conflicts.
      clientRevisionId: initialEntry?.revisionId,
    }
  }, [text, journalId, createdAt, starred, tags, photos, locationName, locationLat, locationLng, initialEntry])

  /** Id the entry will carry — allocated on demand for offline attachments. */
  const ensureEntryId = useCallback(() => {
    if (initialEntry) return initialEntry.id
    if (savedEntryIdRef.current) return savedEntryIdRef.current
    if (!offlineEntryIdRef.current) offlineEntryIdRef.current = safeUUID()
    return offlineEntryIdRef.current
  }, [initialEntry])

  const saveOffline = useCallback(async () => {
    const payload = buildPayload()
    const queuedAt = new Date().toISOString()
    const existingId =
      savedEntryIdRef.current ?? (isEdit && initialEntry ? initialEntry.id : null)
    const edit = buildQueuedEdit({
      // Reuse the id the offline attachment was filed under, otherwise the queued
      // entry and its media would end up under two different ids.
      entryId: existingId ?? offlineEntryIdRef.current ?? undefined,
      payload,
      queuedAt,
      operation: existingId ? "update" : "create",
    })
    // Store the generated UUID so subsequent offline autosaves reuse the same
    // IDB queue key (keyPath="entryId"), preventing duplicate rows on reconnect.
    if (!savedEntryIdRef.current) savedEntryIdRef.current = edit.entryId
    await realIDBAdapter.enqueueEdit(edit)
    // Mirror into entries store so the offline timeline fallback (getAllEntries)
    // shows this entry after an offline page refresh — editQueue is write-only
    // from the timeline's perspective; entries is what getAllEntries() reads.
    if (edit.payload) await realIDBAdapter.putEntry(edit.payload)
  }, [buildPayload, isEdit, initialEntry])

  const doSaveSilently = useCallback(async () => {
    if (isSaving) return
    setIsSaving(true)
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    const result = await libSaveSilently(buildPayload(), {
      entryId: isEdit && initialEntry ? initialEntry.id : null,
      savedEntryId: savedEntryIdRef.current,
      navigate: () => {},
      saveOffline,
      isQueuedLocally: isEntryQueuedLocally,
    })
    if (result.ok) {
      if (result.createdEntryId) {
        savedEntryIdRef.current = result.createdEntryId
        setSavedEntryId(result.createdEntryId)
        setIsEdit(true)
      }
      setIsDirty(false)
      setLastSavedAt(new Date())
      setSaveError(null)
    } else if (result.error) {
      setSaveError(saveErrorText(messages, result))
    }
    setIsSaving(false)
    if (pendingCloseRef.current) {
      pendingCloseRef.current = false
      void doSaveAndCloseRef.current()
    }
  }, [isSaving, buildPayload, isEdit, initialEntry, saveOffline, messages])

  const doSaveAndClose = useCallback(async () => {
    if (isSaving) {
      pendingCloseRef.current = true
      return
    }
    setIsSaving(true)
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    // Pass a no-op navigate: doSaveAndClose is the authority on closing the
    // editor. Closing based on result.ok here ensures the
    // editor always closes on success regardless of what navigate() does inside
    // save-logic — critical for offline path where React async state updates can
    // race with the save Promise resolving.
    const result = await libSaveAndClose(buildPayload(), {
      entryId: isEdit && initialEntry ? initialEntry.id : null,
      savedEntryId: savedEntryIdRef.current,
      navigate: () => {},
      saveOffline,
      isQueuedLocally: isEntryQueuedLocally,
    })
    if (result.ok) {
      if (result.createdEntryId) {
        savedEntryIdRef.current = result.createdEntryId
        setSavedEntryId(result.createdEntryId)
      }
      if (onClose) { onClose() } else { router.back() }
    } else if (result.error) {
      setSaveError(saveErrorText(messages, result))
    }
    setIsSaving(false)
  }, [isSaving, buildPayload, isEdit, initialEntry, router, saveOffline, onClose, messages])
  // Intentional render-time ref sync (pre-existing pattern): consumers only
  // call it from async handlers, never during render.
  // eslint-disable-next-line react-hooks/refs
  doSaveAndCloseRef.current = doSaveAndClose
  // eslint-disable-next-line react-hooks/refs
  doSaveSilentlyRef.current = doSaveSilently

  // Auto-save every 30 seconds when dirty — stays in editor (silent).
  // Deliberately NOT depending on doSaveSilently: its identity changes on every
  // keystroke (via buildPayload → text), which re-armed the timer each time —
  // during continuous typing the 30s autosave never actually fired.
  // Re-arms itself while still dirty (failed save / edits since), so a single
  // missed attempt doesn't disable autosave for the rest of the session.
  useEffect(() => {
    if (!isDirty) return
    const fireAutosave = () => {
      void doSaveSilentlyRef.current().finally(() => {
        if (isDirtyRef.current) {
          autoSaveTimerRef.current = setTimeout(fireAutosave, 30_000)
        }
      })
    }
    autoSaveTimerRef.current = setTimeout(fireAutosave, 30_000)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [isDirty])

  // Guard hard browser navigation (Back / Refresh / Tab-Close) when dirty
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [isDirty])

  async function handleDelete() {
    const entryId = initialEntry?.id ?? savedEntryIdRef.current
    if (!entryId) return
    setIsDeleting(true)
    // Offline queues a delete tombstone instead of failing (Randbefund);
    // also dequeues a still-queued offline create so the next push cannot
    // resurrect the entry the user just deleted.
    const result = await deleteEntryWithOfflineFallback(entryId, realIDBAdapter)
    if (result === "failed") {
      setIsDeleting(false)
      setSaveError(messages.editor.deleteFailed)
      return
    }
    if (onDeleted) onDeleted()
    else router.push("/")
  }

  function handleCancel() {
    if (isDirty) {
      setShowDiscardDialog(true)
    } else if (onClose) {
      onClose()
    } else {
      router.back()
    }
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 px-4 h-12 border-b shrink-0">
          <Button variant="ghost" size="sm" onClick={handleCancel} className="gap-1">
            <X className="h-4 w-4" />
            {messages.common.cancel}
          </Button>

          {/* Save status indicator — subtle, muted, Day-One-style */}
          <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {isSaving && <Loader2 className="h-3 w-3 animate-spin" />}
            {!isSaving && lastSavedAt && (
              <>
                {messages.editor.toolbar.savedAt}&nbsp;·&nbsp;{String(lastSavedAt.getHours()).padStart(2, "0")}:{String(lastSavedAt.getMinutes()).padStart(2, "0")}
              </>
            )}
          </span>

          <div className="flex items-center gap-2">
            {/* Mobile-only metadata button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowMetaSheet(true)}
              className="md:hidden gap-1"
              aria-label={messages.editor.toolbar.detailsAriaLabel}
            >
              <SlidersHorizontal className="h-4 w-4" />
              {messages.editor.toolbar.details}
            </Button>
            {isEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteDialog(true)}
                className="gap-1 text-destructive hover:text-destructive"
                disabled={isDeleting}
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">{messages.editor.toolbar.delete}</span>
              </Button>
            )}
            <Button
              size="sm"
              onClick={doSaveAndClose}
              disabled={isSaving}
              title={messages.editor.toolbar.doneTitle}
              className="gap-1"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSaving ? messages.editor.toolbar.saving : messages.editor.toolbar.done}
            </Button>
          </div>
        </div>

        {/* Save error banner */}
        {saveError && (
          <div className="px-4 py-1.5 bg-destructive/10 text-destructive text-xs border-b border-destructive/20 shrink-0">
            {saveError}
          </div>
        )}

        {/* Editor body */}
        <div className="flex flex-1 min-h-0">
          {/* Text area */}
          <ScrollArea className="flex-1">
            <div className="max-w-2xl mx-auto px-8 py-8">
              <Textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault()
                    doSaveAndClose()
                  }
                }}
                placeholder={messages.editor.placeholder}
                className="w-full min-h-[400px] border-none shadow-none resize-none font-reading text-[17px] leading-[1.7] focus-visible:ring-0 focus-visible:border-b-2 focus-visible:border-primary/40 p-0 bg-transparent placeholder:text-muted-foreground/50 placeholder:font-reading"
                style={{ height: "auto", overflow: "hidden" }}
                autoFocus
              />

              <Separator className="my-8" />

              <PhotoUploader
                initialPhotos={photos}
                entryId={savedEntryId ?? initialEntry?.id}
                ensureEntryId={ensureEntryId}
                onChange={setPhotos}
              />
            </div>
          </ScrollArea>

          {/* Metadata sidebar */}
          <div className="hidden md:block w-64 shrink-0 border-l">
            <ScrollArea className="h-full">
              <div className="p-4">
                <MetadataPanel
                  journals={journals}
                  journalId={journalId}
                  onJournalChange={setJournalId}
                  createdAt={createdAt}
                  onDateChange={setCreatedAt}
                  starred={starred}
                  onStarredChange={setStarred}
                  tags={tags}
                  onTagsChange={setTags}
                  locationName={locationName}
                  onLocationNameChange={setLocationName}
                  locationLat={locationLat}
                  onLocationLatChange={setLocationLat}
                  locationLng={locationLng}
                  onLocationLngChange={setLocationLng}
                />
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* Mobile metadata sheet — replaces the hidden md:block sidebar on narrow screens */}
      <Sheet open={showMetaSheet} onOpenChange={setShowMetaSheet}>
        <SheetContent side="bottom" className="h-[80dvh] overflow-y-auto pb-safe">
          <SheetHeader className="mb-4">
            <SheetTitle>{messages.editor.metaSheetTitle}</SheetTitle>
          </SheetHeader>
          <MetadataPanel
            journals={journals}
            journalId={journalId}
            onJournalChange={setJournalId}
            createdAt={createdAt}
            onDateChange={setCreatedAt}
            starred={starred}
            onStarredChange={setStarred}
            tags={tags}
            onTagsChange={setTags}
            locationName={locationName}
            onLocationNameChange={setLocationName}
            locationLat={locationLat}
            onLocationLatChange={setLocationLat}
            locationLng={locationLng}
            onLocationLngChange={setLocationLng}
          />
        </SheetContent>
      </Sheet>

      <DeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        isDeleting={isDeleting}
      />

      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.editor.discardDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {messages.editor.discardDialog.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.editor.discardDialog.keepEditing}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (onClose) { onClose() } else { router.back() } }}>{messages.editor.discardDialog.discard}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
