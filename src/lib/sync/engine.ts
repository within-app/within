/**
 * Sync engine for offline/online entry synchronisation.
 *
 * Algorithm:
 *   1. push() — send queued local edits to the server
 *   2. pull(since) — fetch server changes since lastSync, write to IDB
 *
 * The engine is dependency-injected with IDBAdapter so it can be unit-tested
 * without a real browser IndexedDB instance.
 */

import type { IDBAdapter } from "@/lib/sync/idb"
import type { SyncEntry, PushResult, SyncResult, QueuedEdit } from "@/lib/sync/types"
import { repairQueueJournalIds, isUsableJournalId } from "@/lib/sync/repair-queue"
import { entryMediaMetaKey } from "@/lib/sync/entry-media-cache"
import { safeUUID } from "@/lib/sync/queue-edit"
import {
  classifyUploadResponse,
  isStuck,
  markAttempt,
  markRejected,
  selectFlushable,
} from "@/lib/sync/media-outbox"
import {
  applyServerPinState,
  clearPinOp,
  ensurePinSyncInitialized,
  readPinOps,
  removePinOpIfUnchanged,
} from "@/lib/sync/pin-ops"

const PAGE_LIMIT = 50

// Bump when the sync protocol adds new fields that must be backfilled for
// existing entries. A mismatch triggers a one-time full pull (since=epoch)
// so pre-existing IDB entries receive the new field (e.g. thumbnailDataUrl).
const SCHEMA_VERSION = "2"

/** User-facing sync error texts — injected so the UI language applies; German
 *  defaults keep the engine self-contained for tests and legacy callers. */
export interface SyncErrorTexts {
  noJournal: string
  networkError: string
  networkErrorNamed: (name: string) => string
  entryNotOnServer: string
  /** Optional API-code translation; falls back to the server-provided text. */
  apiError?: (code: string | undefined, fallback: string) => string
}

const DEFAULT_SYNC_ERROR_TEXTS: SyncErrorTexts = {
  noJournal: "Kein Journal bekannt — Eintrag bleibt lokal in der Warteschlange",
  networkError: "Netzwerkfehler",
  networkErrorNamed: (name) => `Netzwerkfehler (${name})`,
  entryNotOnServer: "Eintrag serverseitig noch nicht vorhanden",
}

/** Optionale Client-Hooks — z. B. Geräte-Schalter „Uploads verkleinern". */
export interface SyncEngineHooks {
  /**
   * Läuft vor jedem Outbox-Upload. `{blob}` ersetzt den Upload-Body (gleiche
   * Idempotenz-Id), `{rejectMessage}` markiert das Item als endgültig
   * fehlgeschlagen (markRejected) — es wird nie wieder hochgeladen versucht.
   */
  prepareUploadBlob?: (
    item: { blob: Blob; mimeType: string; fileName: string }
  ) => Promise<{ blob: Blob } | { rejectMessage: string }>
  /**
   * Pin-Sync: gibt beim per Pull angewandten Unpin die Cache-Bytes
   * des Eintrags frei (media-cache.ts ist browser-only — per Hook injiziert,
   * damit die Engine in Node testbar bleibt).
   */
  uncacheEntryMedia?: (entryId: string) => Promise<void>
}

export function createSyncEngine(
  idb: IDBAdapter,
  baseUrl = "",
  texts: SyncErrorTexts = DEFAULT_SYNC_ERROR_TEXTS,
  hooks: SyncEngineHooks = {}
) {
  async function fetchJson<T>(
    path: string,
    opts?: RequestInit
  ): Promise<{ ok: boolean; status: number; data: T | null }> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      })
      const data: T = res.ok ? await res.json() : null
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  /** Pull-Fehler dürfen nicht wie Erfolg aussehen — failed landet im
   *  SyncResult und im Sync-Badge. Der öffentliche pull() behält seine
   *  Zahl-Signatur für Bestandsaufrufer. */
  async function pullInternal(since: string | null): Promise<{ written: number; failed: boolean }> {
    const effectiveSince = since ?? "1970-01-01T00:00:00.000Z"
    let cursor: string | null = null
    let totalWritten = 0
    let failed = false

    while (true) {
      const params = new URLSearchParams({ since: effectiveSince, limit: String(PAGE_LIMIT) })
      if (cursor) params.set("cursor", cursor)

      const result = await fetchJson<{
        entries: SyncEntry[]
        nextCursor: string | null
        serverTime: string
      }>(`/api/sync/changes?${params}`)

      if (!result.ok || !result.data) {
        failed = true
        break
      }

      for (const entry of result.data.entries) {
        if (entry.deletedAt) {
          await idb.deleteEntry(entry.id)
          // The tombstone is the only signal another device ever gets —
          // drop the cached media list and any outbox files still waiting for
          // the deleted entry (they could never attach again).
          await idb.deleteMeta?.(entryMediaMetaKey(entry.id))
          // Der Pin-Record muss mit — sonst bleiben gepinnte Cache-Bytes
          // unevictbar (Reconcile räumt die Cache-Seite beim nächsten Unlock).
          await idb.deletePin?.(entry.id)
          // Pin-Sync: ein noch offener Pin-Op ist gegenstandslos.
          await clearPinOp(idb, entry.id)
          if (idb.listOutboxMediaForEntry && idb.deleteOutboxMedia) {
            for (const item of await idb.listOutboxMediaForEntry(entry.id)) {
              await idb.deleteOutboxMedia(item.id)
            }
          }
        } else {
          // A remote change is the only sync signal the media cache
          // ever gets (DELETE /api/media bumps updated_at). Invalidate BEFORE
          // overwriting the local copy — read-time stamp comparison is wrong
          // here, because an offline edit legitimately moves the local
          // updatedAt ahead without touching any media.
          const existing = await idb.getEntry(entry.id)
          if (existing && existing.updatedAt !== entry.updatedAt) {
            await idb.deleteMeta?.(entryMediaMetaKey(entry.id))
          }
          await idb.putEntry(entry)
          // Pin-Sync: Server-Pin-Zustand anwenden (Regeln inkl.
          // Rollout-Fail-safe in pin-ops.ts; undefined = alter Server → No-op).
          await applyServerPinState(idb, entry.id, entry.pinnedAt, hooks.uncacheEntryMedia)
        }
      }
      totalWritten += result.data.entries.length

      if (!result.data.nextCursor) {
        await idb.setMeta("lastSync", result.data.serverTime)
        break
      }
      cursor = result.data.nextCursor
    }

    return { written: totalWritten, failed }
  }

  async function pull(since: string | null): Promise<number> {
    return (await pullInternal(since)).written
  }

  /**
   * Rewrite queued edits whose journalId is unusable. Without this an
   * edit created offline before the journal cache existed carries journalId ""
   * and is rejected with 400 on every retry — invisible data loss.
   */
  async function repairQueue(queue: QueuedEdit[]): Promise<{
    queue: QueuedEdit[]
    unrepairable: string[]
  }> {
    if (queue.every((edit) => !edit.payload || isUsableJournalId(edit.payload.journalId))) {
      return { queue, unrepairable: [] }
    }

    let fallbackJournalId = ((await idb.getJournals?.()) ?? [])[0]?.id ?? null
    if (!fallbackJournalId) {
      // The cache may not be populated yet — push() only runs online, so ask the
      // server directly rather than stranding the entry until the next sync.
      const live = await fetchJson<Array<{ id: string }>>("/api/journals")
      if (live.ok && Array.isArray(live.data)) fallbackJournalId = live.data[0]?.id ?? null
    }

    const { repaired, unrepairable } = repairQueueJournalIds(queue, fallbackJournalId)

    if (repaired.length === 0) return { queue, unrepairable }

    const byEntryId = new Map(repaired.map((edit) => [edit.entryId, edit]))
    for (const edit of repaired) {
      await idb.enqueueEdit(edit)                     // persist so a retry keeps the fix
      if (edit.payload) await idb.putEntry(edit.payload) // keep the local mirror consistent
    }
    return { queue: queue.map((edit) => byEntryId.get(edit.entryId) ?? edit), unrepairable }
  }

  async function push(): Promise<PushResult> {
    const rawQueue = await idb.listQueue()
    if (rawQueue.length === 0) return { accepted: [], conflicts: [], errors: [] }

    const { queue: repairedQueue, unrepairable } = await repairQueue(rawQueue)

    const allAccepted: string[] = []
    const allConflicts: PushResult["conflicts"] = []
    const allErrors: PushResult["errors"] = unrepairable.map((entryId) => ({
      entryId,
      message: texts.noJournal,
    }))

    // Unrepairable edits stay queued but are kept out of the request: they would
    // fail validation and add pointless per-entry retries.
    const unrepairableIds = new Set(unrepairable)
    const queue = repairedQueue.filter((edit) => !unrepairableIds.has(edit.entryId))
    if (queue.length === 0) return { accepted: allAccepted, conflicts: allConflicts, errors: allErrors }

    for (let i = 0; i < queue.length; i += PAGE_LIMIT) {
      const batch = queue.slice(i, i + PAGE_LIMIT)

      // Queued deletes replay against the DELETE endpoint. 404 counts as done:
      // the entry either never reached the server (created and deleted while
      // offline) or is already tombstoned — both idempotent successes. Failures
      // stay queued for the next sync. Before this, delete edits were filtered
      // out, reported as accepted and never dequeued — offline deletes silently
      // never reached the server.
      for (const edit of batch) {
        if (edit.operation !== "delete") {
          // A create/update without payload carries nothing to send and can
          // never succeed — drop it instead of retrying forever.
          if (edit.payload === null) await idb.dequeueEdit(edit.entryId)
          continue
        }
        const res = await fetchJson(`/api/entries/${edit.entryId}`, { method: "DELETE" })
        if (res.ok || res.status === 404) {
          await idb.dequeueEdit(edit.entryId)
          allAccepted.push(edit.entryId)
        } else {
          allErrors.push({ entryId: edit.entryId, message: `HTTP ${res.status}` })
        }
      }

      const entries: SyncEntry[] = batch
        .filter((q) => q.operation !== "delete" && q.payload !== null)
        .map((q) => q.payload as SyncEntry)

      if (entries.length === 0) continue

      const result = await fetchJson<PushResult>("/api/sync/upsert", {
        method: "POST",
        body: JSON.stringify({ entries }),
      })

      if (!result.ok || !result.data) {
        // Batch rejected — fall back per-entry to prevent one bad entry from
        // blocking all others (batch-poison). Fallback path preserved:
        // entries remain queued for retry; only permanently-rejected ones are reported.
        const rejected: SyncEntry[] = []
        if (entries.length === 1) {
          if (handleRejectedEntry(entries[0], result.status, allErrors)) rejected.push(entries[0])
        } else {
          for (const singleEntry of entries) {
            const r2 = await fetchJson<PushResult>("/api/sync/upsert", {
              method: "POST",
              body: JSON.stringify({ entries: [singleEntry] }),
            })
            if (!r2.ok || !r2.data) {
              if (handleRejectedEntry(singleEntry, r2.status, allErrors)) rejected.push(singleEntry)
            } else {
              await applyPushResult(r2.data, queue, allAccepted, allConflicts)
            }
          }
        }
        await settleRejected(rejected, queue)
        continue
      }

      await applyPushResult(result.data, queue, allAccepted, allConflicts)
    }

    return { accepted: allAccepted, conflicts: allConflicts, errors: allErrors }
  }

  /**
   * A 400 from /api/sync/upsert is a permanent schema rejection — retrying the
   * identical payload every sync cycle can never succeed, and previously such
   * an edit sat in the queue forever. The user's text is preserved as a
   * conflict copy (visible in the conflict UI) and the edit dequeued — unless a
   * newer version was enqueued while the request was in flight (see
   * settleRejected): then the newer row stays and the next push carries it.
   * Everything else (auth 401, 5xx, network) stays queued as a transient
   * failure. Returns true for a 400 so the caller settles it after the batch.
   */
  function handleRejectedEntry(
    entry: SyncEntry,
    status: number,
    allErrors: { entryId: string; message: string }[]
  ): boolean {
    if (status === 400) {
      allErrors.push({ entryId: entry.id, message: "HTTP 400 — dauerhaft abgelehnt, als Konfliktkopie gesichert" })
      return true
    }
    allErrors.push({ entryId: entry.id, message: `HTTP ${status}` })
    return false
  }

  /**
   * 400-Ablehnungen eines Batches abschließen, geschützt gegen zwischenzeitlich
   * ersetzte Zeilen — eine Queue-Lesung pro Batch statt einer pro Eintrag. Konfliktkopie zuerst
   * (fail-safe: stirbt der Prozess dazwischen, ist der Text gesichert), aber
   * nicht, wenn die inzwischen neuere Zeile denselben Text trägt — sonst wächst
   * pro Sync-Lauf ein identisches Duplikat in der Konflikt-UI.
   */
  async function settleRejected(rejected: SyncEntry[], queue: QueuedEdit[]) {
    if (rejected.length === 0) return
    const guard = await dequeueGuard(queue)
    for (const entry of rejected) {
      const newer = guard.replacedBy(entry.id)
      if (newer?.payload?.text !== entry.text) {
        await idb.putConflict({
          id: safeUUID(),
          entryId: entry.id,
          revisionId: entry.revisionId,
          text: entry.text,
          updatedAt: entry.updatedAt,
          savedAt: new Date().toISOString(),
          tags: entry.tags,
        })
      }
      await guard.dequeueIfUnchanged(entry.id)
    }
  }

  /** Ein Edit, der WÄHREND des laufenden Push-Requests neu enqueued wurde
   *  (Autosave/Cmd+Enter/zweiter Tab ersetzen per keyPath), darf nicht mit
   *  dequeued werden — sonst ist die neuere Version stiller Datenverlust.
   *  Vergleichsbasis: queuedAt + payload-Identität der gesendeten Zeile;
   *  revisionId fängt eine Metadaten-Änderung in derselben Millisekunde. */
  function sameQueuedEdit(a: QueuedEdit, b: QueuedEdit): boolean {
    return (
      a.queuedAt === b.queuedAt &&
      a.operation === b.operation &&
      a.payload?.updatedAt === b.payload?.updatedAt &&
      a.payload?.revisionId === b.payload?.revisionId &&
      a.payload?.text === b.payload?.text
    )
  }

  /** Liest die aktuelle Queue einmal und vergleicht je Eintrag mit der
   *  gesendeten Zeile — für accepted, conflict und den 400-Zweig. */
  async function dequeueGuard(sentQueue: QueuedEdit[]) {
    const sentById = new Map(sentQueue.map((q) => [q.entryId, q]))
    const currentById = new Map((await idb.listQueue()).map((q) => [q.entryId, q]))
    /** Die neuere Zeile, falls der Eintrag WÄHREND des Requests ersetzt wurde — sonst null. */
    const replacedBy = (entryId: string): QueuedEdit | null => {
      const sent = sentById.get(entryId)
      const current = currentById.get(entryId)
      return current && sent && !sameQueuedEdit(current, sent) ? current : null
    }
    return {
      replacedBy,
      // Zeile wurde zwischenzeitlich ersetzt → stehen lassen, der nächste
      // Push liefert die neuere Version nach.
      dequeueIfUnchanged: async (entryId: string) => {
        if (replacedBy(entryId)) return
        await idb.dequeueEdit(entryId)
      },
    }
  }

  async function applyPushResult(
    data: PushResult,
    queue: QueuedEdit[],
    allAccepted: string[],
    allConflicts: PushResult["conflicts"]
  ) {
    const { dequeueIfUnchanged } = await dequeueGuard(queue)

    for (const id of data.accepted) {
      await dequeueIfUnchanged(id)
    }
    allAccepted.push(...data.accepted)

    for (const conflict of data.conflicts) {
      const localEdit = queue.find((q) => q.entryId === conflict.entryId)
      if (localEdit?.payload) {
        await idb.putConflict({
          id: safeUUID(),
          entryId: conflict.entryId,
          revisionId: localEdit.payload.revisionId,
          text: localEdit.payload.text,
          updatedAt: localEdit.payload.updatedAt,
          savedAt: new Date().toISOString(),
          tags: localEdit.payload.tags,
        })
      }
      // The conflict path of /api/sync/upsert returns serverVersion without a
      // thumbnail (always null), unlike the pull path — don't let it wipe the
      // locally cached one until the next pull re-delivers it.
      const localEntry = await idb.getEntry(conflict.entryId)
      await idb.putEntry({
        ...conflict.serverVersion,
        thumbnailDataUrl:
          conflict.serverVersion.thumbnailDataUrl ?? localEntry?.thumbnailDataUrl ?? null,
      })
      await dequeueIfUnchanged(conflict.entryId)
      allConflicts.push(conflict)
    }
  }

  /**
   * Upload everything sitting in the media outbox.
   *
   * Runs AFTER push() on purpose: `/api/upload?entryId=` only writes a media row
   * for an entry that already exists server-side, and an offline-created entry
   * only gets there through the push above. Entries still in the edit queue are
   * therefore skipped, not uploaded blind.
   */
  async function flushMedia(): Promise<{ uploaded: number; failed: number }> {
    if (!idb.listOutboxMedia || !idb.deleteOutboxMedia || !idb.putOutboxMedia) {
      return { uploaded: 0, failed: 0 }
    }

    const items = await idb.listOutboxMedia()
    if (items.length === 0) return { uploaded: 0, failed: 0 }

    const stillQueued = new Set((await idb.listQueue()).map((edit) => edit.entryId))
    const flushable = selectFlushable(items, stillQueued)

    // Items that already gave up still count as failures so the badge keeps
    // reporting them — a photo that never arrives must not look like success.
    // Arrow on purpose: Array.filter passes the index as the second argument,
    // which would land in isStuck's maxAttempts parameter and mark everything stuck.
    let failed = items.filter((item) => isStuck(item)).length
    let uploaded = 0

    for (const item of flushable) {
      let uploadBlob: Blob = item.blob
      let uploadMime = item.mimeType
      if (hooks.prepareUploadBlob) {
        // Fail-closed: Ein Foto, das das Gerät nicht hochladen
        // kann, wird sichtbar abgelehnt statt bei jedem Sync den Tab zu töten.
        const prepared = await hooks.prepareUploadBlob(item)
        if ("rejectMessage" in prepared) {
          await idb.putOutboxMedia(markRejected(item, prepared.rejectMessage))
          failed++
          continue
        }
        uploadBlob = prepared.blob
        if (uploadBlob !== item.blob) uploadMime = uploadBlob.type || item.mimeType
      }
      const fd = new FormData()
      fd.append("file", new File([uploadBlob], item.fileName, { type: uploadMime }))
      // The outbox id doubles as idempotency key — a retry after a lost
      // response finds the already-inserted row instead of duplicating it.
      fd.append("clientMediaId", item.id)

      let ok = false
      let status = 0
      let body: { id?: string } | null = null
      let message = texts.networkError
      try {
        const res = await fetch(
          `${baseUrl}/api/upload?entryId=${encodeURIComponent(item.entryId)}`,
          { method: "POST", body: fd }
        )
        ok = res.ok
        status = res.status
        body = await res.json().catch(() => null)
        if (!ok) {
          const errBody = body as { error?: string; code?: string } | null
          const fallback = errBody?.error ?? `HTTP ${status}`
          message = texts.apiError?.(errBody?.code, fallback) ?? fallback
        } else if (!body?.id) message = texts.entryNotOnServer
      } catch (err) {
        message = err instanceof Error && err.name ? texts.networkErrorNamed(err.name) : texts.networkError
      }

      const verdict = classifyUploadResponse({ ok, status, body })
      if (verdict === "attached") {
        await idb.deleteOutboxMedia(item.id)
        uploaded++
        continue
      }
      if (verdict === "orphaned") {
        // The entry was deleted server-side — the file has no home anymore.
        // Keeping it would show a "waiting" badge for an entry that is gone.
        await idb.deleteOutboxMedia(item.id)
        continue
      }

      const next = verdict === "rejected"
        ? markRejected(item, message)
        : markAttempt(item, message)
      await idb.putOutboxMedia(next)
      if (isStuck(next)) failed++
    }

    return { uploaded, failed }
  }

  /**
   * Pin-Sync: gequeue-te Pin/Unpin-Absichten zum Server pushen.
   * Läuft NACH push() (der Eintrag muss serverseitig existieren — Ops für
   * Einträge, die noch in der editQueue hängen, bleiben liegen) und VOR dem
   * Pull (der eigene Bump erscheint dann direkt im selben Pull). 200 und
   * 404/410 (Eintrag weg — Absicht gegenstandslos) räumen den Op; alle
   * anderen Fehler lassen ihn für den nächsten Sync liegen.
   */
  async function flushPinOps(): Promise<void> {
    // Rollout-Union-Fail-safe zuerst — Bestands-Pins melden sich hoch,
    // bevor ein Pull-NULL je als Unpin gilt (pin-ops.ts).
    await ensurePinSyncInitialized(idb)
    const ops = await readPinOps(idb)
    const entries = Object.entries(ops)
    if (entries.length === 0) return

    const stillQueued = new Set((await idb.listQueue()).map((edit) => edit.entryId))
    for (const [entryId, op] of entries) {
      if (stillQueued.has(entryId)) continue
      const res = await fetchJson(`/api/entries/${encodeURIComponent(entryId)}/pin`, {
        method: "PUT",
        body: JSON.stringify({ pinned: op.pinned }),
      })
      if (res.ok || res.status === 404 || res.status === 410) {
        await removePinOpIfUnchanged(idb, entryId, op)
      }
    }
  }

  async function sync(): Promise<SyncResult> {
    // Kein Sync gegen eine tote Session: sonst pumpt die Engine die komplette
    // Outbox (inkl. Multi-MB-Uploads) auf der Login-Seite in 401er — genau das
    // hat den Handy-Browser abgeschossen (Access-Log-Befund). Die
    // Probe ist ein billiger GET; Netzwerkfehler (status 0) blockieren den
    // Offline-Pfad nicht.
    const probe = await fetchJson<unknown>("/api/settings")
    if (probe.status === 401 || probe.status === 403) {
      return {
        pulled: 0, pushed: 0, conflicts: 0, errors: 0,
        mediaUploaded: 0, mediaFailed: 0, authRequired: true,
      }
    }

    const storedVersion = await idb.getMeta("schemaVersion")
    const needsBackfill = storedVersion !== SCHEMA_VERSION

    // When the schema version hasn't been stamped (fresh install or post-upgrade),
    // pass null so pull() fetches from epoch — backfilling all existing entries.
    const lastSync = needsBackfill ? null : await idb.getMeta("lastSync")
    const lastSyncBeforePull = needsBackfill ? await idb.getMeta("lastSync") : null

    const pushResult = await push()
    // Pins + media only after push — the entry has to exist server-side first.
    await flushPinOps()
    const media = await flushMedia()
    const pullResult = await pullInternal(lastSync)
    const pulled = pullResult.written

    if (needsBackfill) {
      // Stamp schemaVersion only when pull() confirms success by updating lastSync.
      // If pull failed, lastSync is unchanged and the next sync retries the full pull.
      const lastSyncAfterPull = await idb.getMeta("lastSync")
      if (lastSyncAfterPull !== lastSyncBeforePull) {
        await idb.setMeta("schemaVersion", SCHEMA_VERSION)
      }
    }

    return {
      pulled,
      pullFailed: pullResult.failed,
      pushed: pushResult.accepted.length,
      conflicts: pushResult.conflicts.length,
      errors: pushResult.errors.length,
      mediaUploaded: media.uploaded,
      mediaFailed: media.failed,
    }
  }

  return { pull, push, sync, flushMedia }
}
