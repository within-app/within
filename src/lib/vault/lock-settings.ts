/**
 * Device-local auto-lock settings.
 *
 * Stored in localStorage like the upload-downscale switch: a per-device
 * preference, not journal content — deliberately outside the encrypted stores
 * so it is readable while locked. Pure module (storage injected) for tests.
 */

export const IDLE_MINUTES_KEY = "within.lock.idleMinutes"
export const IDLE_MINUTES_DEFAULT = 5
export const IDLE_MINUTES_CHOICES = [1, 5, 15, 30] as const

/** Grace period after the app is hidden before it locks — switching apps for
 *  a moment must not cost a PIN entry, leaving the phone somewhere does. */
export const HIDE_LOCK_GRACE_MS = 30_000

/** Was den Idle-Timer neu aufzieht. wheel + mousemove decken den
 *  Desktop ab (offizieller Zugriffsweg): reines Lesen mit
 *  Scrollrad/Maus ist Aktivität — vorher sperrte die App nach Ablauf der
 *  Idle-Zeit mitten im Lesen eines langen Eintrags. */
export const AUTO_LOCK_ACTIVITY_EVENTS = [
  "touchstart",
  "touchmove",
  "keydown",
  "pointerdown",
  "wheel",
  "mousemove",
] as const

type StorageLike = Pick<Storage, "getItem" | "setItem">

export function readIdleMinutes(storage: StorageLike): number {
  try {
    const raw = storage.getItem(IDLE_MINUTES_KEY)
    if (raw === null) return IDLE_MINUTES_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    return (IDLE_MINUTES_CHOICES as readonly number[]).includes(parsed)
      ? parsed
      : IDLE_MINUTES_DEFAULT
  } catch {
    return IDLE_MINUTES_DEFAULT
  }
}

export function writeIdleMinutes(storage: StorageLike, minutes: number): void {
  try {
    storage.setItem(IDLE_MINUTES_KEY, String(minutes))
  } catch {
    // Quota/private mode — the default applies on next read.
  }
}
