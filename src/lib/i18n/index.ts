import { de as dateFnsDe, enGB as dateFnsEnGB, fr as dateFnsFr } from "date-fns/locale"
import type { Locale as DateFnsLocale } from "date-fns"
import { DEFAULT_LOCALE, LOCALE_TAGS, type Locale } from "./config"
import { de, type Messages } from "./messages/de"
import { en } from "./messages/en"
import { fr } from "./messages/fr"

export type { Messages }

const DICTIONARIES: Record<Locale, Messages> = { de, en, fr }

const DATE_FNS_LOCALES: Record<Locale, DateFnsLocale> = {
  de: dateFnsDe,
  en: dateFnsEnGB,
  fr: dateFnsFr,
}

/**
 * Deep-merges a (potentially partial) dictionary over the German source so a
 * missing key renders German instead of `undefined`. The typed dictionaries
 * can't be partial at compile time — this is the runtime safety net.
 */
export function mergeWithFallback<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(base) as (keyof T)[]) {
    const baseValue = base[key]
    const overrideValue = override[key]
    if (overrideValue === undefined || overrideValue === null) {
      out[key as string] = baseValue
    } else if (
      typeof baseValue === "object" && baseValue !== null &&
      typeof overrideValue === "object"
    ) {
      out[key as string] = mergeWithFallback(baseValue as object, overrideValue as object)
    } else {
      out[key as string] = overrideValue
    }
  }
  return out as T
}

const mergedCache = new Map<Locale, Messages>()

export function getMessages(locale: Locale): Messages {
  if (locale === DEFAULT_LOCALE) return de
  let messages = mergedCache.get(locale)
  if (!messages) {
    messages = mergeWithFallback(de, DICTIONARIES[locale])
    mergedCache.set(locale, messages)
  }
  return messages
}

export function getDateFnsLocale(locale: Locale): DateFnsLocale {
  return DATE_FNS_LOCALES[locale] ?? DATE_FNS_LOCALES[DEFAULT_LOCALE]
}

/** BCP-47 tag for Intl/toLocale* calls. */
export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale] ?? LOCALE_TAGS[DEFAULT_LOCALE]
}

export function formatNumber(value: number, locale: Locale): string {
  return value.toLocaleString(localeTag(locale))
}
