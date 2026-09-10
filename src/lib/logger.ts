// Meldung + Stack immer loggen — maskiert wird in HTTP-Antworten, nicht im
// Server-Log. Aufrufer übergeben gefangene Fehler (pg, fs, sharp, ffprobe),
// Pfade oder IDs; DATABASE_URL/connectionString stehen in keinem davon.
// Ein Fehlercode (SQLSTATE, ENOENT …) wandert in den Kontext: grep-bar.
function formatMessage(context: string, error: unknown): string {
  const ts = new Date().toISOString()
  const code = (error as { code?: unknown } | null)?.code
  const tag = typeof code === "string" ? ` (${code})` : ""
  const msg = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? `\n${error.stack}` : ""
  return `[${ts}] ${context}${tag}: ${msg}${stack}`
}

/** Schwerwiegender Fehler — Aktion ist fehlgeschlagen */
export function logError(context: string, error: unknown): void {
  console.error(formatMessage(context, error))
}

/** Warnung — Aktion ist auf den Fehlerpfad ausgewichen (z.B. ehrliche 503) */
export function logWarn(context: string, error: unknown): void {
  console.warn(formatMessage(context, error))
}
