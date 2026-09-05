/**
 * Medien-Waisen und Import-Temp:
 *
 * Der Import legte sein Temp unter public/media-tmp-<uuid> ab — das ist
 * der Container-Overlay-Layer, NICHT das Volume: der "same-filesystem rename"
 * war in Prod ein EXDEV-copy+delete (doppelter Platzbedarf), und nach einem
 * OOM-Kill (der dokumentierte Pi-Failure-Mode) blieben bis zu ~200 MB Extrakt
 * liegen — jeder Retry addierte ein weiteres Verzeichnis.
 *
 * Außerdem gab es keinerlei Aufräum-Mechanismus für Medien-Waisen: Draft-Uploads
 * ohne entryId (201 ohne DB-Row, Discard = Datei für immer), Fail-Pfade
 * (Disk-Write wirft nach mkdir), Post-Commit-unlink-Fehler, leere UUID-Dirs
 * nach Media-Delete. Der Sweep löscht nur UUID-Verzeichnisse, die älter als
 * 24 h sind und von keiner media-Row referenziert werden.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { selectStaleTmpDirs, selectOrphanMediaDirs, MEDIA_SWEEP_MIN_AGE_MS } from "@/lib/media-sweep"

const NOW = Date.parse("2026-08-22T12:00:00.000Z")
const OLD = NOW - 25 * 60 * 60 * 1000 // 25 h alt
const FRESH = NOW - 60 * 60 * 1000 // 1 h alt

describe("selectStaleTmpDirs (B31)", () => {
  it("wählt alte Temp-Verzeichnisse (.tmp-* im Volume, media-tmp-* Legacy), nie frische", () => {
    const dirs = [
      { name: ".tmp-11111111-1111-4111-8111-111111111111", mtimeMs: OLD },
      { name: ".tmp-22222222-2222-4222-8222-222222222222", mtimeMs: FRESH },
      { name: "media-tmp-33333333-3333-4333-8333-333333333333", mtimeMs: OLD },
      { name: "44444444-4444-4444-8444-444444444444", mtimeMs: OLD }, // echtes Medien-Dir
    ]
    expect(selectStaleTmpDirs(dirs, NOW)).toEqual([
      ".tmp-11111111-1111-4111-8111-111111111111",
      "media-tmp-33333333-3333-4333-8333-333333333333",
    ])
  })
})

describe("selectOrphanMediaDirs (B32)", () => {
  const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

  it("wählt nur unreferenzierte UUID-Dirs, die älter als die Mindest-Karenz sind", () => {
    const dirs = [
      { name: UUID_A, mtimeMs: OLD }, // referenziert → bleibt
      { name: UUID_B, mtimeMs: OLD }, // Waise, alt → weg
      { name: UUID_C, mtimeMs: FRESH }, // Waise, aber frisch (In-flight-Draft) → bleibt
      { name: ".tmp-x", mtimeMs: OLD }, // kein UUID-Dir → nicht unser Job hier
      { name: "notes.txt", mtimeMs: OLD }, // keine UUID → bleibt
    ]
    const referenced = new Set([`media/${UUID_A}/photo.jpg`])
    expect(selectOrphanMediaDirs(dirs, referenced, NOW)).toEqual([UUID_B])
  })

  it("Referenzen zählen über alle Pfadspalten (file/thumbnail/preview)", () => {
    const dirs = [{ name: UUID_A, mtimeMs: OLD }]
    const referenced = new Set([`media/${UUID_A}/thumb.webp`])
    expect(selectOrphanMediaDirs(dirs, referenced, NOW)).toEqual([])
  })

  it("INCIDENT 22.08.: DB-Pfade tragen einen führenden Slash — /media/<uuid>/… MUSS als Referenz zählen", () => {
    // Das reale file_path-Format ist "/media/<uuid>/<datei>" (Upload-Route).
    // Der erste Sweep-Release parste ohne Normalisierung, erkannte NULL
    // Referenzen und löschte alle 79 Medien-Ordner auf dem Pi.
    const dirs = [{ name: UUID_A, mtimeMs: OLD }, { name: UUID_B, mtimeMs: OLD }]
    const referenced = new Set([`/media/${UUID_A}/${UUID_A}-original.jpg`])
    expect(selectOrphanMediaDirs(dirs, referenced, NOW)).toEqual([UUID_B])
  })

  it("Fail-safe: erkennt der Parser KEINE Referenz, obwohl Referenz-Pfade existieren, wird NICHTS gelöscht", () => {
    const dirs = [{ name: UUID_A, mtimeMs: OLD }]
    // Unerwartetes Pfadformat (z.B. absoluter FS-Pfad) → Parser findet nichts
    // → lieber gar nicht aufräumen als falsch löschen.
    const referenced = new Set([`C:\\weird\\${UUID_A}\\x.jpg`])
    expect(selectOrphanMediaDirs(dirs, referenced, NOW)).toEqual([])
  })

  it("Karenzzeit ist mindestens 24 h (In-flight-Drafts dürfen nie sterben)", () => {
    expect(MEDIA_SWEEP_MIN_AGE_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})

describe("Import nutzt das Volume für Temp (B31)", () => {
  it("tmpDir liegt unter public/media/.tmp-* (Volume, same-fs rename, sweep-bar)", () => {
    const src = readFileSync(resolve(__dirname, "../src/app/api/import/route.ts"), "utf8")
    expect(src).toContain('"public", "media", ".tmp-"')
    expect(src).not.toContain('"media-tmp-"')
  })

  it("instrumentation verdrahtet den Sweep (Startup + Intervall)", () => {
    const src = readFileSync(resolve(__dirname, "../src/instrumentation.ts"), "utf8")
    expect(src).toContain("sweepMediaOrphans")
    expect(src).toContain("setInterval")
  })
})
