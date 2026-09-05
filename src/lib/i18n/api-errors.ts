import type { Messages } from "./messages/de"

/** Shape of an API error response body — `code` is the stable identifier,
 *  `error` the German server text kept for backwards compatibility. */
export interface ApiErrorBody {
  error?: string
  code?: string
  maxMB?: number
  kind?: string
  retryAfter?: number
}

/**
 * Resolves a user-facing error text from an API response: known codes render
 * in the active UI language, unknown codes (or missing code) fall back to the
 * German server text, and only then to the caller's fallback.
 */
export function apiErrorText(
  messages: Messages,
  body: ApiErrorBody | null | undefined,
  fallback: string
): string {
  const api = messages.errors.api
  const code = body?.code
  if (code === "file_too_large" && typeof body?.maxMB === "number") {
    return api.fileTooLarge(body.maxMB, body.kind ?? "photo")
  }
  if (code === "rate_limited_login" && typeof body?.retryAfter === "number") {
    return api.rateLimitedLogin(body.retryAfter)
  }
  if (code === "rate_limited" && typeof body?.retryAfter === "number") {
    return api.rateLimited(body.retryAfter)
  }
  if (code) {
    const translated = (api.byCode as Record<string, string>)[code]
    if (translated) return translated
  }
  return body?.error ?? fallback
}
