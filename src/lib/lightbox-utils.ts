/** Pure navigation helpers for the photo lightbox. */

export function nextIndex(current: number, total: number): number {
  if (total <= 1) return 0
  return (current + 1) % total
}

export function prevIndex(current: number, total: number): number {
  if (total <= 1) return 0
  return (current - 1 + total) % total
}

/** Returns 'next' (left swipe), 'prev' (right swipe), or null (too short). */
export function swipeDirection(
  startX: number,
  endX: number,
  threshold: number
): "next" | "prev" | null {
  const delta = endX - startX
  if (Math.abs(delta) <= threshold) return null
  return delta < 0 ? "next" : "prev"
}

type Preloadable = { filePath: string; thumbnailPath?: string | null }

/**
 * Thumbnail URLs of the adjacent images, for preloading.
 * Falls back to filePath when thumbnailPath is absent.
 * Returns [] for single-photo galleries (nothing to preload).
 * Deduped: in a 2-photo gallery prev and next are the same photo —
 * returning it twice produced duplicate React keys in the preload list.
 */
export function preloadUrls(
  currentIndex: number,
  photos: Preloadable[]
): string[] {
  if (photos.length <= 1) return []
  const resolve = (p: Preloadable) => p.thumbnailPath ?? p.filePath
  const prev = photos[prevIndex(currentIndex, photos.length)]
  const next = photos[nextIndex(currentIndex, photos.length)]
  return [...new Set([resolve(prev), resolve(next)])]
}

/**
 * Das aktuell gezeigte Foto — `null`, wenn die Lightbox zu ist ODER der Index
 * nicht mehr existiert.
 *
 * Die Liste kann schrumpfen, WÄHREND die Lightbox offen ist: die Einzelansicht
 * filtert die Medien (wartende lokale Dateien bleiben, Server-Zeilen folgen
 * der bekannten Regel), statt den ganzen Block auszuhängen. Ein Netzabriss
 * oder ein Entpinnen bei offener Lightbox lässt den gehaltenen Index sonst
 * ins Leere greifen.
 */
export function lightboxPhoto<T>(photos: T[], index: number | null): T | null {
  if (index === null) return null
  return photos[index] ?? null
}
