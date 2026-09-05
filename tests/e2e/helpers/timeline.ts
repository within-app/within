import { expect, type Locator, type Page } from "@playwright/test"

/**
 * Union-Selektor für eine Timeline-Karte. Seit der Tages-Karte
 * rendert ein Kalendertag mit 2+ Einträgen eine
 * `day-card` statt einer `entry-card`; ein Tag mit genau einem Eintrag bleibt
 * unverändert `entry-card`. Für DOM-Zählungen und "irgendeine Karte da"-Checks,
 * die in beiden Layouts gelten müssen.
 */
export const TIMELINE_CARD = '[data-testid="entry-card"], [data-testid="day-card"]'

/** Kurzer Check, ob die Karte schon (nicht erst später) da ist — Timeline-Inhalt steht zu diesem Zeitpunkt bereits. */
const QUICK_CHECK_MS = 5_000

/**
 * Heutiger Tagesschlüssel (YYYY-MM-DD) in der App-Zone — Format von
 * DateGroup.date / day-card[data-date]. Zone kommt aus E2E_APP_TIMEZONE
 * (Default UTC, wie die Suite sie normalerweise fährt); en-CA formatiert
 * direkt als YYYY-MM-DD, kein manuelles Teile-Zusammensetzen nötig.
 */
export function utcDateKey(d: Date = new Date()): string {
  const tz = process.env.E2E_APP_TIMEZONE ?? "UTC"
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
}

async function isVisibleWithin(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Klickt die Karte zum Marker-Text an und navigiert in die Detailansicht —
 * robust gegen beide Layouts, aber OHNE auf Erfolg (den "Eintrag
 * bearbeiten"-Knopf) zu warten. Für Fälle, die einen Fehlzustand erwarten
 * (z.B. ein serverseitig gelöschter Eintrag) — openEntryByMarker baut
 * auf dieser Funktion auf und ergänzt die Erfolgs-Erwartung.
 */
export async function openCardByMarker(
  page: Page,
  marker: string,
  dateKey: string = utcDateKey(),
  timeout = 15_000
): Promise<void> {
  const main = page.getByRole("main")
  const entryCard = main.locator('[data-testid="entry-card"]', { hasText: marker }).first()
  const dayCard = main.locator(`[data-testid="day-card"][data-date="${dateKey}"]`).first()

  // Kurzes Timeout: die Timeline steht zu diesem Zeitpunkt schon, kein Warten
  // auf den vollen Timeout nötig, bevor auf die day-card umgeschaltet wird.
  if (await isVisibleWithin(entryCard, QUICK_CHECK_MS)) {
    await entryCard.click()
    return
  }

  if (!(await isVisibleWithin(dayCard, timeout))) {
    throw new Error(
      `openCardByMarker: weder entry-card mit Marker "${marker}" noch day-card[data-date="${dateKey}"] ` +
        `wurden innerhalb von ${timeout}ms sichtbar.`
    )
  }

  await dayCard.click()
  const dayDetail = page.locator('[data-testid="day-detail"]')
  await dayDetail.waitFor({ state: "visible", timeout })

  const section = dayDetail.locator("article", { hasText: marker }).first()
  // exact: true — sonst matcht die Foto-Galerie ("Foto 1 von 1 öffnen") per
  // Substring-Vergleich mit, wenn der Eintrag Medien hat.
  await section.getByRole("button", { name: "Öffnen", exact: true }).click()
}

/**
 * Öffnet einen Eintrag über seinen Marker-Text — robust gegen beide Layouts.
 * Steht der Eintrag allein an seinem Tag, ist er noch eine `entry-card` und
 * wird direkt angeklickt. Teilt er sich den Tag mit anderen Einträgen, ist er
 * in eine `day-card` gefaltet (nur die ersten drei Zeilen sichtbar — der
 * Marker taucht dort u.U. gar nicht auf): dann über die Tages-Vorschau
 * (`day-detail`, zeigt jeden Eintrag vollständig) und dessen „Öffnen"-Knopf.
 * `dateKey` ist der UTC-Tagesschlüssel des Eintrags (Default: heute).
 * Wirft einen klaren Fehler, wenn innerhalb von `timeout` weder Karte auftaucht.
 */
export async function openEntryByMarker(
  page: Page,
  marker: string,
  dateKey: string = utcDateKey(),
  timeout = 15_000
): Promise<void> {
  await openCardByMarker(page, marker, dateKey, timeout)
  await expect(page.getByRole("button", { name: "Eintrag bearbeiten" })).toBeVisible({ timeout })
}

/**
 * Erfüllt, sobald der Eintrag mit seinem Marker-Text in der Timeline
 * nachweisbar ist — als eigene `entry-card`, oder (gefaltet) über die
 * Tages-Vorschau der `day-card[data-date=dateKey]`: klickt sie auf, prüft
 * dass `day-detail` den Marker enthält, und stellt den Ausgangszustand per
 * Escape wieder her (day-detail wieder geschlossen). Kein `.or()`-Locator —
 * der würde im Strict-Mode auf mehrere Elemente auflösen können, sobald
 * mehrere day-cards/entry-cards gleichzeitig im DOM stehen. Für Specs, die
 * nur "der Eintrag ist da" brauchen, nicht ihn offen lassen wollen (dafür:
 * openEntryByMarker).
 */
export async function expectEntryInTimeline(
  page: Page,
  marker: string,
  opts: { timeout?: number; dateKey?: string } = {}
): Promise<void> {
  const { timeout = 15_000, dateKey = utcDateKey() } = opts
  const main = page.getByRole("main")
  const entryCard = main.locator('[data-testid="entry-card"]', { hasText: marker }).first()

  if (await isVisibleWithin(entryCard, QUICK_CHECK_MS)) return

  const dayCard = main.locator(`[data-testid="day-card"][data-date="${dateKey}"]`).first()
  await expect(dayCard).toBeVisible({ timeout })
  await dayCard.click()

  const dayDetail = page.locator('[data-testid="day-detail"]')
  await expect(dayDetail).toContainText(marker, { timeout })

  // Zustand wiederherstellen, damit die Timeline danach so dasteht wie zuvor.
  await page.keyboard.press("Escape")
  await dayDetail.waitFor({ state: "hidden", timeout })
}
