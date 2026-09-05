/**
 * Offline-Medien-Outbox: Auswahl-, Budget- und Antwortlogik.
 *
 * Rote Ausgangslage: Offline erzeugte das Auswählen eines Fotos in
 * `photo-uploader.tsx` sofort ein `fetch("/api/upload")` und damit die Meldung
 * "Netzwerkfehler" — die Datei war weg. Diese Tests decken die reine Logik ab,
 * die den Wartekorb steuert.
 *
 * Nur synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import {
  MAX_UPLOAD_ATTEMPTS,
  OUTBOX_BUDGET_BYTES,
  budgetRejection,
  classifyUploadResponse,
  isStuck,
  markAttempt,
  markRejected,
  outboxBytes,
  selectFlushable,
  type OutboxMedia,
} from "../src/lib/sync/media-outbox"

const ENTRY_A = "20000000-0000-4000-8000-00000000000a"
const ENTRY_B = "20000000-0000-4000-8000-00000000000b"

function makeItem(over: Partial<OutboxMedia> = {}): OutboxMedia {
  return {
    id: "media-1",
    entryId: ENTRY_A,
    blob: new Blob(["synthetic"], { type: "image/jpeg" }),
    fileName: "synthetic.jpg",
    mimeType: "image/jpeg",
    type: "photo",
    size: 1024,
    queuedAt: "2026-07-27T10:00:00.000Z",
    attempts: 0,
    ...over,
  }
}

// ── Budget ────────────────────────────────────────────────────────────────────

describe("budgetRejection", () => {
  it("lässt eine Datei durch, solange das Budget reicht", () => {
    const items = [makeItem({ size: 5 * 1024 * 1024 })]
    expect(budgetRejection(items, 5 * 1024 * 1024)).toBeNull()
  })

  it("verweigert laut, statt still zu verwerfen", () => {
    const items = [makeItem({ size: OUTBOX_BUDGET_BYTES })]
    const message = budgetRejection(items, 1)
    expect(message).toBeTruthy()
    expect(message).toContain("Offline-Speicher voll")
    // Die Meldung muss die Ursache benennen — auf dem Handy ist die Konsole unerreichbar.
    expect(message).toContain("nicht angehängt")
  })

  it("rechnet die Summe aller wartenden Dateien, nicht nur die größte", () => {
    const items = [makeItem({ size: 60 }), makeItem({ id: "m2", size: 30 })]
    expect(outboxBytes(items)).toBe(90)
    expect(budgetRejection(items, 20, 100)).toBeTruthy()
    expect(budgetRejection(items, 10, 100)).toBeNull()
  })
})

// ── Auswahl ───────────────────────────────────────────────────────────────────

describe("selectFlushable", () => {
  it("überspringt Medien, deren Eintrag noch in der Edit-Queue liegt", () => {
    // Kern der Reihenfolge: /api/upload?entryId= schreibt nur dann eine media-Zeile,
    // wenn der Eintrag serverseitig schon existiert. Vorher hochladen erzeugt eine
    // Datei ohne Verknüpfung.
    const items = [makeItem({ id: "m1", entryId: ENTRY_A }), makeItem({ id: "m2", entryId: ENTRY_B })]
    const result = selectFlushable(items, new Set([ENTRY_A]))
    expect(result.map((i) => i.id)).toEqual(["m2"])
  })

  it("lädt nichts mehr hoch, was die Versuchsgrenze erreicht hat", () => {
    const items = [
      makeItem({ id: "m1", attempts: MAX_UPLOAD_ATTEMPTS }),
      makeItem({ id: "m2", attempts: MAX_UPLOAD_ATTEMPTS - 1 }),
    ]
    expect(selectFlushable(items, new Set()).map((i) => i.id)).toEqual(["m2"])
  })

  it("gibt alles frei, wenn keine Einträge mehr warten", () => {
    const items = [makeItem({ id: "m1" }), makeItem({ id: "m2", entryId: ENTRY_B })]
    expect(selectFlushable(items, new Set())).toHaveLength(2)
  })

  it("lädt in Anhäng-Reihenfolge hoch, nicht in UUID-Key-Reihenfolge", () => {
    // Der Outbox-Store liefert Key-Reihenfolge, Keys sind Zufalls-UUIDs. Ohne
    // Sortierung weicht die finale order_index-Reihenfolge auf dem Server von
    // der offline gezeigten ab.
    const items = [
      makeItem({ id: "zzz", queuedAt: "2026-07-27T10:00:02.000Z" }),
      makeItem({ id: "aaa", queuedAt: "2026-07-27T10:00:01.000Z" }),
    ]
    expect(selectFlushable(items, new Set()).map((i) => i.id)).toEqual(["aaa", "zzz"])
  })
})

// ── Antwort-Interpretation ────────────────────────────────────────────────────

describe("classifyUploadResponse", () => {
  it("wertet 201 mit media-id als angehängt", () => {
    expect(classifyUploadResponse({ ok: true, status: 201, body: { id: "media-uuid" } }))
      .toBe("attached")
  })

  it("wertet 201 OHNE media-id als Wiederholung, nicht als Erfolg", () => {
    // Genau der Fall "Eintrag serverseitig noch nicht da": /api/upload fängt den
    // DB-Fehler ab und antwortet trotzdem 201 — ohne id. Als Erfolg gebucht wäre
    // das Foto für immer unsichtbar.
    expect(classifyUploadResponse({ ok: true, status: 201, body: {} })).toBe("retry")
    expect(classifyUploadResponse({ ok: true, status: 201, body: null })).toBe("retry")
  })

  it("behandelt Netzwerkabbruch und 5xx als wiederholbar", () => {
    expect(classifyUploadResponse({ ok: false, status: 0, body: null })).toBe("retry")
    expect(classifyUploadResponse({ ok: false, status: 503, body: null })).toBe("retry")
  })

  it("behandelt 4xx als endgültige Ablehnung", () => {
    expect(classifyUploadResponse({ ok: false, status: 400, body: null })).toBe("rejected")
    expect(classifyUploadResponse({ ok: false, status: 413, body: null })).toBe("rejected")
  })

  it("behandelt 409 (Eintrag noch nicht gepusht) als wiederholbar", () => {
    // Der Server lehnt jetzt VOR dem Platten-Schreiben ab; semantisch ist das
    // dasselbe wie das alte 201-ohne-id und darf die Datei nicht festnageln.
    expect(classifyUploadResponse({ ok: false, status: 409, body: null })).toBe("retry")
  })

  it("wertet 410 (Eintrag gelöscht) als verwaist, nicht als abgelehnt", () => {
    // Ein gelöschter Eintrag bekommt nie wieder eine media-Zeile: das Item soll
    // aus der Outbox verschwinden statt ewig als „stuck" gemeldet zu werden.
    expect(classifyUploadResponse({ ok: false, status: 410, body: null })).toBe("orphaned")
  })
})

// ── Zustandsübergänge ─────────────────────────────────────────────────────────

describe("markAttempt / markRejected", () => {
  it("zählt Versuche hoch und hält die Ursache fest", () => {
    const next = markAttempt(makeItem(), "Netzwerkfehler (TypeError)")
    expect(next.attempts).toBe(1)
    expect(next.lastError).toBe("Netzwerkfehler (TypeError)")
    expect(isStuck(next)).toBe(false)
  })

  it("stoppt eine abgelehnte Datei sofort, behält sie aber im Korb", () => {
    const next = markRejected(makeItem(), "Dateiformat nicht erlaubt")
    expect(isStuck(next)).toBe(true)
    expect(next.lastError).toBe("Dateiformat nicht erlaubt")
    // Nicht gelöscht: eine stumm verschwundene Datei ist schlimmer als eine sichtbar rote.
    expect(next.blob).toBeInstanceOf(Blob)
  })
})
