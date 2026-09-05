export const LOCALES = ["de", "en", "fr"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "de"

/** Self-names for the language picker — each language names itself, identical in every UI language. */
export const LANGUAGE_LABELS: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
}

/** BCP-47 tags for Intl/toLocale* formatting (en deliberately en-GB: 24h clock, day-month order). */
export const LOCALE_TAGS: Record<Locale, string> = {
  de: "de-DE",
  en: "en-GB",
  fr: "fr-FR",
}

/** Cookie so the server renders <html lang> and SSR output in the right language. */
export const LOCALE_COOKIE = "within_locale"
/** localStorage keys — offline source of truth on the device. */
export const LOCALE_STORAGE_KEY = "within.locale"
export const LOCALE_PENDING_KEY = "within.locale.pendingSync"

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}
