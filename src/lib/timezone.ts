/**
 * Eine Zeitzone für die ganze App (APP_TIMEZONE, IANA-Name, Standard UTC).
 *
 * Einträge werden als exakter Zeitpunkt gespeichert (TIMESTAMPTZ). Alles, was
 * daraus einen *Kalendertag* macht — Zeitleiste, Kalender, „An diesem Tag“,
 * Statistiken, Uhrzeit-Anzeige — läuft über diese Helfer und damit über genau
 * eine Zone. Vorher: Server bucketete in UTC, der Browser zeigte Ortszeit —
 * ein Abendeintrag westlich von UTC landete unter dem nächsten Tag.
 *
 * Server: die Zone kommt aus process.env.APP_TIMEZONE (validiert in env.ts).
 * Browser: das Root-Layout reicht sie an den LocaleProvider, der sie hier
 * per setAppTimeZone einträgt; die reinen Helfer (format.ts, idb-to-*.ts …)
 * brauchen dafür keinen Hook. Explizites tz-Argument überstimmt immer.
 */

export const DEFAULT_TIME_ZONE = "UTC"

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

let appTimeZone: string | null = null

/** Aktuelle App-Zone. Server: die Umgebung gewinnt; Browser: der vom Provider
 *  gesetzte Wert. Ohne beides UTC. */
export function getAppTimeZone(): string {
  if (typeof window === "undefined") {
    const env = process.env.APP_TIMEZONE
    if (isValidTimeZone(env)) return env
  }
  return appTimeZone ?? DEFAULT_TIME_ZONE
}

/** Ungültige Zonen werden ignoriert — der Server hat bereits validiert. */
export function setAppTimeZone(tz: string): void {
  if (isValidTimeZone(tz)) appTimeZone = tz
}

export interface ZonedParts {
  year: number
  month: number // 1–12
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sonntag … 6 = Samstag (wie Date#getDay). */
  weekday: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    })
    formatterCache.set(tz, f)
  }
  return f
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Wanduhr-Felder eines Zeitpunkts in der Zone. */
export function zonedParts(date: Date, tz: string = getAppTimeZone()): ZonedParts {
  const parts: Record<string, string> = {}
  for (const p of formatterFor(tz).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday)),
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Tagesschlüssel yyyy-MM-dd in der Zone — der Bucket für alle Ansichten. */
export function dateKey(date: Date, tz: string = getAppTimeZone()): string {
  const p = zonedParts(date, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** MM-DD in der Zone („An diesem Tag“). */
export function monthDay(date: Date, tz: string = getAppTimeZone()): string {
  const p = zonedParts(date, tz)
  return `${pad(p.month)}-${pad(p.day)}`
}

/** HH:mm in der Zone. */
export function timeHHmm(date: Date, tz: string = getAppTimeZone()): string {
  const p = zonedParts(date, tz)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * Ein Date, dessen LOKALE Felder den Wanduhr-Feldern der Zone entsprechen —
 * damit date-fns `format(…)` (arbeitet auf lokalen Feldern) die Zonen-Zeit
 * ausgibt, ohne eine Zeitzonen-Bibliothek. Nur zum Formatieren verwenden,
 * nie als Zeitpunkt weiterrechnen.
 */
export function toZonedDate(date: Date, tz: string = getAppTimeZone()): Date {
  const p = zonedParts(date, tz)
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

/** Reine Kalenderarithmetik auf yyyy-MM-dd (zonenfrei, via Date.UTC). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

export interface WallClock {
  year: number
  month: number // 1–12
  day: number
  hour?: number
  minute?: number
  second?: number
}

/**
 * Umkehrung von zonedParts: Wanduhr-Felder der Zone → exakter Zeitpunkt.
 * Für die Eingabe von Datum/Uhrzeit im Editor. Zwei Näherungsschritte reichen
 * für alle regulären Fälle inklusive Sommer-/Winterzeit; eine Wanduhr-Zeit in
 * der Sommerzeit-Lücke (z.B. 02:30 am Umstellungstag) existiert nicht und
 * landet auf dem nächstgelegenen echten Zeitpunkt.
 */
export function fromZonedFields(w: WallClock, tz: string = getAppTimeZone()): Date {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = w
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz)
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    if (got === wanted) break
    guess += wanted - got
  }
  return new Date(guess)
}

