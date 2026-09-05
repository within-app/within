/**
 * Foto-Verlust bei
 * HTTP-Fehler-Response.
 *
 * Befund: Der Online-Upload-Pfad in photo-uploader.tsx verwarf bei JEDER
 * nicht-ok-Response (400 wie 503) das File-Objekt — nur der Fehlertext blieb
 * auf der Kachel. Eine Kamera-Aufnahme (CameraResultType.DataUrl, keine
 * Galerie-Kopie) existiert nur in diesem File: ein transienter 503 oder ein
 * 400 löschte die Aufnahme unwiederbringlich. Netz-Abbrüche (fetch throw) und
 * Offline gingen dagegen längst in die IDB-Outbox.
 *
 * Fix-Vertrag: Auch der HTTP-Fehler-Zweig reiht in die Outbox ein
 * (queueOffline, gleicher clientMediaId = Idempotenz-Schlüssel).
 * Retry-Semantik liefert die Outbox: 5xx/429 = bounded retry
 * (classifyUploadResponse "retry"), permanenter 4xx = markRejected — Datei
 * bleibt in IDB sichtbar/erhalten statt verworfen.
 *
 * Source-Contract-Test im Stil von tests/pin-rules.test.ts (die Komponente
 * ist "use client" + DOM — der Node-Harness fixiert hier den Quelltext-Pfad;
 * die Outbox-Verhaltenssemantik ist in tests/media-outbox.test.ts bewiesen).
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"

const src = readFileSync(
  resolve(__dirname, "../src/components/editor/photo-uploader.tsx"),
  "utf8"
)

describe("photo-uploader: HTTP-Fehler-Response verliert nie das File (Punkt 4)", () => {
  // Der komplette try-Block des Online-Uploads
  const notOkBlock = /if \(!res\.ok\) \{[\s\S]*?\n {6}\}/.exec(src)?.[0]

  it("der !res.ok-Zweig existiert und reiht das File in die Offline-Outbox ein", () => {
    expect(notOkBlock).toBeTruthy()
    expect(notOkBlock).toContain("queueOffline(file")
  })

  it("der !res.ok-Zweig verwirft das File nicht mehr (kein reiner error-Text-Drop)", () => {
    // Alte Implementierung: setPhotos(… error: errorText …) + return — das
    // File-Objekt ging verloren. Fehltext-Anzeige übernimmt jetzt die
    // Outbox-Kachel (isStuck/lastError).
    expect(notOkBlock).not.toMatch(/setPhotos\([\s\S]*error:\s*errorText/)
  })

  it("der Netz-Abbruch-Pfad (catch) bleibt unverändert auf der Outbox", () => {
    const catchBlock = /catch \{[\s\S]*?queueOffline\(file, tempId, mediaType, clientMediaId\)/.exec(src)
    expect(catchBlock).toBeTruthy()
  })
})
