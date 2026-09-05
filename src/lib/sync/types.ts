/**
 * Shared types for the offline sync system.
 * Used by both server routes and the client-side engine.
 */

/** Full entry snapshot exchanged during sync push/pull. */
export interface SyncEntry {
  id: string
  journalId: string
  text: string
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601 — used for last-writer-wins
  revisionId: string  // UUID — changes on every server write
  starred: boolean
  tags: string[]
  locationName: string | null
  locationLat: number | null
  locationLng: number | null
  weatherDescription: string | null
  weatherTempCelsius: number | null
  weatherIcon: string | null
  /** ISO 8601 if soft-deleted; null otherwise. Tombstone signal for clients. */
  deletedAt: string | null
  /**
   * Pin-Sync: ISO 8601 wenn serverseitig gepinnt, null wenn nicht.
   * Server → Client only (der Upsert-Zod strippt das Feld — Pins schreibt
   * ausschließlich PUT /api/entries/[id]/pin). `undefined` = Feed eines
   * alten Servers ohne Pin-Sync → Client wendet nichts an (Fail-safe).
   */
  pinnedAt?: string | null
  // Base64 data URL of the entry's FIRST photo thumbnail (~8 kB).
  // Null when the entry has no photos. Server-only; stripped by Zod on push.
  // Intentionally one thumbnail per entry: 1 700 entries × 8 kB already transfers
  // ~13 MB; multiple thumbnails would multiply Pi RAM + bandwidth pressure.
  thumbnailDataUrl: string | null
}

/** An edit queued locally while offline. */
export interface QueuedEdit {
  entryId: string
  operation: 'create' | 'update' | 'delete'
  payload: SyncEntry | null   // null for deletes
  queuedAt: string            // ISO 8601
}

/** Frozen snapshot of the losing version in a conflict. */
export interface ConflictCopy {
  id: string
  entryId: string
  revisionId: string
  text: string
  updatedAt: string
  savedAt: string
  tags: string[]
}

/** Outcome of a push batch. */
export interface PushResult {
  accepted: string[]
  conflicts: { entryId: string; serverVersion: SyncEntry }[]
  /** Entries that could not be pushed (server rejected, not a conflict). */
  errors: Array<{ entryId: string; message: string }>
}

/** Outcome of a full sync cycle. */
export interface SyncResult {
  pulled: number
  /** Der Pull brach mit Fehler ab (5xx/Netzabriss) — Änderungen vom
   *  Server kamen (teilweise) nicht an. Optional für Bestands-Stubs. */
  pullFailed?: boolean
  pushed: number
  conflicts: number
  /** Number of entries the server rejected (not conflicts — permanent errors). */
  errors: number
  /** Files from the offline media outbox attached to their entry. */
  mediaUploaded: number
  /** Files that gave up after MAX_UPLOAD_ATTEMPTS or were rejected outright. */
  mediaFailed: number
  /** Session expired — the sync run aborted before any server mutation. */
  authRequired?: boolean
}
