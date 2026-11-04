/**
 * App-Zone (APP_TIMEZONE, IANA-Name, Standard UTC) und Zone je Eintrag.
 *
 * Einträge werden als exakter Zeitpunkt gespeichert (TIMESTAMPTZ). Alles, was
 * daraus einen *Kalendertag* macht — Zeitleiste, Kalender, „An diesem Tag“,
 * Statistiken, Uhrzeit-Anzeige — läuft über diese Helfer: in der Zone des
 * Eintrags (zoneOf), ohne Angabe in der App-Zone. Vorher: Server bucketete in UTC, der Browser zeigte Ortszeit —
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

const knownZones = new Map<string, boolean>()

/**
 * Zone eines Eintrags: seine eigene, ohne Angabe die App-Zone. Kennt dieses
 * Gerät den Namen nicht (ältere Zeitzonendaten im Browser), gilt ebenfalls die
 * App-Zone; formatToParts würde sonst die ganze Ansicht sprengen.
 */
export function zoneOf(tz?: string | null): string {
  if (!tz) return getAppTimeZone()
  let known = knownZones.get(tz)
  if (known === undefined) {
    known = isValidTimeZone(tz)
    knownZones.set(tz, known)
  }
  return known ? tz : getAppTimeZone()
}

/** Zone des Geräts, für neue Einträge. Null, wenn der Browser keine nennt. */
export function deviceTimeZone(): string | null {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return isValidTimeZone(tz) ? tz : null
}

/**
 * Heute aus Sicht des Geräts, für „Heute“ und „Gestern“: Tagesansicht und Eintrag
 * müssen dasselbe sagen, auch wenn Gerät, Eintrag und App-Zone auseinanderliegen.
 * Auf dem Server gibt es kein Gerät, dort gilt die App-Zone.
 */
export function deviceTodayKey(): string {
  const tz = typeof window === "undefined" ? getAppTimeZone() : deviceTimeZone() ?? getAppTimeZone()
  return dateKey(new Date(), tz)
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

/**
 * Serie: aufeinanderfolgende Tage bis zum letzten Eintrag. Gestern gilt als
 * Start, solange heute noch nichts steht. Morgen zählt auch, weil ein Eintrag
 * östlich der App-Zone dort schon am nächsten Tag stehen kann; die längere Kette
 * gewinnt, damit ein einzeln auf morgen datierter Eintrag die Serie nicht abwertet.
 */
export function streakLength(days: Set<string>, todayKey: string): number {
  const chainFrom = (start: string) => {
    let length = 0
    while (days.has(shiftDateKey(start, -length))) length++
    return length
  }
  const current = chainFrom(days.has(todayKey) ? todayKey : shiftDateKey(todayKey, -1))
  return Math.max(current, chainFrom(shiftDateKey(todayKey, 1)))
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

