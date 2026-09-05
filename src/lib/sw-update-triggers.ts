/**
 * SW-Update-Fluss-Härtung (Feldbefund 23.08.): register() prüft nur beim
 * Seitenladen auf neue SW-Bytes; App-Router-Navigationen sind
 * Soft-Navigationen ohne Update-Check. Ein Tab, der über einen Deploy hinweg
 * offen bleibt, sieht den neuen SW dadurch erst nach einem harten Reload —
 * der Update-Prompt erschien nie, und alte Page-Chunks liefen unbegrenzt
 * weiter (Pin blieb geräte-lokal, ohne Fehler, ohne Hinweis).
 *
 * Drei zusätzliche Check-Anlässe, alle über reg.update() (nur Erkennung —
 * die Aktivierung bleibt hinter der Nutzer-Bestätigung/SKIP_WAITING,
 * Stolperdraht 5):
 *   1. Intervall — Deploy, während der Tab durchgehend offen ist.
 *   2. Tab wird sichtbar — der Praxisfall: Deploy im Nachbar-Tab,
 *      zurückwechseln zur App.
 *   3. online-Event — Handy kommt aus dem Flugmodus; offline kann kein
 *      Check laufen.
 */

/** 15 min: sw.js-Check ist ein billiger Conditional-GET; die Latenz
 *  Deploy → Prompt soll unter einer Arbeitspause liegen. */
export const SW_UPDATE_CHECK_INTERVAL_MS = 15 * 60_000

interface Listenable {
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
}

export function wireSwUpdateTriggers(
  check: () => Promise<unknown>,
  targets: { win: Listenable; doc: Listenable & { visibilityState: string } },
  intervalMs: number = SW_UPDATE_CHECK_INTERVAL_MS
): () => void {
  // reg.update() wirft u. a. offline — ein verpasster Check ist kein Fehler,
  // der nächste Anlass prüft erneut.
  const safeCheck = () => {
    void check().catch(() => {})
  }
  const onVisibility = () => {
    if (targets.doc.visibilityState === "visible") safeCheck()
  }

  const intervalId = setInterval(safeCheck, intervalMs)
  targets.doc.addEventListener("visibilitychange", onVisibility)
  targets.win.addEventListener("online", safeCheck)

  return () => {
    clearInterval(intervalId)
    targets.doc.removeEventListener("visibilitychange", onVisibility)
    targets.win.removeEventListener("online", safeCheck)
  }
}
