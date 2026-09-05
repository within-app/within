"use client"

/**
 * React binding for the local vault (Sicherheitskonzept Offline-Daten).
 *
 * This hook carries the PIN vault that actually encrypts the offline data.
 *
 * Auto-lock triggers while unlocked:
 *  - idle for the configured minutes (device setting, lock-settings.ts)
 *  - app hidden longer than the grace period (visibilitychange)
 *  - pagehide → immediate lock (next open starts locked)
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  changeVaultPin,
  getVaultStatus,
  lockVault,
  resetVaultAndLocalData,
  setupVault,
  subscribeVault,
  unlockVault,
  type VaultStatus,
} from "@/lib/vault/vault"
import { runVaultMigration } from "@/lib/sync/idb"
import { reconcileMediaLRU } from "@/lib/offline/media-cache"
import { runPreviewMirror } from "@/lib/offline/preview-mirror"
import { AUTO_LOCK_ACTIVITY_EVENTS, HIDE_LOCK_GRACE_MS, readIdleMinutes } from "@/lib/vault/lock-settings"

type VaultLockState = VaultStatus | "loading"

async function migrateAndCleanLegacy(): Promise<void> {
  await runVaultMigration()
  try {
    // Purge the legacy plaintext media cache and heal LRU ghost
    // rows. Best effort — a failed cleanup must never block the unlock.
    await reconcileMediaLRU()
  } catch {
    // Cache Storage unavailable — nothing cached there either.
  }
  try {
    // Offline-Medienspiegel nach dem Unlock nachziehen —
    // selbst-geguarded (nur online + entsperrt, 10-min-Throttle).
    await runPreviewMirror()
  } catch {
    // Best effort — der nächste Sync-Lauf probiert es erneut.
  }
  try {
    // The pre-vault plaintext journal cache (legacy path) — the
    // encrypted IDB copy replaces it, see load-journals.ts.
    localStorage.removeItem("within.journals.cache")
  } catch {
    // localStorage unavailable — ignore.
  }
}

export function useVaultLock() {
  const [status, setStatus] = useState<VaultLockState>("loading")
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await getVaultStatus())
  }, [])

  useEffect(() => {
    void refresh()
    return subscribeVault(() => void refresh())
  }, [refresh])

  // Auto-lock wiring — armed only while unlocked.
  useEffect(() => {
    if (status !== "unlocked") return

    const armIdle = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      const minutes = readIdleMinutes(window.localStorage)
      idleTimer.current = setTimeout(() => lockVault(), minutes * 60 * 1000)
    }

    const onActivity = () => armIdle()
    AUTO_LOCK_ACTIVITY_EVENTS.forEach((ev) =>
      document.addEventListener(ev, onActivity, { passive: true })
    )

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => lockVault(), HIDE_LOCK_GRACE_MS)
      } else if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
    }
    // pagehide: the page is going away (navigation, tab close, bfcache) —
    // drop the key immediately, the next open must start locked.
    const onPageHide = () => lockVault()

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onPageHide)
    armIdle()

    return () => {
      AUTO_LOCK_ACTIVITY_EVENTS.forEach((ev) => document.removeEventListener(ev, onActivity))
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onPageHide)
      if (idleTimer.current) clearTimeout(idleTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [status])

  const setup = useCallback(async (pin: string) => {
    await setupVault(pin)
    await migrateAndCleanLegacy()
  }, [])

  const unlock = useCallback(async (pin: string) => {
    const ok = await unlockVault(pin)
    if (ok) await migrateAndCleanLegacy()
    return ok
  }, [])

  const resetAll = useCallback(async () => {
    await resetVaultAndLocalData()
    // Full reload: every in-memory view still holds decrypted state.
    window.location.assign("/login")
  }, [])

  return {
    status,
    setup,
    unlock,
    lock: lockVault,
    changePin: changeVaultPin,
    resetAll,
  }
}
