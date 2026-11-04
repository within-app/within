import { isValidTimeZone } from "@/lib/timezone"

// IANA-Name mit Bereich oder UTC/GMT. Versatz-Schreibweisen fallen durch: Postgres
// liest das Vorzeichen von "+02:00" oder "GMT+2" umgekehrt zum Browser.
const IANA_NAME = /^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/

// SQLSTATE, mit dem Postgres eine unbekannte Zone ablehnt.
const INVALID_PARAMETER_VALUE = "22023"

const answers = new Map<string, boolean>()

/** Nur für Tests. */
export function resetAcceptedTimeZones(): void {
  answers.clear()
}

/**
 * Prüft eine Zone von außen (Gerät, Export), bevor sie in entries.time_zone
 * landet. Eine Zone, die Postgres nicht kennt, ließe später jede Abfrage
 * scheitern, die diesen Eintrag berührt. Fragt deshalb die Datenbank selbst und
 * merkt sich die Antwort. Nicht innerhalb einer Transaktion aufrufen: Eine
 * abgelehnte Zone bricht sie sonst ab. Ein anderer Datenbankfehler (Timeout,
 * Verbindung) sagt nichts über die Zone und geht an den Aufrufer weiter.
 */
export async function acceptedTimeZone(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  tz: unknown
): Promise<string | null> {
  if (typeof tz !== "string" || tz.length > 100 || !IANA_NAME.test(tz) || !isValidTimeZone(tz)) return null
  let known = answers.get(tz)
  if (known === undefined) {
    try {
      await db.query("SELECT NOW() AT TIME ZONE $1", [tz])
      known = true
    } catch (err) {
      if ((err as { code?: string }).code !== INVALID_PARAMETER_VALUE) throw err
      known = false
    }
    answers.set(tz, known)
  }
  return known ? tz : null
}
