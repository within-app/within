/**
 * Offline-Medienspiegel.
 *
 * Die Zeitraum-Einstellung (App-Einstellungen) regelt, welche Foto-
 * VORSCHAUEN (Server-Thumbs, `*-thumb.webp`) offline in der Medienübersicht
 * liegen: alle Fotos von Einträgen mit `createdAt` im Zeitraum.
 * Vollauflösungen bleiben ausschließlich für gepinnte Einträge offline
 * (Pins-only-Modell unangetastet).
 *
 * Mechanik — bewusst KEINE neuen Pfade:
 * - Foto-Liste über das bestehende paginierte /api/media (Sync-Feed trägt
 *   weiter keine Medien-Metadaten).
 * - Bytes ausschließlich über cacheMediaUrls: verschlüsselter Umschlag nach
 *   within-media-v2 + LRU-Zeile — Budget-Eviction (Spiegel-Zeilen sind
 *   bewusst räumbar) und Reconcile greifen ohne Umbau.
 * - Registry im verschlüsselten meta-Store hält fest, WAS der Spiegel
 *   verwaltet (Herkunfts-Unterscheidung): Aufräumen fasst NUR eigene
 *   Registry-URLs an, deren LRU-Zeile keinem Pin gehört — Pin-Bytes nie.
 * - Fail closed ohne Session-DEK; nur online; Incident-Lehre:
 *   leere/unplausible/fehlgeschlagene Server-Antwort ⇒ No-op, nie
 *   Totalräumung.
 *
 * Läuft nach Sync (useSync) und nach Unlock (use-vault-lock), Muster
 * backfillPinnedMedia; die Einstellungs-Seite stößt mit force an.
 */
"use client"

import { realIDBAdapter } from "@/lib/sync/idb"
import { getSessionDek } from "@/lib/vault/vault"
import { cacheMediaUrls, uncacheMediaUrl } from "@/lib/offline/media-cache"
import type { PaginatedMedia } from "@/types/journal"

export type PreviewPeriod = "off" | "1m" | "3m" | "6m" | "1y" | "2y" | "all"

export const PREVIEW_PERIODS: readonly PreviewPeriod[] = [
  "off",
  "1m",
  "3m",
  "6m",
  "1y",
  "2y",
  "all",
]

export const PREVIEW_PERIOD_META_KEY = "previewMirror:period"
export const PREVIEW_REGISTRY_META_KEY = "previewMirror:registry"
export const PREVIEW_LASTRUN_META_KEY = "previewMirror:lastRun"

/** Ein vom Spiegel verwaltetes Vorschaubild (Server-Thumb eines Fotos). */
export interface PreviewRegistryItem {
  mediaId: string
  entryId: string
  thumbUrl: string
  createdAt: string // createdAt des Eintrags (Zeitraum-Kriterium)
}

export interface PreviewRegistry {
  items: PreviewRegistryItem[]
  updatedAt: string
}

const THROTTLE_MS = 10 * 60_000
const PER_PAGE = 100
// Loop-Guard: 200 Seiten × 100 = 20.000 Fotos — weit über jedem realen
// Bestand; verhindert Endlosschleifen bei kaputten totalPages-Antworten.
const MAX_PAGES = 200

const MONTHS: Record<Exclude<PreviewPeriod, "off" | "all">, number> = {
  "1m": 1,
  "3m": 3,
  "6m": 6,
  "1y": 12,
  "2y": 24,
}

export function isPreviewPeriod(value: string | null): value is PreviewPeriod {
  return value !== null && (PREVIEW_PERIODS as readonly string[]).includes(value)
}

/** Stichtag des Zeitraums (ISO, UTC) — null bei "all" (kein Stichtag). */
export function previewPeriodSince(
  period: Exclude<PreviewPeriod, "off">,
  now: Date
): string | null {
  if (period === "all") return null
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - MONTHS[period])
  return d.toISOString()
}

export async function readPreviewPeriod(): Promise<PreviewPeriod> {
  try {
    const raw = await realIDBAdapter.getMeta(PREVIEW_PERIOD_META_KEY)
    return isPreviewPeriod(raw) ? raw : "off"
  } catch {
    return "off" // gesperrter Vault o.ä. — fail closed Richtung „Aus"
  }
}

export async function writePreviewPeriod(period: PreviewPeriod): Promise<void> {
  await realIDBAdapter.setMeta(PREVIEW_PERIOD_META_KEY, period)
}

export async function readPreviewRegistry(): Promise<PreviewRegistry> {
  try {
    const raw = await realIDBAdapter.getMeta(PREVIEW_REGISTRY_META_KEY)
    if (!raw) return { items: [], updatedAt: "" }
    const parsed = JSON.parse(raw) as PreviewRegistry
    if (!Array.isArray(parsed.items)) return { items: [], updatedAt: "" }
    return parsed
  } catch {
    return { items: [], updatedAt: "" }
  }
}

/**
 * Foto-Liste des Zeitraums über das bestehende /api/media einsammeln.
 * Wirft bei jeder nicht-ok-Antwort — der Aufrufer macht daraus einen
 * kompletten No-op (nie mit halber Liste aufräumen). Early-stop, sobald
 * eine Seite den Zeitraum verlässt (Server sortiert created_at DESC).
 */
async function fetchPeriodPhotos(since: string | null): Promise<PreviewRegistryItem[]> {
  const items: PreviewRegistryItem[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`/api/media?page=${page}&perPage=${PER_PAGE}`)
    if (!res.ok) throw new Error(`media list failed: ${res.status}`)
    const data = (await res.json()) as PaginatedMedia
    if (!Array.isArray(data.photos)) throw new Error("media list: unexpected shape")

    let leftRange = false
    for (const m of data.photos) {
      if (since && m.createdAt < since) {
        leftRange = true
        continue
      }
      if (m.type !== "photo" || !m.thumbnailPath) continue
      items.push({
        mediaId: m.id,
        entryId: m.entryId,
        thumbUrl: m.thumbnailPath,
        createdAt: m.createdAt,
      })
    }
    if (leftRange || data.page >= data.totalPages) break
  }
  return items
}

/**
 * Aufräumen: eigene Registry-URLs, die nicht mehr zum Soll gehören.
 * Pin-Schutz doppelt: LRU-Zeilen-Besitzer gepinnt ODER URL in einer
 * Pin-Medienliste ⇒ Bytes bleiben (der Pin verwaltet sie), nur die
 * Registry vergisst den Eintrag.
 */
async function cleanupOwnedUrls(
  candidates: PreviewRegistryItem[],
  sollUrls: ReadonlySet<string>
): Promise<void> {
  if (candidates.length === 0) return
  const pins = await realIDBAdapter.listPins()
  const pinnedIds = new Set(pins.map((p) => p.entryId))
  const pinnedUrls = new Set(pins.flatMap((p) => p.mediaUrls ?? []))

  for (const item of candidates) {
    if (sollUrls.has(item.thumbUrl)) continue
    if (pinnedUrls.has(item.thumbUrl)) continue
    const row = await realIDBAdapter.getMediaLRU(item.thumbUrl)
    const owner = row?.entryId ?? item.entryId
    if (pinnedIds.has(owner)) continue
    await uncacheMediaUrl(item.thumbUrl)
  }
}

async function writeRegistry(items: PreviewRegistryItem[], now: Date): Promise<void> {
  await realIDBAdapter.setMeta(
    PREVIEW_REGISTRY_META_KEY,
    JSON.stringify({ items, updatedAt: now.toISOString() } satisfies PreviewRegistry)
  )
}

/**
 * Ein Spiegel-Lauf. Best effort und idempotent; alle Fehlerpfade sind
 * No-ops (der nächste Lauf probiert es erneut). force überspringt den
 * 10-Minuten-Throttle (Einstellungs-Änderung wirkt sofort).
 */
export async function runPreviewMirror(
  opts: { force?: boolean; now?: Date } = {}
): Promise<void> {
  if (typeof caches === "undefined") return
  if (typeof navigator !== "undefined" && navigator.onLine === false) return
  if (!getSessionDek()) return // fail closed ohne Session-DEK
  const now = opts.now ?? new Date()

  const period = await readPreviewPeriod()
  const registry = await readPreviewRegistry()

  if (period === "off") {
    // Aus: eigene, nicht pin-gehörende Einträge räumen; Registry leeren.
    // Kein Server-Kontakt nötig — die Registry IST die eigene Herkunft.
    if (registry.items.length === 0) return
    await cleanupOwnedUrls(registry.items, new Set())
    await writeRegistry([], now)
    return
  }

  if (!opts.force) {
    try {
      const rawLastRun = await realIDBAdapter.getMeta(PREVIEW_LASTRUN_META_KEY)
      if (rawLastRun) {
        const lastRun = JSON.parse(rawLastRun) as { at: string; period: string }
        if (
          lastRun.period === period &&
          now.getTime() - new Date(lastRun.at).getTime() < THROTTLE_MS
        ) {
          return
        }
      }
    } catch {
      // kaputter Stempel — weiterlaufen, unten neu stempeln
    }
  }

  const since = previewPeriodSince(period, now)

  let soll: PreviewRegistryItem[]
  try {
    soll = await fetchPeriodPhotos(since)
  } catch {
    return // Server-/Netzfehler: kompletter No-op, Registry bleibt
  }

  // Incident-Lehre: eine leere Antwort bei nicht-leerer Registry ist
  // unplausibel (Server-Zustand unklar) — No-op statt Totalräumung; auch
  // kein lastRun-Stempel, damit der nächste Anlass sofort erneut prüft.
  if (soll.length === 0 && registry.items.length > 0) return

  // Cachen: pro Eintrag über die bestehende Pin-Cache-Mechanik. Bereits
  // gecachte URLs sind dort ein billiger LRU-Touch: SW-entschlüsselte
  // Treffer werden adoptiert, Platzhalter bleiben draußen.
  const byEntry = new Map<string, string[]>()
  for (const item of soll) {
    const urls = byEntry.get(item.entryId)
    if (urls) urls.push(item.thumbUrl)
    else byEntry.set(item.entryId, [item.thumbUrl])
  }
  for (const [entryId, urls] of byEntry) {
    try {
      await cacheMediaUrls(entryId, urls)
    } catch {
      // Einzel-Fehler: nächster Lauf lädt nach (Missing-Scan über LRU-Zeile)
    }
  }

  // Aufräumen (Zeitraum verkleinert / Fotos vom Server verschwunden):
  // nur eigene Registry-URLs außerhalb des neuen Solls, nie Pin-Bytes.
  const sollUrls = new Set(soll.map((i) => i.thumbUrl))
  await cleanupOwnedUrls(registry.items, sollUrls)

  await writeRegistry(soll, now)
  await realIDBAdapter.setMeta(
    PREVIEW_LASTRUN_META_KEY,
    JSON.stringify({ at: now.toISOString(), period })
  )
}
