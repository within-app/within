"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config"
import { getMessages, type Messages } from "@/lib/i18n"
import { DEFAULT_TIME_ZONE, setAppTimeZone } from "@/lib/timezone"
import {
  buildLocaleCookie,
  decideStartupSync,
  hasPendingSync,
  markPendingSync,
  persistLocale,
  readStoredLocale,
} from "@/lib/i18n/persistence"

interface LocaleContextValue {
  locale: Locale
  messages: Messages
  setLocale: (locale: Locale) => void
  /** App-Zeitzone (APP_TIMEZONE, vom Server) — für Tagesschlüssel und Uhrzeiten. */
  timeZone: string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

/** Writes the locale to every client persistence surface (localStorage, cookie, <html lang>). */
function applyLocaleSideEffects(locale: Locale) {
  try {
    persistLocale(window.localStorage, locale)
  } catch {
    // localStorage kann fehlen (Private Mode) — Cookie + State reichen dann.
  }
  document.cookie = buildLocaleCookie(locale)
  document.documentElement.lang = locale
}

function setPendingFlag(pending: boolean) {
  try {
    markPendingSync(window.localStorage, pending)
  } catch {
    // ohne localStorage kein Pending-Tracking — Server-Sync klappt beim nächsten Wechsel
  }
}

async function pushLocaleToServer(locale: Locale): Promise<boolean> {
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Mounts once in the root layout; initialLocale comes from the request cookie (SSR-consistent),
 *  timeZone from the server environment (APP_TIMEZONE). */
export function LocaleProvider({
  initialLocale,
  timeZone = DEFAULT_TIME_ZONE,
  children,
}: {
  initialLocale: Locale
  timeZone?: string
  children: React.ReactNode
}) {
  // Vor dem Rendern der Kinder eintragen: die reinen Helfer (format.ts,
  // idb-to-*.ts) lesen die Zone ohne Hook. Idempotent, deshalb im Render ok.
  setAppTimeZone(timeZone)
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  const localeRef = useRef(locale)
  localeRef.current = locale

  const applyLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    applyLocaleSideEffects(next)
  }, [])

  // User-initiated switch: apply locally first (works offline), then sync to the server.
  const setLocale = useCallback(
    (next: Locale) => {
      applyLocale(next)
      void pushLocaleToServer(next).then((ok) => setPendingFlag(!ok))
    },
    [applyLocale]
  )

  // Startup: offline-first from localStorage, then inherit the server value.
  useEffect(() => {
    let cancelled = false
    let stored: Locale | null = null
    let pending = false
    try {
      stored = readStoredLocale(window.localStorage)
      pending = hasPendingSync(window.localStorage)
    } catch {
      // localStorage nicht verfügbar — Cookie-Wert (initialLocale) gilt.
    }
    // Offline/SW-cached shells may carry a stale cookie locale — localStorage wins.
    if (stored && stored !== localeRef.current) applyLocale(stored)

    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled) return
        const serverRaw = data && typeof data === "object" ? (data as { locale?: unknown }).locale : null
        const server = isLocale(serverRaw) ? serverRaw : null
        const decision = decideStartupSync({ current: localeRef.current, pending, server })
        if (decision.pushToServer) {
          void pushLocaleToServer(decision.locale).then((ok) => setPendingFlag(!ok))
        } else if (decision.locale !== localeRef.current) {
          applyLocale(decision.locale)
        }
      })
      .catch(() => {
        // offline oder Login-Seite (401) — lokaler Wert gilt weiter
      })

    return () => {
      cancelled = true
    }
  }, [applyLocale])

  return (
    <LocaleContext.Provider value={{ locale, messages: getMessages(locale), setLocale, timeZone }}>
      {children}
    </LocaleContext.Provider>
  )
}

/** Outside the provider (isolated SSR renders, unit tests) components fall back
 *  to German instead of throwing — the provider is mounted app-wide in layout.tsx. */
const FALLBACK_CONTEXT: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  messages: getMessages(DEFAULT_LOCALE),
  setLocale: () => {},
  timeZone: DEFAULT_TIME_ZONE,
}

/** Consume locale + messages. German fallback outside <LocaleProvider>. */
export function useI18n(): LocaleContextValue {
  return useContext(LocaleContext) ?? FALLBACK_CONTEXT
}
