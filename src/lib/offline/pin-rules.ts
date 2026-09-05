/**
 * Pure decision rules for the offline pin.
 *
 * While offline, a fetch through the service worker for an uncached
 * /media/ URL answers with the inline SVG placeholder. `cacheMediaUrls` used
 * to store that response permanently under the full-res key, served
 * cache-first (even later, online) and excluded from the activate cleanup:
 * the placeholder became "the photo" until unpin/eviction.
 *
 * Erkennungs-Umbau: Die Medien-Route sendet jetzt selbst `private, no-store`
 * — no-store ist damit kein SW-Erkennungszeichen mehr (der alte Filter hätte
 * den Pin-Flow komplett totgelegt). SW-Antworten tragen stattdessen den
 * expliziten Marker-Header SW_SERVED_HEADER (media-encryption.ts):
 * "placeholder" bzw. "cache-decrypt". Der SVG-Content-Type bleibt als
 * Fallback für die Update-Übergangszeit mit einem alten SW — echte Uploads
 * können nie SVG sein (upload-security allowlist).
 *
 * Pending photos carry `blob:` object URLs, and Cache Storage cannot
 * hold one — offering it to the pin would fail the whole entry.
 */

import type { Media } from "@/types/journal"

/** May this /media/ response be stored as pinned offline content?
 *  `swServed` = Wert des SW_SERVED_HEADER (null bei frischer Netz-Antwort). */
export function isCacheablePinResponse(res: {
  ok: boolean
  contentType: string | null
  swServed: string | null
}): boolean {
  if (!res.ok) return false
  if ((res.contentType ?? "").toLowerCase().includes("image/svg+xml")) return false
  if (res.swServed !== null) return false
  return true
}

/**
 * Server-side photo URLs of an entry — pending rows stay out.
 *
 * Includes the thumbnail URL alongside the full-res one: the
 * detail grid renders `thumbnailPath || filePath` while the lightbox uses
 * `filePath` (photo-gallery.tsx) — pinning only full-res left the grid on
 * placeholders offline although the photo itself was in the cache.
 */
export function pinnablePhotoUrls(media: Media[]): string[] {
  return media
    .filter((m) => m.type === "photo" && !m.pending)
    .flatMap((m) => (m.thumbnailPath ? [m.filePath, m.thumbnailPath] : [m.filePath]))
}

/**
 * Lokaler Pin-Record für useOfflinePin.
 *
 * Offline ohne gecachte Medien-Liste (Eintrag auf diesem Gerät nie online
 * geöffnet) ist die URL-Liste leer — ohne Pending-Flag hätte der Backfill
 * nichts nachzuladen und die Fotos des gepinnten Eintrags
 * kämen NIE in den Cache. Leere Liste ⇒ mediaUrlsPending, der Backfill
 * löst die URLs beim nächsten Online-Kontakt über GET /api/entries/[id]
 * auf (und räumt das Flag; ein wirklich medienloser Eintrag löst zu [] auf).
 * Bekannte URLs bleiben ohne Flag — fehlende Cache-Einträge deckt der
 * Missing-Scan des Backfills ab.
 */
export function localPinRecord(
  entryId: string,
  mediaUrls: string[],
  pinnedAt: string
): { entryId: string; pinnedAt: string; mediaUrls: string[]; mediaUrlsPending?: boolean } {
  return mediaUrls.length === 0
    ? { entryId, pinnedAt, mediaUrls: [], mediaUrlsPending: true }
    : { entryId, pinnedAt, mediaUrls }
}

/**
 * Sichtbarkeit des Pin-Umschalters.
 *
 * Sichtbar, wenn (a) Foto-URLs bekannt sind, (b) der Eintrag gepinnt ist
 * (Unpin muss IMMER gehen — ein adoptierter Pin ohne gecachte Medien-Liste
 * war sonst offline nicht entpinnbar), oder (c) die Medien-Liste UNBEKANNT
 * ist (Offline-Detail ohne Cache-Hit; eine Korrektur droppt den Key nach dem
 * Pin-eigenen updated_at-Bump): unbekannt ≠ leer — ein Pin mit unbekannter
 * Liste ist seit localPinRecord sicher (mediaUrlsPending → Backfill).
 * Unsichtbar bleibt er nur bei BEKANNT leerer Liste ohne Pin (text-only
 * online, wie bisher).
 */
export function showPinToggle(
  photoUrlCount: number,
  isPinned: boolean,
  mediaListUnknown: boolean
): boolean {
  return photoUrlCount > 0 || isPinned || mediaListUnknown
}

/**
 * Ungepinnte Einträge zeigen offline nur den Text — keine Medien-Kacheln,
 * kein Hinweis (das Pin-Modell ist dem Nutzer bekannt; SW-Platzhalter in
 * Fotogröße wirkten kaputt statt informativ). Gepinnte Einträge zeigen
 * offline ihre Fotos aus dem verschlüsselten Cache.
 */
export function shouldShowEntryMedia(online: boolean, isPinned: boolean): boolean {
  return online || isPinned
}

/**
 * Ergänzung zur Regel oben: Dateien, die noch lokal auf ihren Upload warten
 * (`pending`, aus der mediaOutbox), sind auf dem Gerät vorhanden und werden
 * deshalb IMMER gezeigt — auch offline und ungepinnt. Sie zu verstecken sähe
 * aus wie „der Anhang ist verloren", genau das Problem, das diese Regel
 * behoben hat. Sobald der Upload durch ist, trägt die Zeile kein `pending`
 * mehr und fällt wieder unter die Regel oben.
 *
 * Der sichtbare Fall gibt die Eingabeliste direkt zurück (kein Filterlauf); auf
 * Referenz-Identität baut niemand auf — die Einzelansicht sortiert die Liste
 * danach ohnehin in drei neue Arrays.
 */
export function visibleEntryMedia<T extends { pending?: boolean }>(
  media: T[],
  online: boolean,
  isPinned: boolean
): T[] {
  if (shouldShowEntryMedia(online, isPinned)) return media
  return media.filter((m) => m.pending)
}

/**
 * Die Regel oben samt ihrer Ausnahme, auf eine ganze Lese-Zeile
 * angewandt — dieselbe Entscheidung in Tages-Vorschau und „An diesem Tag",
 * deshalb hier statt zweimal in den Ansichten.
 *
 * Die Zeile kommt unverändert (identisch) zurück, wenn nichts wegfällt: die
 * Ansichten geben sie direkt an ihre Karte weiter, ein Neuaufbau würde nur
 * unnötig neu rendern.
 */
export function withVisibleMedia<T extends { media: Media[] }>(
  entry: T,
  online: boolean,
  isPinned: boolean
): T {
  const media = visibleEntryMedia(entry.media, online, isPinned)
  return media === entry.media ? entry : { ...entry, media }
}
