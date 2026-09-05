import { NextResponse } from "next/server"
import { z } from "zod"
import { isValidTimeZone } from "@/lib/timezone"

const EnvSchema = z.object({
  DATABASE_URL:      z.string().min(1, "DATABASE_URL ist nicht gesetzt"),
  // Das Login-Passwort kommt als Klartext (APP_PASSWORD, wird beim Start gehasht
  // und in der Datenbank abgelegt) oder als fertiger Hash (APP_PASSWORD_HASH).
  // Ob am Ende ein Hash existiert, prüft instrumentation.ts nach der Migration —
  // nach dem ersten Start darf der Klartext aus der Datei verschwinden.
  APP_PASSWORD:      z.string().optional(),
  APP_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET:    z.string().min(32, "SESSION_SECRET muss mindestens 32 Zeichen lang sein"),
  // Zeitzone für alle Kalendertag-Ableitungen (src/lib/timezone.ts). Optional,
  // Standard UTC — aber ein Tippfehler darf nicht still zu UTC werden.
  APP_TIMEZONE:      z.string().optional().refine(
    (tz) => tz === undefined || isValidTimeZone(tz),
    "APP_TIMEZONE ist kein gültiger IANA-Zeitzonen-Name (z.B. Europe/Berlin, America/New_York, UTC)"
  ),
})

// Validiert Pflicht-ENV-Variablen beim ersten Import.
// Wirft einen klaren Fehler statt eines kryptischen Runtime-Fehlers später.
const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  - ${String(i.path[0])}: ${i.message}`).join("\n")
  console.error(
    `[env] Fehlende oder ungültige Umgebungsvariablen:\n${missing}\n` +
    `Die App kann nicht korrekt starten. Bitte die Umgebungsvariablen (docker-compose.yml) prüfen.`
  )
  // In production, fail fast — a missing SESSION_SECRET means
  // the app cannot authenticate users at all. Exiting here avoids a zombie process
  // that silently returns 503s on every request.
  // NEXT_PHASE is 'phase-production-build' during `next build` — runtime secrets
  // aren't available then (Pi .env is injected only at container start). Skip the
  // exit during build; it fires correctly when `node server.js` starts.
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    process.exit(1)
  }
}

/** Canonical honest-503 response for DB unavailability — never mock data. */
export function dbUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: "Daten derzeit nicht verfügbar", code: "db_unavailable" }, { status: 503 })
}
