"use client"

/**
 * Die gepinnten Eintrags-Ids — aber nur offline gelesen.
 *
 * Online zeigt `visibleEntryMedia` ohnehin alles, dann wäre die IDB-Lesung
 * reine Arbeit. Aus der Tages-Vorschau herausgezogen, als „An diesem Tag"
 * dieselbe Regel bekam — zwei Ansichten, eine
 * Quelle.
 *
 * `null` heißt UNBEKANNT, nicht „nichts gepinnt": zwischen dem Wechsel nach
 * offline und der fertigen IDB-Lesung liegen Frames, in denen ein leeres Set
 * die Fotos jedes gepinnten Eintrags kurz ausblenden würde. Aufrufer behandeln
 * unbekannt wie gepinnt (`pinnedIds?.has(id) ?? true`) — dieselbe Konvention
 * wie `updatedAt: null` im Medien-Cache: was das Gerät nicht weiß, wird nicht
 * weggefiltert.
 */

import { useEffect, useState } from "react"
import { realIDBAdapter } from "@/lib/sync/idb"

export function useOfflinePins(
  online: boolean,
  reloadKey: unknown = 0
): ReadonlySet<string> | null {
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string> | null>(null)

  useEffect(() => {
    if (online) return
    let cancelled = false
    realIDBAdapter
      .listPins()
      .then((pins) => {
        if (!cancelled) setPinnedIds(new Set(pins.map((p) => p.entryId)))
      })
      .catch((err: unknown) => {
        // Nie verschlucken: auf dem Telefon ist die Konsole unerreichbar, und
        // ein stiller Fehlschlag sähe aus wie „nichts ist gepinnt" — die Fotos
        // jedes gepinnten Eintrags verschwänden ohne jeden Hinweis.
        console.error("[within/pins] reading the pins failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [online, reloadKey])

  return pinnedIds
}
