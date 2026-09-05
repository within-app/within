/**
 * Offline-Fallback des Medien-Grids (Option
 * „Gepinnte + Thumbnails" — null zusätzlicher Speicher):
 *
 * - Pro Eintrag EINE Foto-Kachel aus dem Timeline-Thumbnail (`thumbnailDataUrl`,
 *   data:-URL — liegt für alle gesyncten Einträge bereits in der IDB).
 * - Gepinnte Einträge mit BEKANNTER Medien-Liste (entryMedia-Cache) zeigen
 *   stattdessen ihre echten Foto-Kacheln — die Bytes liefert offline der SW
 *   aus dem verschlüsselten Pin-Cache. Keine Dublette mit der Thumbnail-Kachel.
 * - Video/Audio bleiben offline draußen: Pins pinnen nur Fotos, es gäbe keine
 *   abspielbaren Bytes.
 *
 * Ehrliche Grenze: Das Timeline-Thumbnail ist eins
 * PRO EINTRAG — ein ungepinnter Eintrag mit fünf Fotos zeigt offline eine
 * Kachel. Der Upgrade-Pfad (alle Foto-Vorschauen zusätzlich syncen) wäre eine
 * Architekturänderung mit Speicherwachstum und ist bewusst nicht gebaut.
 */

import type { SyncEntry } from "@/lib/sync/types"
import type { Media, MediaItem } from "@/types/journal"
import type { PreviewRegistryItem } from "@/lib/offline/preview-mirror"

/**
 * Zeitraum-Spiegel-Sicht: Der Zeitraum REGELT
 * die offline sichtbare Menge — Fotos der Spiegel-Registry rendern als
 * echte Kacheln (Bytes liefert der SW aus dem verschlüsselten Cache),
 * ungepinnte Einträge außerhalb bekommen KEINE Kachel. `since` null =
 * „Alles"; `pinnedEntryIds` deckt Pins mit UNBEKANNTER Medien-Liste ab
 * (unbekannt ≠ leer — die zeigen weiter ihre Thumbnail-Kachel).
 */
export interface MirrorView {
  since: string | null
  items: PreviewRegistryItem[]
  pinnedEntryIds?: ReadonlySet<string>
}

export function idbToMediaItems(
  entries: SyncEntry[],
  pinnedMedia: ReadonlyMap<string, Media[]>,
  journalId?: string | null,
  mirror?: MirrorView | null
): MediaItem[] {
  const items: MediaItem[] = []

  const mirrorByEntry = new Map<string, PreviewRegistryItem[]>()
  if (mirror) {
    for (const item of mirror.items) {
      const list = mirrorByEntry.get(item.entryId)
      if (list) list.push(item)
      else mirrorByEntry.set(item.entryId, [item])
    }
  }

  for (const entry of entries) {
    if (entry.deletedAt) continue
    if (journalId && entry.journalId !== journalId) continue

    const cachedRows = pinnedMedia.get(entry.id)?.filter((m) => m.type === "photo") ?? []
    if (cachedRows.length > 0) {
      for (const m of cachedRows) {
        items.push({
          id: m.id,
          entryId: entry.id,
          type: "photo",
          filePath: m.filePath,
          thumbnailPath: m.thumbnailPath,
          // Der Pin-Cache ist offline die EINZIGE Quelle, die den
          // Upload-Schlüssel kennt — ohne ihn kann unmergedPending eine
          // wartende Kachel nicht gegen ihre schon hochgeladene Server-Zeile
          // abgleichen. Spiegel- und Thumbnail-Kacheln unten kennen ihn nicht;
          // dort bleibt die Dublette vorerst eine offene Grenze.
          clientMediaId: m.clientMediaId,
          createdAt: entry.createdAt,
          journalColor: "",
        })
      }
      continue
    }

    // Spiegel-Kacheln: eine PRO FOTO, Thumb-URL auch als filePath — offline
    // existiert nur die Vorschau; Klick öffnet ohnehin den Eintrag.
    const mirrorRows = mirror ? mirrorByEntry.get(entry.id) ?? [] : []
    if (mirrorRows.length > 0) {
      for (const m of mirrorRows) {
        items.push({
          id: m.mediaId,
          entryId: entry.id,
          type: "photo",
          filePath: m.thumbUrl,
          thumbnailPath: m.thumbUrl,
          createdAt: entry.createdAt,
          journalColor: "",
        })
      }
      continue
    }

    // Ohne Spiegel: heutiges Verhalten (Thumbnail-Kachel pro Eintrag).
    // Mit Spiegel: Fallback-Kachel nur im Zeitraum (z.B. offline erstellte
    // Einträge, die der Server noch nicht kennt) oder für Pins (die zeigen
    // weiter alles, auch außerhalb des Zeitraums).
    const inPeriod = !mirror || mirror.since === null || entry.createdAt >= mirror.since
    const isPinned = mirror?.pinnedEntryIds?.has(entry.id) ?? false
    if ((inPeriod || isPinned) && entry.thumbnailDataUrl) {
      items.push({
        id: `idb-thumb-${entry.id}`,
        entryId: entry.id,
        type: "photo",
        filePath: entry.thumbnailDataUrl,
        thumbnailPath: entry.thumbnailDataUrl,
        createdAt: entry.createdAt,
        journalColor: "",
      })
    }
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}
