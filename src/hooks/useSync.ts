"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { usePathname } from "next/navigation"
import type { SyncResult } from "@/lib/sync/types"
import { STORAGE_ERROR_EVENT } from "@/lib/sync/entry-media-cache"
import { useI18n } from "@/components/locale-provider"
import { apiErrorText } from "@/lib/i18n/api-errors"
import {
  isDownscaleEnabled,
  tryDownscalePhoto,
  UPLOAD_HARD_CAP_BYTES,
} from "@/lib/upload-downscale"
import { getSessionDek, getVaultStatus, isVaultLockError, subscribeVault } from "@/lib/vault/vault"

/** Sync braucht den Vault-Schlüssel (Queue/Outbox liegen verschlüsselt) —
 *  gesperrt wartet er; der Unlock-Subscriber unten stößt ihn dann an.
 *  Status "none" (vor dem PIN-Setup) blockiert ebenfalls — sonst zieht
 *  der Erst-Sync das komplette Journal im KLARTEXT durch den Passthrough-
 *  Adapter, und ein abgebrochenes Setup lässt es ungeschützt liegen.
 *  Nach setupVault() feuert emit() → der Subscriber startet den Sync. */
export async function isVaultBlockingSync(): Promise<boolean> {
  if (getSessionDek()) return false
  return (await getVaultStatus()) !== "unlocked"
}

/** Best-effort IDB persistence hint — may return false if PWA is not installed or quota is low. */
export async function requestStoragePersistence(): Promise<void> {
  const granted = await navigator.storage?.persist?.()
  if (granted !== undefined) {
    console.log("[within/sync] storage.persist granted:", granted)
  }
}

/** Auf der Login-Seite läuft kein Sync — dort gibt es nie eine gültige Session,
 *  und die Engine würde die Outbox (inkl. großer Uploads) in 401er pumpen. */
export function isLoginPath(pathname: string | null | undefined): boolean {
  return pathname === "/login" || (pathname?.startsWith("/login/") ?? false)
}

export interface SyncState {
  online: boolean
  syncing: boolean
  lastSync: string | null
  pendingCount: number
  conflictCount: number
  lastResult: SyncResult | null
  error: string | null
}

const INITIAL_STATE: SyncState = {
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  syncing: false,
  lastSync: null,
  pendingCount: 0,
  conflictCount: 0,
  lastResult: null,
  error: null,
}

export function useSync(): SyncState & { triggerSync: () => Promise<void> } {
  const [state, setState] = useState<SyncState>(INITIAL_STATE)
  const engineRef = useRef<ReturnType<typeof import("@/lib/sync/engine").createSyncEngine> | null>(null)
  const idbRef    = useRef<import("@/lib/sync/idb").IDBAdapter | null>(null)
  const syncingRef = useRef(false)
  // Pin-Sync: Ein triggerSync WÄHREND eines laufenden Syncs (z. B.
  // Unpin-Klick direkt nach dem Reconnect-Sync) verpuffte — der gequeue-te
  // Pin-Op wartete dann auf einen beliebigen späteren Trigger. Coalescing:
  // der Wunsch wird gemerkt und nach Abschluss genau EINMAL nachgeholt.
  const rerunRef = useRef(false)

  const pathname = usePathname()
  const pathnameRef = useRef(pathname)
  const { messages } = useI18n()
  const messagesRef = useRef(messages)
  // Intentional render-time ref sync (pre-existing pattern, see entry-editor):
  // callbacks read the CURRENT language without re-creating the engine or
  // re-registering window listeners on every locale switch.
  messagesRef.current = messages
  pathnameRef.current = pathname

  const initEngine = useCallback(async () => {
    if (engineRef.current) return
    const { realIDBAdapter } = await import("@/lib/sync/idb")
    const { createSyncEngine } = await import("@/lib/sync/engine")
    idbRef.current    = realIDBAdapter
    engineRef.current = createSyncEngine(realIDBAdapter, "", {
      get noJournal() { return messagesRef.current.errors.sync.noJournal },
      get networkError() { return messagesRef.current.errors.sync.networkError },
      networkErrorNamed: (name) => messagesRef.current.errors.sync.networkErrorNamed(name),
      get entryNotOnServer() { return messagesRef.current.errors.sync.entryNotOnServer },
      apiError: (code, fallback) => apiErrorText(messagesRef.current, { code, error: fallback }, fallback),
    }, {
      // Zweite Verkleinerungs-Chance für Alt-Zombies in der Outbox; bleibt ein
      // Foto trotz aktivem Schalter über der Kappe → endgültig ablehnen statt
      // bei jedem Sync erneut den Tab zu riskieren.
      prepareUploadBlob: async (item) => {
        if (!item.mimeType.startsWith("image/")) return { blob: item.blob }
        let enabled = false
        try {
          enabled = isDownscaleEnabled(window.localStorage)
        } catch { /* localStorage nicht verfügbar */ }
        if (!enabled || item.blob.size <= UPLOAD_HARD_CAP_BYTES) return { blob: item.blob }
        const result = await tryDownscalePhoto(item.blob)
        if (result.ok && result.blob.size <= UPLOAD_HARD_CAP_BYTES) return { blob: result.blob }
        return { rejectMessage: messagesRef.current.errors.sync.photoTooLargeForDevice }
      },
      // Pin-Sync: beim per Pull angewandten Unpin die Cache-Bytes des
      // Eintrags freigeben (browser-only-Modul, deshalb per Hook injiziert).
      uncacheEntryMedia: async (entryId) => {
        const { uncacheEntryMedia } = await import("@/lib/offline/media-cache")
        await uncacheEntryMedia(entryId)
      },
    })
    await requestStoragePersistence()
  }, [])

  const refreshCounts = useCallback(async () => {
    if (!idbRef.current) return
    const [queue, conflicts, lastSyncMeta] = await Promise.all([
      idbRef.current.listQueue(),
      idbRef.current.listConflicts(),
      idbRef.current.getMeta("lastSync"),
    ])
    setState((s) => ({
      ...s,
      pendingCount: queue.length,
      conflictCount: conflicts.length,
      lastSync: lastSyncMeta,
    }))
  }, [])

  const triggerSync = useCallback(async () => {
    if (syncingRef.current) {
      rerunRef.current = true
      return
    }
    if (!navigator.onLine) return
    if (isLoginPath(pathnameRef.current)) return
    if (await isVaultBlockingSync()) return
    try {
      await initEngine()
      if (!engineRef.current) return

      syncingRef.current = true
      setState((s) => ({ ...s, syncing: true, error: null }))

      const runSync = async () => {
        const result = await engineRef.current!.sync()
        // Session tot: nichts wurde gesendet — kein Fehlerbanner, kein
        // lastResult-Nonce-Bump; nach dem Login triggert der Pathname-Effekt.
        if (result.authRequired) {
          await refreshCounts()
          return
        }
        // Name both failure kinds — a stuck photo is as invisible on a phone as a
        // stuck entry, and silence reads as success.
        const problems = [
          result.errors > 0
            ? messagesRef.current.errors.sync.entriesFailed(result.errors)
            : null,
          result.mediaFailed > 0
            ? messagesRef.current.errors.sync.mediaFailed(result.mediaFailed)
            : null,
          // Ein abgebrochener Pull darf nicht wie Erfolg aussehen.
          result.pullFailed ? messagesRef.current.errors.sync.pullFailed : null,
        ].filter(Boolean)
        setState((s) => ({
          ...s,
          lastResult: result,
          error: problems.length > 0 ? problems.join(" · ") : null,
        }))
        await refreshCounts()
        // Pin-Sync: per Pull adoptierte Pins kennen ihre Medien-URLs
        // noch nicht (Feed trägt keine Medien-Metadaten) — jetzt auflösen
        // und verschlüsselt nachladen. Best effort, blockiert den Sync nie.
        try {
          const { backfillPinnedMedia } = await import("@/lib/offline/media-cache")
          await backfillPinnedMedia()
        } catch {
          // Cache Storage nicht verfügbar oder Netz kippte — nächster Lauf.
        }
        // Offline-Medienspiegel nachziehen (Zeitraum-Vorschauen).
        // Selbst-geguarded (nur online + entsperrt, 10-min-Throttle).
        try {
          const { runPreviewMirror } = await import("@/lib/offline/preview-mirror")
          await runPreviewMirror()
        } catch {
          // Best effort — nächster Sync- oder Unlock-Lauf probiert erneut.
        }
      }

      // Use Web Locks API to prevent two open tabs from syncing IDB simultaneously.
      // ifAvailable: true skips instead of queuing when another tab holds the lock.
      if ("locks" in navigator) {
        await navigator.locks.request("within-sync", { ifAvailable: true }, async (lock) => {
          if (lock) await runSync()
        })
      } else {
        await runSync()
      }
    } catch (err) {
      // Auto-Lock mitten im Lauf ist Normalbetrieb, kein Fehler — der
      // Unlock-Subscriber stößt den Sync danach automatisch neu an. Ein
      // Banner (noch dazu mit dem deutschen Roh-Text der VaultLockedError,
      // unabhängig von der UI-Sprache) wäre ein kryptischer Zustand.
      if (!isVaultLockError(err)) {
        const msg = err instanceof Error ? err.message : messagesRef.current.common.unknownError
        setState((s) => ({ ...s, error: msg }))
      }
    } finally {
      syncingRef.current = false
      setState((s) => ({ ...s, syncing: false }))
      if (rerunRef.current) {
        rerunRef.current = false
        void triggerSyncRef.current?.()
      }
    }
  }, [initEngine, refreshCounts])

  // Selbstreferenz für den coalesced Nachlauf im finally-Block oben.
  const triggerSyncRef = useRef<(() => Promise<void>) | null>(null)
  triggerSyncRef.current = triggerSync

  useEffect(() => {
    if (typeof window === "undefined") return

    setState((s) => ({ ...s, online: navigator.onLine }))

    const handleOnline  = () => { setState((s) => ({ ...s, online: true }));  void triggerSync() }
    const handleOffline = () => setState((s) => ({ ...s, online: false }))
    // Storage-layer failures (quota) surface through the same badge as
    // mediaFailed — on a phone the console is out of reach, and a quota-dead
    // media cache silently mimics the accepted "never visited online" limit.
    const handleStorageError = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      setState((s) => ({ ...s, error: detail || messagesRef.current.errors.sync.storageFull }))
    }

    window.addEventListener("online",  handleOnline)
    window.addEventListener("offline", handleOffline)
    window.addEventListener(STORAGE_ERROR_EVENT, handleStorageError)

    void initEngine().then(refreshCounts).then(() => {
      if (navigator.onLine) void triggerSync()
    }).catch((err) => {
      // /login mountet den Provider auch bei gesperrtem Vault (exempt
      // path) — refreshCounts liest dann durch den gesperrten Adapter und
      // warf bei jedem abgelaufenen Session-Login eine Unhandled Rejection.
      if (!isVaultLockError(err)) {
        console.error("[within/sync] init failed:", err)
      }
    })

    return () => {
      window.removeEventListener("online",  handleOnline)
      window.removeEventListener("offline", handleOffline)
      window.removeEventListener(STORAGE_ERROR_EVENT, handleStorageError)
    }
  }, [initEngine, refreshCounts, triggerSync])

  // Nach dem Entsperren des Vaults den aufgestauten Sync anstoßen — der
  // Mount-Trigger lief bei gesperrtem Vault bewusst ins Leere.
  useEffect(() => {
    return subscribeVault(() => {
      if (getSessionDek() && navigator.onLine) void triggerSync()
    })
  }, [triggerSync])

  // Nach erfolgreichem Login (Wechsel weg von /login) den aufgestauten Sync
  // anstoßen — der Mount-Trigger lief auf der Login-Seite bewusst ins Leere.
  const prevPathnameRef = useRef(pathname)
  useEffect(() => {
    const wasLogin = isLoginPath(prevPathnameRef.current)
    prevPathnameRef.current = pathname
    if (wasLogin && !isLoginPath(pathname) && navigator.onLine) {
      void triggerSync()
    }
  }, [pathname, triggerSync])

  return { ...state, triggerSync }
}
