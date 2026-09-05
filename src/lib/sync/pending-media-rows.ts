/**
 * Pure orchestration for turning outbox records into
 * renderable `Media` rows.
 *
 * Split from pending-media-preview.ts so the decision logic (ordering, which
 * item gets a downscaled preview, URL bookkeeping) runs in the node test
 * environment: the browser half injects `URL.createObjectURL` /
 * `createImageBitmap` through the factory, tests inject fakes.
 *
 * Why thumbnails at all: a pending photo has no server-side thumbnail,
 * so the detail grid (220px tiles) and the timeline cards (84px) would decode
 * the full-resolution blob — 20 offline photos à 12 MP ≈ up to ~1 GB of decoded
 * RGBA at once, an OOM/tab-kill risk on the phone. The factory produces a
 * downscaled preview blob URL instead; the full-res URL stays reserved for the
 * lightbox.
 */

import type { Media } from "@/types/journal"
import type { OutboxMedia } from "@/lib/sync/media-outbox"
import { groupPendingByEntry, toPendingMedia } from "@/lib/sync/pending-media"
import { chainSequential, type RunChainRef } from "@/lib/sync/run-chain"

/**
 * Eine Dekodier-Kette für das ganze Gerät, nicht eine pro Lader.
 *
 * Tages-Vorschau und „An diesem Tag" können gleichzeitig gemountet sein
 * (die Lese-Ansicht liegt als Overlay über der Seite). Mit je eigener Kette
 * liefen wieder zwei Vollbild-Dekodierungen nebeneinander — genau das, was die
 * Kette verhindern soll. Der Preis ist gewollt: ein Dekodierlauf zur Zeit.
 */
const decodeChain: RunChainRef = { current: Promise.resolve() }

/** Browser capabilities, injected. Both return "" when refused/unsupported. */
export interface PendingPreviewFactory {
  createUrl(blob: Blob): string
  /** Downscaled preview of a photo blob. "" = unsupported → callers fall back
   *  to the full-res URL (today's behavior, e.g. very old Safari). */
  createThumbUrl(blob: Blob): Promise<string>
}

/**
 * Outbox reads come back in key order, and the key is a random UUID —
 * lexicographic shuffle. Attach order is what the user saw when picking.
 * Tie-break by id so the order is stable for same-millisecond attachments.
 */
export function sortByQueuedAt(items: OutboxMedia[]): OutboxMedia[] {
  return [...items].sort(
    (a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id)
  )
}

/**
 * All pending rows for one entry, in attach order, with every created object
 * URL recorded in `urlSink` (the caller owns and revokes them).
 *
 * Thumbnails are created sequentially on purpose: each one briefly decodes the
 * full-res photo, and doing that for 20 photos in parallel is exactly the
 * memory spike downscaling exists to prevent.
 */
export async function buildPendingMediaRows(
  items: OutboxMedia[],
  startOrder: number,
  urlSink: string[],
  factory: PendingPreviewFactory
): Promise<Media[]> {
  const rows: Media[] = []
  for (const [i, item] of sortByQueuedAt(items).entries()) {
    const url = factory.createUrl(item.blob)
    if (url) urlSink.push(url)

    let thumbUrl = ""
    if (item.type === "photo" && url) {
      thumbUrl = await factory.createThumbUrl(item.blob)
      if (thumbUrl) urlSink.push(thumbUrl)
    }

    const row = toPendingMedia(item, url, startOrder + i)
    rows.push(thumbUrl ? { ...row, thumbnailPath: thumbUrl } : row)
  }
  return rows
}

/**
 * Wartekorb-Lader für die Tages-Vorschau.
 *
 * Sie fragt für JEDEN Eintrag eines Tages nach wartenden Dateien, und zwar
 * gleichzeitig (Promise.all über die Zeilen). Naiv gebaut hieße das eine
 * Wartekorb-Lesung und einen Dekodierlauf pro Eintrag, alle nebeneinander —
 * genau die Parallelität, gegen die zwei bestehende Entscheidungen stehen:
 * Der Korb wird per Cursor gelesen, damit nicht-passende Blobs sofort wieder
 * freigegeben werden, und Thumbnails werden bewusst nacheinander dekodiert,
 * weil vier gleichzeitige Vollbild-Dekodierungen auf dem Telefon der Tab-Tod sind.
 *
 * Deshalb: EINE Lesung für den ganzen Tag, danach `groupPendingByEntry`, und
 * die Zeilenbau-Läufe über eine Kette. Beide Fähigkeiten sind injiziert, damit
 * das hier im Node-Test läuft — die Browser-Hälfte sitzt in
 * pending-media-preview.ts.
 */
export function makeDayPendingLoader(
  readOutbox: () => Promise<OutboxMedia[]>,
  build: (items: OutboxMedia[], startOrder: number) => Promise<Media[]>
): (entryId: string, startOrder: number) => Promise<Media[]> {
  // Lazy und genau einmal: der erste fragende Eintrag löst die Lesung aus, alle
  // weiteren warten auf dasselbe Versprechen.
  let outbox: Promise<Map<string, OutboxMedia[]>> | null = null

  return async (entryId, startOrder) => {
    outbox ??= readOutbox().then(groupPendingByEntry)
    // Ein kaputter Korb kostet die wartenden Dateien, nicht den Tag.
    const bucket = await outbox.then((byEntry) => byEntry.get(entryId) ?? []).catch(() => [])
    if (bucket.length === 0) return []
    return chainSequential(decodeChain, () => build(bucket, startOrder))
  }
}
