/**
 * Offline-Pin-Regeln (pin-rules.ts).
 *
 * Der Offline-Pin fetcht durch den Service Worker; für ungecachte
 * /media/-URLs antwortet der SW offline mit dem 200er-SVG-Platzhalter
 * (Content-Type image/svg+xml, Cache-Control no-store). Vor dem Fix wurde
 * dieser Platzhalter dauerhaft unter dem Full-res-Key in within-media-v1
 * abgelegt — cache-first bedient und vom Activate-Cleanup ausgenommen: der
 * Eintrag zeigte nach dem Reconnect für immer den Platzhalter statt des Fotos.
 *
 * Pendende Fotos (blob:-URLs) dürfen nie in die Pin-Liste — Cache
 * Storage kann keine blob:-URL halten, der Pin schlüge für den ganzen Eintrag
 * fehl.
 *
 * Synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  isCacheablePinResponse,
  localPinRecord,
  pinnablePhotoUrls,
  shouldShowEntryMedia,
  showPinToggle,
  visibleEntryMedia,
  withVisibleMedia,
} from "../src/lib/offline/pin-rules"
import type { Media } from "../src/types/journal"

function makeMedia(over: Partial<Media> = {}): Media {
  return {
    id: "m-1",
    entryId: "entry-1",
    type: "photo",
    filePath: "/media/synth/a.jpg",
    order: 0,
    ...over,
  }
}

describe("isCacheablePinResponse (umgebaut mit dem HTTP-Cache-Fix)", () => {
  // STOLPERDRAHT des Server-Fixes: Seit die Medien-Route selbst
  // `private, no-store` sendet, trägt JEDE echte Netz-Antwort no-store —
  // der alte no-store-Filter hätte den Pin-Flow komplett totgelegt (mit
  // grünen Tests). Platzhalter und SW-Cache-Antworten werden jetzt am
  // expliziten SW-Marker-Header (x-within-sw) bzw. am SVG-Content-Type
  // erkannt, nie mehr am Cache-Control.
  it("cached eine echte Foto-Antwort", () => {
    expect(
      isCacheablePinResponse({ ok: true, contentType: "image/jpeg", swServed: null })
    ).toBe(true)
  })

  it("cached die server-gehärtete no-store-Netz-Antwort — no-store ist KEIN Platzhalter-Marker mehr", () => {
    expect(
      isCacheablePinResponse({ ok: true, contentType: "image/jpeg", swServed: null })
    ).toBe(true)
  })

  it("cached den SW-Platzhalter NIE — erkannt am Marker-Header", () => {
    expect(
      isCacheablePinResponse({ ok: true, contentType: "image/svg+xml", swServed: "placeholder" })
    ).toBe(false)
  })

  it("cached den Platzhalter eines ALTEN SW ohne Marker NIE — Fallback SVG-Content-Type", () => {
    // Uploads können nie SVG sein (upload-security-Allowlist) — der
    // Content-Type bleibt als zweiter Marker für die Update-Übergangszeit.
    expect(
      isCacheablePinResponse({ ok: true, contentType: "image/svg+xml", swServed: null })
    ).toBe(false)
  })

  it("cached SW-entschlüsselte Cache-Antworten NIE erneut — B12 adoptiert stattdessen", () => {
    expect(
      isCacheablePinResponse({ ok: true, contentType: "image/jpeg", swServed: "cache-decrypt" })
    ).toBe(false)
  })

  it("cached keine Fehler-Antwort", () => {
    expect(isCacheablePinResponse({ ok: false, contentType: null, swServed: null })).toBe(false)
  })

  it("cached bei fehlenden Headern (echte Datei ohne Content-Type)", () => {
    expect(isCacheablePinResponse({ ok: true, contentType: null, swServed: null })).toBe(true)
  })
})

describe("pinnablePhotoUrls", () => {
  it("liefert die Server-Pfade der Fotos", () => {
    const urls = pinnablePhotoUrls([makeMedia(), makeMedia({ id: "m-2", filePath: "/media/synth/b.jpg" })])
    expect(urls).toEqual(["/media/synth/a.jpg", "/media/synth/b.jpg"])
  })

  it("hält pendende Fotos (blob:-URLs) aus der Pin-Liste heraus", () => {
    const urls = pinnablePhotoUrls([
      makeMedia(),
      makeMedia({ id: "pending:x", filePath: "blob:local-preview", pending: true }),
    ])
    expect(urls).toEqual(["/media/synth/a.jpg"])
  })

  it("hält Audio und Video heraus — gepinnt werden nur Fotos", () => {
    const urls = pinnablePhotoUrls([
      makeMedia(),
      makeMedia({ id: "m-3", type: "audio", filePath: "/media/synth/a.mp3" }),
      makeMedia({ id: "m-4", type: "video", filePath: "/media/synth/v.mp4" }),
    ])
    expect(urls).toEqual(["/media/synth/a.jpg"])
  })

  it("pinnt zusätzlich die Thumbnail-URL — das Detail-Grid rendert thumbnailPath (Befund 22.08.)", () => {
    // Gepinnter Eintrag offline: Grid zeigte Platzhalter, obwohl die
    // Vollauflösung im Cache lag — photo-gallery.tsx nutzt im Grid
    // `thumbnailPath || filePath`, die Lightbox `filePath`. Beide müssen
    // in den Pin.
    const urls = pinnablePhotoUrls([
      makeMedia({ thumbnailPath: "/media/synth/thumbs/a.jpg" }),
      makeMedia({ id: "m-2", filePath: "/media/synth/b.jpg" }),
    ])
    expect(urls).toEqual([
      "/media/synth/a.jpg",
      "/media/synth/thumbs/a.jpg",
      "/media/synth/b.jpg",
    ])
  })

  it("hält auch Thumbnails pendender Fotos heraus", () => {
    const urls = pinnablePhotoUrls([
      makeMedia({
        id: "pending:x",
        filePath: "blob:local-preview",
        thumbnailPath: "blob:local-thumb",
        pending: true,
      }),
    ])
    expect(urls).toEqual([])
  })
})

describe("shouldShowEntryMedia (offline nur Text für Ungepinntes)", () => {
  // Ungepinnte Einträge zeigen offline weder Foto-Kacheln noch einen
  // Hinweis — nur den Text. Das Pin-Modell ist bekannt; Platzhalter in
  // Fotogröße wirkten kaputt statt informativ (Gegentest-Befund).
  it("versteckt Medien nur offline + ungepinnt", () => {
    expect(shouldShowEntryMedia(false, false)).toBe(false)
  })

  it("zeigt Medien online (egal ob gepinnt) und offline bei gepinnten Einträgen", () => {
    expect(shouldShowEntryMedia(true, false)).toBe(true)
    expect(shouldShowEntryMedia(true, true)).toBe(true)
    expect(shouldShowEntryMedia(false, true)).toBe(true)
  })
})

describe("visibleEntryMedia (wartende lokale Dateien sind da und werden gezeigt)", () => {
  // Ein offline angehängtes Foto liegt als Blob auf dem Gerät (mediaOutbox).
  // Es zu verstecken sähe aus wie „Anhang verloren" — genau der Befund, den
  // ein früherer Fix behoben hat. Nach dem Upload ist die Zeile nicht mehr `pending`
  // und fällt wieder unter dieselbe Regel.
  const server = makeMedia({ id: "server-1" })
  const waiting = makeMedia({ id: "pending:out-1", pending: true, clientMediaId: "out-1" })

  it("zeigt offline + ungepinnt nur die wartenden Dateien, nicht die vom Server", () => {
    expect(visibleEntryMedia([server, waiting], false, false)).toEqual([waiting])
  })

  it("zeigt online alles — auch wenn nichts gepinnt ist", () => {
    expect(visibleEntryMedia([server, waiting], true, false)).toEqual([server, waiting])
  })

  it("zeigt offline + gepinnt alles", () => {
    expect(visibleEntryMedia([server, waiting], false, true)).toEqual([server, waiting])
  })

  it("bleibt leer, wenn offline + ungepinnt nichts wartet — unveränderte Regel.", () => {
    expect(visibleEntryMedia([server], false, false)).toEqual([])
    expect(visibleEntryMedia([], false, false)).toEqual([])
  })

  it("gibt bei sichtbarer Galerie die Eingabeliste zurück, ohne zu filtern", () => {
    const all = [server, waiting]
    expect(visibleEntryMedia(all, true, false)).toBe(all)
  })
})

describe("localPinRecord (Offline-Pin ohne bekannte Medien-URLs)", () => {
  // Lücke: Ein am Gerät gesetzter Pin schrieb mediaUrls stur durch. Offline
  // ohne gecachte Medien-Liste (Eintrag nie online geöffnet) hieß das
  // mediaUrls: [] OHNE Pending-Flag — der Backfill hatte nichts
  // nachzuladen, die Fotos des gepinnten Eintrags kamen NIE in den Cache.
  it("markiert einen Pin ohne bekannte URLs als mediaUrlsPending — der Backfill löst sie beim nächsten Online-Kontakt über GET /api/entries/[id] auf", () => {
    expect(localPinRecord("entry-1", [], "2026-08-23T10:00:00.000Z")).toEqual({
      entryId: "entry-1",
      pinnedAt: "2026-08-23T10:00:00.000Z",
      mediaUrls: [],
      mediaUrlsPending: true,
    })
  })

  it("übernimmt bekannte URLs ohne Pending-Flag — fehlende Cache-Einträge lädt der Missing-Scan des Backfills nach", () => {
    const rec = localPinRecord(
      "entry-1",
      ["/media/synth/a.jpg", "/media/synth/a-thumb.webp"],
      "2026-08-23T10:00:00.000Z"
    )
    expect(rec.mediaUrls).toEqual(["/media/synth/a.jpg", "/media/synth/a-thumb.webp"])
    expect(rec.mediaUrlsPending).toBeUndefined()
  })
})

describe("showPinToggle (Feldbefund c + Verbund-E2E-Fund)", () => {
  // Der Cache droppt die lokale Medien-Liste, sobald der Pin-eigene
  // updated_at-Bump gepullt wird — offline heißt eine leere photoUrls-Liste
  // dann nur „unbekannt", nicht „keine Fotos". Der Toggle muss in allen drei
  // Fällen bedienbar bleiben, in denen ein Pin Sinn ergibt oder existiert;
  // ein Offline-Pin mit unbekannter Liste ist seit localPinRecord sicher
  // (mediaUrlsPending → B13 löst online auf).
  it("sichtbar bei bekannten Foto-URLs", () => {
    expect(showPinToggle(2, false, false)).toBe(true)
  })

  it("sichtbar für gepinnte Einträge — auch ohne bekannte URLs (Unpin muss offline immer gehen)", () => {
    expect(showPinToggle(0, true, false)).toBe(true)
  })

  it("sichtbar bei unbekannter Medien-Liste (Offline-Detail ohne Cache-Hit) — Re-Pin offline möglich", () => {
    expect(showPinToggle(0, false, true)).toBe(true)
  })

  it("unsichtbar nur, wenn die Liste BEKANNT leer ist und kein Pin existiert (online text-only wie bisher)", () => {
    expect(showPinToggle(0, false, false)).toBe(false)
  })
})

describe("Quell-Kontrakt: useOfflinePin baut den lokalen Pin-Record über die Regel", () => {
  const hookSrc = readFileSync(
    join(__dirname, "../src/hooks/useOfflinePin.ts"),
    "utf8"
  )

  it("nutzt localPinRecord statt eines handgebauten putPin-Objekts", () => {
    expect(hookSrc).toContain("localPinRecord(")
  })
})

describe("Quell-Kontrakt: entry-detail gated die Medien-Blöcke über die Regel", () => {
  const src = readFileSync(
    join(__dirname, "../src/components/detail/entry-detail.tsx"),
    "utf8"
  )

  it("filtert die Medienliste über visibleEntryMedia (schließt shouldShowEntryMedia ein) mit Online-Status aus dem SyncContext", () => {
    // Die Ansicht gated nicht mehr den ganzen
    // Block, sondern filtert die Liste: wartende lokale Dateien bleiben,
    // Server-Zeilen folgen weiter derselben Regel.
    // Regex statt exakter Zeichenkette: eine Umformatierung der Argumente
    // (Prettier, eslint --fix) darf den Test nicht rot machen.
    expect(src).toMatch(/visibleEntryMedia\(\s*entry\.media\s*,\s*online\s*,\s*isPinned\s*\)/)
    expect(src).toContain("useSyncContext")
  })

  it("versteckt nicht mehr den ganzen Medien-Block hinter der Regel", () => {
    // Rot vor dem 04.09.: der Block hing komplett an shouldShowEntryMedia,
    // damit war offline auch das wartende lokale Foto unsichtbar.
    // Auch mit anderem Zeilenumbruch oder Fragment-Syntax: der Block darf nicht
    // wieder komplett hinter der Regel hängen.
    expect(src).not.toMatch(/\{\s*shouldShowEntryMedia\([^)]*\)\s*&&/)
  })

  it("lässt den Pin-Umschalter außerhalb des Gates — sonst käme man offline nicht mehr ans Entpinnen", () => {
    // Der Toggle hängt an handlePinToggle in der Toolbar, nicht in den
    // Medien-Blöcken (seit 23.08. gewrappt: meldet Pin-Änderungen nach oben,
    // damit die gefilterte Timeline live aktualisiert).
    expect(src.indexOf("onClick={handlePinToggle}")).toBeGreaterThan(-1)
  })

  it("zeigt den Umschalter über die reine Regel showPinToggle — Feldbefund (c) 23.08. + Verbund-E2E-Fund", () => {
    // Offline ohne gecachte Medien-Liste ist photoUrls leer; das alte Gate
    // photoUrls.length > 0 versteckte dann den Toggle — ein adoptierter Pin
    // (auf diesem Gerät nie online geöffnet) war offline nicht entpinnbar:
    // „am Handy ließ sich der Offline-Status offline nicht verändern".
    expect(src).toContain("showPinToggle(")
  })

  it("meldet Pin-Änderungen über onPinChanged nach oben (Filter-Timeline aktualisiert live)", () => {
    expect(src).toContain("onPinChanged")
  })
})

describe("withVisibleMedia — Regel vom 22.08. auf einer ganzen Zeile", () => {
  const uploaded: Media = { id: "m1", entryId: "e1", type: "photo", filePath: "/media/e1/m1.jpg", order: 0 }
  const waiting: Media = { id: "pending:o1", entryId: "e1", type: "photo", filePath: "blob:o1", order: 1, pending: true }

  it("lässt online alles stehen und gibt dieselbe Zeile zurück", () => {
    const entry = { id: "e1", media: [uploaded, waiting] }
    expect(withVisibleMedia(entry, true, false)).toBe(entry)
  })

  it("behält offline + gepinnt alles", () => {
    const entry = { id: "e1", media: [uploaded, waiting] }
    expect(withVisibleMedia(entry, false, true)).toBe(entry)
  })

  it("zeigt offline + ungepinnt nur die wartende Datei", () => {
    const entry = { id: "e1", media: [uploaded, waiting] }
    expect(withVisibleMedia(entry, false, false).media.map((m) => m.id)).toEqual(["pending:o1"])
  })
})
