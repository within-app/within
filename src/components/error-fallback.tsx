"use client"

import { Button } from "@/components/ui/button"
import { getMessages } from "@/lib/i18n"
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config"
import { readStoredLocale } from "@/lib/i18n/persistence"

/**
 * Locale without the React context: the LocaleProvider may itself be part of
 * the crashed tree (global-error), so read what it persisted instead —
 * localStorage first, then the <html lang> the server rendered.
 */
export function resolveErrorLocale(): Locale {
  try {
    const stored = readStoredLocale(globalThis.localStorage)
    if (stored) return stored
  } catch {
    // storage blocked or absent — fall through
  }
  const lang = globalThis.document?.documentElement.lang
  return isLocale(lang) ? lang : DEFAULT_LOCALE
}

/** Shared body of error.tsx and global-error.tsx — a reload is the fix for a
 *  stale chunk after a deploy, so no "try again" via reset(). */
export function ErrorFallback() {
  const t = getMessages(resolveErrorLocale()).errorPage
  return (
    <main role="alert" className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="max-w-md text-muted-foreground">{t.body}</p>
      <Button type="button" onClick={() => window.location.reload()}>{t.reload}</Button>
    </main>
  )
}
