const isProd = process.env.NODE_ENV === "production"

function formatMessage(context: string, error: unknown): string {
  const ts = new Date().toISOString()
  if (isProd) {
    return `[${ts}] ${context}: Interner Fehler`
  }
  const msg = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? `\n${error.stack}` : ""
  return `[${ts}] ${context}: ${msg}${stack}`
}

/** Schwerwiegender Fehler — Aktion ist fehlgeschlagen */
export function logError(context: string, error: unknown): void {
  console.error(formatMessage(context, error))
}

/** Warnung — Aktion ist auf den Fehlerpfad ausgewichen (z.B. ehrliche 503) */
export function logWarn(context: string, error: unknown): void {
  if (isProd) {
    console.warn(`[${new Date().toISOString()}] ${context}: Fallback aktiv`)
  } else {
    console.warn(formatMessage(context, error))
  }
}
