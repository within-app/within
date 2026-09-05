/**
 * Tages-Vorschau: Klick auf eine Tages-Karte zeigt
 * rechts alle Einträge des Tages vollständig untereinander (nur Lesen), je
 * Eintrag ein „Öffnen"-Knopf zur Einzelansicht. Medien folgen der Regel vom
 * 22.08.: offline + ungepinnt → nur Text (shouldShowEntryMedia).
 *
 * 1) Loader: ein Request `date=YYYY-MM-DD&full=true`, IDB-Fallback filtert den
 *    UTC-Tag und mischt gecachte Medienlisten. 2) SSR-Probe des Inhalts.
 * Synthetisch — kein Netz, keine DB.
 */
import { describe, it, expect, afterEach } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider } from "@/components/locale-provider"
import { loadDayFull } from "@/lib/timeline/day-entries"
import { idbToDayFull } from "@/lib/sync/idb-to-views"
import { DayDetailContent, joinDayRows } from "@/components/detail/day-detail"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "@/lib/timezone"
import type { SyncEntry } from "@/lib/sync/types"
import type { FullTimelineEntry, Media, PaginatedTimeline, TimelineEntry } from "@/types/journal"

function syncEntry(id: string, createdAt: string, text: string, journalId = "j1"): SyncEntry {
  return {
    id, journalId, text, createdAt, updatedAt: createdAt, revisionId: "r" + id,
    starred: false, tags: [], locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null, deletedAt: null,
    thumbnailDataUrl: null,
  } as SyncEntry
}

function fullEntry(id: string, createdAt: string, text: string, media: Media[] = []): FullTimelineEntry {
  return {
    id, journalId: "j1", journalColor: "#007AFF", createdAt, title: text.split("\n")[0].replace(/^# /, ""),
    previewText: "", photoCount: media.length, hasAudio: false, hasVideo: false, starred: false, tags: [],
    text, media,
  }
}

describe("loadDayFull — ein Request pro Tag, IDB-Fallback", () => {
  it("fragt /api/entries mit date, full=true und journalId ab und liefert die Einträge", async () => {
    const calls: string[] = []
    const payload: PaginatedTimeline = {
      dateGroups: [{ date: "2026-09-02", formattedDate: "2026-09-02", entries: [fullEntry("a", "2026-09-02T07:05:00.000Z", "# Morgenlauf")] }],
      totalEntries: 1, currentPage: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false,
    }
    const fetchImpl = (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify(payload), { status: 200 }) }) as unknown as typeof fetch
    const data = await loadDayFull("2026-09-02", "j1", { fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("date=2026-09-02")
    expect(calls[0]).toContain("full=true")
    expect(calls[0]).toContain("journalId=j1")
    expect(data?.offline).toBe(false)
    expect(data?.entries.map((e) => e.id)).toEqual(["a"])
  })

  it("fällt bei Netzfehler auf die IDB zurück: nur der Kalendertag der App-Zone, gecachte Medien gemischt", async () => {
    const fetchImpl = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    const entries = [
      syncEntry("a", "2026-09-02T07:05:00.000Z", "# Morgenlauf"),
      syncEntry("z", "2026-09-01T23:59:00.000Z", "# Vortag"),
      syncEntry("b", "2026-09-02T18:30:00.000Z", "# Abend"),
    ]
    const media: Media = { id: "m1", entryId: "b", type: "photo", filePath: "/media/x/b.jpg", order: 0 }
    const data = await loadDayFull("2026-09-02", null, {
      fetchImpl,
      getAllEntries: async () => entries,
      readCachedMedia: async (id) => (id === "b" ? [media] : []),
    })
    expect(data?.offline).toBe(true)
    expect(data?.entries.map((e) => e.id).sort()).toEqual(["a", "b"])
    expect(data?.entries.find((e) => e.id === "b")?.media).toEqual([media])
  })

  it("liefert null, wenn Netz und IDB scheitern", async () => {
    const fetchImpl = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    const data = await loadDayFull("2026-09-02", null, { fetchImpl, getAllEntries: async () => { throw new Error("idb") } })
    expect(data).toBeNull()
  })

  it("idbToDayFull filtert Kalendertag (App-Zone) + Journal und behält den Volltext", () => {
    const rows = idbToDayFull(
      [syncEntry("a", "2026-09-02T07:05:00.000Z", "# A\n\nText A"), syncEntry("x", "2026-09-02T08:00:00.000Z", "# X", "j2")],
      "2026-09-02", "j1"
    )
    expect(rows.map((r) => r.id)).toEqual(["a"])
    expect(rows[0].text).toContain("Text A")
  })

  describe("idbToDayFull — Rechenbeispiel Zeitzone P2", () => {
    afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

    it("ein Abendeintrag in UTC−5 gehört zum Vortages-Schlüssel der App-Zone", () => {
      setAppTimeZone("Etc/GMT+5")
      // 4. September 20:00 Ortszeit → gespeichert 2026-09-05T01:00Z
      const entries = [syncEntry("a", "2026-09-05T01:00:00.000Z", "# Abend")]
      expect(idbToDayFull(entries, "2026-09-04", "j1").map((r) => r.id)).toEqual(["a"])
      expect(idbToDayFull(entries, "2026-09-05", "j1")).toEqual([])
    })

    it("in UTC bleibt derselbe Zeitpunkt unter dem nächsten Tag", () => {
      const entries = [syncEntry("a", "2026-09-05T01:00:00.000Z", "# Abend")]
      expect(idbToDayFull(entries, "2026-09-05", "j1").map((r) => r.id)).toEqual(["a"])
      expect(idbToDayFull(entries, "2026-09-04", "j1")).toEqual([])
    })
  })
})

const card = (id: string, createdAt: string, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id, journalId: "j1", journalColor: "#007AFF", createdAt, title: id, previewText: `Vorschau ${id}`,
  photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [], ...extra,
})

describe("joinDayRows — Karte ist die Wahrheit, Server liefert Volltext, IDB füllt Lücken", () => {
  const lookup = {
    text: async (id: string) => (id === "pending" ? "# pending\n\nAus der Warteschlange." : null),
    media: async () => [],
    pending: async () => [],
  }

  it("hält Reihenfolge und Menge der Karte, mischt Server-Volltext und Pending-Flag", async () => {
    const rows = await joinDayRows(
      [card("a", "2026-09-02T07:05:00.000Z"), card("pending", "2026-09-02T09:00:00.000Z", { pending: true }), card("b", "2026-09-02T18:30:00.000Z")],
      [fullEntry("b", "2026-09-02T18:30:00.000Z", "# b\n\nText b"), fullEntry("a", "2026-09-02T07:05:00.000Z", "# a\n\nText a"),
       fullEntry("gefiltert", "2026-09-02T12:00:00.000Z", "# nicht auf der Karte")],
      lookup
    )
    expect(rows.map((r) => r.id)).toEqual(["a", "pending", "b"])
    expect(rows[0].text).toContain("Text a")
    expect(rows[1].text).toContain("Aus der Warteschlange.")
    expect(rows[1].pending).toBe(true)
    expect(rows.find((r) => r.id === "gefiltert")).toBeUndefined()
  })

  it("fällt ohne Server und ohne IDB auf den Vorschautext der Karte zurück", async () => {
    const rows = await joinDayRows([card("x", "2026-09-02T07:05:00.000Z")], [], { text: async () => null, media: async () => [], pending: async () => [] })
    expect(rows[0].text).toBe("Vorschau x")
    expect(rows[0].media).toEqual([])
  })
})

describe("joinDayRows — wartende Medien", () => {
  const waiting = (id: string, entryId: string, order: number): Media => ({
    id: `pending:${id}`, entryId, type: "photo", filePath: `blob:${id}`,
    order, pending: true, clientMediaId: id,
  })

  it("mischt wartende Dateien in eine Server-Zeile, hinter die hochgeladenen", async () => {
    const uploaded: Media = {
      id: "m1", entryId: "a", type: "photo", filePath: "/media/a/m1.jpg", order: 0,
    }
    const rows = await joinDayRows(
      [card("a", "2026-09-02T07:05:00.000Z")],
      [fullEntry("a", "2026-09-02T07:05:00.000Z", "# a\n\nText a", [uploaded])],
      { text: async () => null, media: async () => [], pending: async () => [waiting("o1", "a", 1)] }
    )
    expect(rows[0].media.map((m) => m.id)).toEqual(["m1", "pending:o1"])
  })

  it("mischt wartende Dateien auch in eine Zeile, die nur aus der IDB kommt", async () => {
    // Offline neu angelegter Eintrag: der Server kennt ihn nicht, die Datei
    // liegt trotzdem auf dem Gerät.
    const rows = await joinDayRows(
      [card("neu", "2026-09-02T07:05:00.000Z", { pending: true })],
      [],
      {
        text: async () => "# neu\n\nOffline geschrieben.",
        media: async () => [],
        pending: async () => [waiting("o2", "neu", 0)],
      }
    )
    expect(rows[0].media.map((m) => m.id)).toEqual(["pending:o2"])
  })

  it("verwirft eine wartende Datei, deren Upload schon gelandet ist", async () => {
    const uploaded: Media = {
      id: "m1", entryId: "a", type: "photo", filePath: "/media/a/m1.jpg", order: 0,
      clientMediaId: "o1",
    }
    const rows = await joinDayRows(
      [card("a", "2026-09-02T07:05:00.000Z")],
      [fullEntry("a", "2026-09-02T07:05:00.000Z", "# a\n\nText a", [uploaded])],
      { text: async () => null, media: async () => [], pending: async () => [waiting("o1", "a", 1)] }
    )
    expect(rows[0].media.map((m) => m.id)).toEqual(["m1"])
  })

  it("reiht wartende Dateien hinter die schon hochgeladenen (startOrder)", async () => {
    // Ohne diese Prüfung könnte startOrder auf 0 oder card.photoCount kippen —
    // beides ließe alle anderen Tests grün und gäbe kollidierende order-Werte.
    const seen: Array<[string, number]> = []
    const uploaded: Media[] = [
      { id: "m1", entryId: "a", type: "photo", filePath: "/media/a/m1.jpg", order: 0 },
      { id: "m2", entryId: "a", type: "photo", filePath: "/media/a/m2.jpg", order: 1 },
    ]
    await joinDayRows(
      [card("a", "2026-09-02T07:05:00.000Z")],
      [fullEntry("a", "2026-09-02T07:05:00.000Z", "# a\n\nText a", uploaded)],
      {
        text: async () => null,
        media: async () => [],
        pending: async (id: string, startOrder: number) => {
          seen.push([id, startOrder])
          return []
        },
      }
    )
    expect(seen).toEqual([["a", 2]])
  })

  it("reißt die Zeile nicht mit, wenn die Wartekorb-Lesung wirft", async () => {
    const rows = await joinDayRows(
      [card("a", "2026-09-02T07:05:00.000Z")],
      [fullEntry("a", "2026-09-02T07:05:00.000Z", "# a\n\nText a")],
      {
        text: async () => null,
        media: async () => [],
        pending: async () => { throw new Error("IDB kaputt") },
      }
    )
    expect(rows[0].media).toEqual([])
  })
})

describe("DayDetailContent — alle Einträge des Tages, nur Lesen, Öffnen je Eintrag", () => {
  // Reihenfolge kommt von der Karte (aufsteigend) — der Inhalt sortiert nicht um.
  // Fester Tag in der Vergangenheit — kein „Heute/Gestern" im Kopf.
  const entries = [
    fullEntry("a", "2026-06-02T07:05:00.000Z", "# Morgenlauf\n\nFünf Kilometer."),
    fullEntry("c", "2026-06-02T18:30:00.000Z", "# Abendspaziergang\n\nDraußen.", [{ id: "m2", entryId: "c", type: "photo", filePath: "/media/x/c.jpg", thumbnailPath: "/media/x/c-thumb.webp", order: 0 }]),
  ]
  function render(online: boolean, pinned: string[] = []) {
    return renderToStaticMarkup(
      <LocaleProvider initialLocale="de">
        <DayDetailContent date="2026-06-02" entries={entries} online={online} pinnedIds={new Set(pinned)} onOpenEntry={() => {}} />
      </LocaleProvider>
    )
  }

  it("zeigt beide Einträge vollständig in Kartenreihenfolge mit einem Öffnen-Knopf je Eintrag und dem App-Zonen-Tag als Kopf", () => {
    const html = render(true)
    expect(html).toContain("Fünf Kilometer.")
    expect(html).toContain("Draußen.")
    expect(html.indexOf("Morgenlauf")).toBeLessThan(html.indexOf("Abendspaziergang"))
    expect((html.match(/>Öffnen</g) ?? []).length).toBe(2)
    expect(html).toContain("2 Einträge")
    expect(html).toContain("2. Juni 2026")
    // Nur Lesen: keine Aktions-Knöpfe der Einzelansicht
    expect(html).not.toContain("Eintrag bearbeiten")
    expect(html).not.toContain("Eintrag löschen")
  })

  it("online zeigt Fotos; offline + ungepinnt nur Text (Regel 22.08.); offline + gepinnt zeigt Fotos", () => {
    expect(render(true)).toContain("/media/x/c-thumb.webp")
    expect(render(false)).not.toContain("/media/x/c-thumb.webp")
    expect(render(false, ["c"])).toContain("/media/x/c-thumb.webp")
  })

  it("zeigt eine wartende Datei auch offline und ungepinnt", () => {
    // Gleiche Ausnahme wie in der Einzelansicht: die Datei liegt auf
    // dem Gerät. Sie zu verstecken sähe aus wie „der Anhang ist verloren".
    const withWaiting = [
      fullEntry("d", "2026-06-02T20:00:00.000Z", "# Abend\n\nText.", [
        { id: "m3", entryId: "d", type: "photo", filePath: "/media/x/d.jpg", thumbnailPath: "/media/x/d-thumb.webp", order: 0 },
        { id: "pending:o1", entryId: "d", type: "photo", filePath: "blob:o1", order: 1, pending: true, clientMediaId: "o1" },
      ]),
    ]
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="de">
        <DayDetailContent date="2026-06-02" entries={withWaiting} online={false} pinnedIds={new Set()} onOpenEntry={() => {}} />
      </LocaleProvider>
    )
    expect(html).toContain("blob:o1")
    expect(html).toContain("Wartet")
    // Die hochgeladene Datei bleibt der Regel vom 22.08. unterworfen.
    expect(html).not.toContain("/media/x/d-thumb.webp")
  })
})
