/**
 * Helper for building a QueuedEdit when the entry editor saves offline.
 * Pure function — no IDB or React dependency here so it is directly testable.
 */
import type { QueuedEdit, SyncEntry } from "./types"

// crypto.randomUUID() requires a secure context (HTTPS or localhost).
// In the staging Docker environment (http://webapp:4000) the browser's
// isSecureContext can be false despite the --unsafely-treat-insecure-origin-as-secure
// Playwright flag, causing a NotSupportedError.  Fall back to a RFC-4122 v4
// UUID built from Math.random() so offline saves never fail on UUID generation.
export function safeUUID(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
    })
  }
}

/** Subset of the editor's buildPayload() output that is sent to the API. */
export interface OfflineEditorPayload {
  text: string
  journalId: string
  createdAt: string
  starred: boolean
  tags: string[]
  photos: Array<{ filePath: string; thumbnailPath?: string | null }>
  locationName: string | null
  locationLat: number | null
  locationLng: number | null
  weatherDescription: string | null
  weatherTempCelsius: number | null
  weatherIcon: string | null
}

interface BuildQueuedEditOpts {
  /** Existing entry ID — supply for updates, omit to auto-generate for creates. */
  entryId?: string
  payload: OfflineEditorPayload
  /** ISO 8601 string for when this edit was queued. */
  queuedAt: string
  /**
   * Override the derived operation. Needed because an offline photo
   * forces the entry id to be allocated before the first save, so the presence
   * of an id no longer proves the entry already exists.
   */
  operation?: "create" | "update"
}

/**
 * Build a QueuedEdit from an editor payload.
 * For creates, a stable client-side UUID is generated and returned in the edit
 * so the caller can track the entry even before it reaches the server.
 */
export function buildQueuedEdit({
  entryId,
  payload,
  queuedAt,
  operation: operationOverride,
}: BuildQueuedEditOpts): QueuedEdit {
  const id = entryId ?? safeUUID()
  const operation = operationOverride ?? (entryId ? "update" : "create")

  const syncEntry: SyncEntry = {
    id,
    journalId: payload.journalId,
    text: payload.text,
    createdAt: payload.createdAt,
    updatedAt: queuedAt,
    revisionId: safeUUID(),
    starred: payload.starred,
    tags: payload.tags,
    locationName: payload.locationName,
    locationLat: payload.locationLat,
    locationLng: payload.locationLng,
    weatherDescription: payload.weatherDescription,
    weatherTempCelsius: payload.weatherTempCelsius,
    weatherIcon: payload.weatherIcon,
    deletedAt: null,
    thumbnailDataUrl: null,
  }

  return { entryId: id, operation, payload: syncEntry, queuedAt }
}
