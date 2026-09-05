export interface SavePayload {
  text: string
  journalId: string
  createdAt: string
  starred: boolean
  tags: string[]
  photos: Array<{ filePath?: string | null; thumbnailPath?: string | null }>
  locationName: string | null
  locationLat: number | null
  locationLng: number | null
  weatherDescription: string | null
  weatherTempCelsius: number | null
  weatherIcon: string | null
  /** The revision_id the client loaded — enables server-side conflict detection on PUT. */
  clientRevisionId?: string
}

export interface SaveOptions {
  /** Existing entry ID for edits (edit mode); null for new entries */
  entryId: string | null
  /** For new entries: ID captured from the first silent POST — prevents duplicate rows */
  savedEntryId: string | null
  /** Called on success only by saveAndClose; saveSilently ignores this */
  navigate: () => void
  /** Override fetch for testing */
  fetchFn?: typeof globalThis.fetch
  /** Override navigator.onLine check */
  isOnline?: () => boolean
  /** Fallback when offline */
  saveOffline?: () => Promise<void>
  /** True while an offline edit for this entry sits in the sync queue.
   *  The queue owns the entry until push() has replayed it: for an
   *  offline-created entry the id is a client UUID with no server row yet,
   *  so a PUT would update zero rows and silently drop this save. */
  isQueuedLocally?: (entryId: string) => Promise<boolean>
}

/** Stable identifier so the UI can render the error in the active language. */
type SaveErrorKey = "offlineUnavailable" | "offlineFailed" | "saveFailed"

export interface SaveResult {
  ok: boolean
  /** Returned when a new entry was POSTed; caller must persist as savedEntryId */
  createdEntryId: string | null
  /** German legacy text — kept for compatibility; prefer errorKey in the UI. */
  error: string | null
  errorKey?: SaveErrorKey
  /** Cause suffix like " (QuotaExceededError)" — belongs to offlineFailed. */
  errorDetail?: string
}

/** Short, user-facing cause hint — the error name is what identifies the fault. */
function describeError(err: unknown): string {
  if (err instanceof DOMException || err instanceof Error) {
    const name = err.name?.trim()
    if (name && name !== "Error") return ` (${name})`
  }
  return ""
}

async function _performSave(
  payload: SavePayload,
  options: SaveOptions,
  navigateOnSuccess: boolean
): Promise<SaveResult> {
  const {
    entryId,
    savedEntryId,
    navigate,
    fetchFn = globalThis.fetch,
    isOnline = () => (typeof navigator !== "undefined" ? navigator.onLine : true),
    saveOffline,
    isQueuedLocally,
  } = options

  if (!isOnline()) {
    if (!saveOffline) {
      return {
        ok: false,
        createdEntryId: null,
        error: "Offline-Speicherung nicht verfügbar",
        errorKey: "offlineUnavailable",
      }
    }
    try {
      await saveOffline()
    } catch (err) {
      // Log root cause for debugging
      console.error("[within/save] offline save failed:", err)
      // Name the cause in the banner too: on a phone the console is
      // out of reach, and "bitte erneut versuchen" is useless advice when the
      // real problem is a full quota or a blocked IndexedDB upgrade.
      return {
        ok: false,
        createdEntryId: null,
        error: `Offline-Speicherung fehlgeschlagen${describeError(err)} – bitte erneut versuchen`,
        errorKey: "offlineFailed",
        errorDetail: describeError(err),
      }
    }
    // navigate() is outside the saveOffline try-catch so an error from navigate
    // is NOT silently masked as "Offline-Speicherung fehlgeschlagen".
    if (navigateOnSuccess) navigate()
    return { ok: true, createdEntryId: null, error: null }
  }

  // Back online, but the entry's offline edit is still queued: the server row
  // may not exist yet (client-generated UUID from an offline create), and a PUT
  // against it would update zero rows without any error — this latest save
  // would be silently lost while the older queued payload syncs later.
  // Save through the queue instead; push() replays it with this payload and
  // creates/updates the row.
  const queuedCandidate = entryId ?? savedEntryId
  if (queuedCandidate && saveOffline && isQueuedLocally) {
    let stillQueued = false
    try {
      stillQueued = await isQueuedLocally(queuedCandidate)
    } catch {
      stillQueued = false // IDB unreadable — fall through to the normal PUT path
    }
    if (stillQueued) {
      try {
        await saveOffline()
      } catch (err) {
        console.error("[within/save] queued-entry save failed:", err)
        return {
          ok: false,
          createdEntryId: null,
          error: `Offline-Speicherung fehlgeschlagen${describeError(err)} – bitte erneut versuchen`,
          errorKey: "offlineFailed",
          errorDetail: describeError(err),
        }
      }
      if (navigateOnSuccess) navigate()
      return { ok: true, createdEntryId: null, error: null }
    }
  }

  try {
    const effectiveEntryId = entryId ?? savedEntryId
    let res: Response
    let createdEntryId: string | null = null

    if (effectiveEntryId) {
      res = await fetchFn(`/api/entries/${effectiveEntryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    } else {
      res = await fetchFn("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const data = (await res.json()) as { id?: string }
        createdEntryId = data.id ?? null
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      console.error("Save failed:", errText)
      return {
        ok: false,
        createdEntryId: null,
        error: "Speichern fehlgeschlagen – bitte erneut versuchen",
        errorKey: "saveFailed",
      }
    }

    if (navigateOnSuccess) navigate()
    return { ok: true, createdEntryId, error: null }
  } catch (err) {
    if (err instanceof TypeError && saveOffline) {
      let savedOffline = false
      try {
        await saveOffline()
        savedOffline = true
      } catch {
        // offline queue also failed — fall through
      }
      if (savedOffline) {
        if (navigateOnSuccess) navigate()
        return { ok: true, createdEntryId: null, error: null }
      }
    }
    console.error("Save error:", err)
    return {
      ok: false,
      createdEntryId: null,
      error: "Speichern fehlgeschlagen – bitte erneut versuchen",
      errorKey: "saveFailed",
    }
  }
}

/** Persist without navigating away — for autosave and background saves */
export function saveSilently(payload: SavePayload, options: SaveOptions): Promise<SaveResult> {
  return _performSave(payload, options, false)
}

/** Persist then navigate back — for the explicit "Fertig" action */
export function saveAndClose(payload: SavePayload, options: SaveOptions): Promise<SaveResult> {
  return _performSave(payload, options, true)
}
