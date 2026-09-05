import {
  isLocale,
  LOCALE_COOKIE,
  LOCALE_PENDING_KEY,
  LOCALE_STORAGE_KEY,
  type Locale,
} from "./config"

/** Minimal storage surface so this logic is unit-testable without a browser. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function readStoredLocale(store: KeyValueStore): Locale | null {
  const raw = store.getItem(LOCALE_STORAGE_KEY)
  return isLocale(raw) ? raw : null
}

export function persistLocale(store: KeyValueStore, locale: Locale): void {
  store.setItem(LOCALE_STORAGE_KEY, locale)
}

/** Pending = the device changed the locale but the server hasn't confirmed yet. */
export function hasPendingSync(store: KeyValueStore): boolean {
  return store.getItem(LOCALE_PENDING_KEY) === "1"
}

export function markPendingSync(store: KeyValueStore, pending: boolean): void {
  if (pending) store.setItem(LOCALE_PENDING_KEY, "1")
  else store.removeItem(LOCALE_PENDING_KEY)
}

/**
 * Cookie lets the server render <html lang> and SSR output in the right
 * language. Deliberately no Secure flag: the app is reachable via plain
 * http inside the LAN (Pi :4000) as well as https (:8443).
 */
export function buildLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`
}

interface StartupSyncDecision {
  locale: Locale
  pushToServer: boolean
}

/**
 * Merge rule between device value and server value at app start:
 * - a locally made change that never reached the server (pending) wins and is pushed;
 * - otherwise the server value wins — that's the cross-device inheritance;
 * - without a server value the device keeps what it has.
 */
export function decideStartupSync(args: {
  current: Locale
  pending: boolean
  server: Locale | null
}): StartupSyncDecision {
  if (args.pending) return { locale: args.current, pushToServer: true }
  if (args.server && args.server !== args.current) return { locale: args.server, pushToServer: false }
  return { locale: args.current, pushToServer: false }
}
