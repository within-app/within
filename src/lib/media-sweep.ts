/**
 * Aufräumen des Medien-Verzeichnisses.
 *
 * Es gab keinen einzigen Pfad, der Medien-Waisen je freigab:
 *  - Draft-Uploads ohne entryId (201 ohne DB-Row; Discard = Datei für immer)
 *  - Fehlerpfade im Upload (Dir angelegt, Write scheiterte)
 *  - Post-Commit-unlink-Fehler beim Löschen (Row weg, Datei blieb)
 *  - leere UUID-Dirs nach Media-Delete (rmdir fehlte)
 *  - Import-Temp nach OOM-Kill (finally läuft bei Prozess-Tod nicht)
 *
 * Der Sweep läuft beim Server-Start und danach täglich (instrumentation.ts):
 * er löscht UUID-Verzeichnisse unter public/media/, die älter als 24 h sind
 * und von keiner media-Row (file/thumbnail/preview) referenziert werden, plus
 * alte Temp-Verzeichnisse (.tmp-* im Volume, media-tmp-* Legacy im Overlay).
 * Die 24-h-Karenz schützt In-flight-Drafts — deren Dateien existieren, bevor
 * die media-Row beim Speichern entsteht.
 */

import { readdir, rm, stat } from "fs/promises"
import { join } from "path"
import { logError } from "@/lib/logger"

/** Karenzzeit: nie etwas anfassen, das jünger als 24 h ist. */
export const MEDIA_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TMP_DIR = /^(\.tmp-|media-tmp-)/

export interface SweepDirEntry {
  name: string
  mtimeMs: number
}

/** Alte Import-Temp-Verzeichnisse (Crash-Leichen). Reine Funktion. */
export function selectStaleTmpDirs(dirs: SweepDirEntry[], nowMs: number): string[] {
  return dirs
    .filter((d) => TMP_DIR.test(d.name) && nowMs - d.mtimeMs >= MEDIA_SWEEP_MIN_AGE_MS)
    .map((d) => d.name)
}

/** Unreferenzierte UUID-Verzeichnisse älter als die Karenz. Reine Funktion.
 *  `referencedPaths` sind die media-Pfade aus der DB (z.B. "media/<uuid>/x.jpg"
 *  aus file_path/thumbnail_path/preview_path) — referenziert ist ein Dir, wenn
 *  irgendein Pfad es als zweites Segment trägt. */
export function selectOrphanMediaDirs(
  dirs: SweepDirEntry[],
  referencedPaths: Set<string>,
  nowMs: number
): string[] {
  const referencedDirs = new Set<string>()
  for (const p of referencedPaths) {
    // INCIDENT: file_path steht als "/media/<uuid>/…" MIT führendem
    // Slash in der DB — der erste Release parste ohne Normalisierung, erkannte
    // null Referenzen und löschte alle Medien-Ordner. Führende Slashes
    // entfernen, bevor segmentiert wird.
    const segments = p.replace(/^\/+/, "").split("/")
    if (segments[0] === "media" && segments[1]) referencedDirs.add(segments[1].toLowerCase())
  }
  // Fail-safe: Es gibt Referenz-Pfade, aber der Parser hat KEINEN einzigen
  // erkannt → das Pfadformat ist nicht das erwartete. Dann ist Nicht-Aufräumen
  // der einzig sichere Ausgang — niemals auf Basis eines leeren Referenz-Sets
  // löschen, solange die DB Medien kennt.
  if (referencedPaths.size > 0 && referencedDirs.size === 0) return []
  return dirs
    .filter(
      (d) =>
        UUID_DIR.test(d.name) &&
        !referencedDirs.has(d.name.toLowerCase()) &&
        nowMs - d.mtimeMs >= MEDIA_SWEEP_MIN_AGE_MS
    )
    .map((d) => d.name)
}

/** FS+DB-Verdrahtung. Best effort — ein Sweep-Fehler darf den Serverbetrieb
 *  nie beeinträchtigen. Server-only (fs). */
export async function sweepMediaOrphans(): Promise<{ removedTmp: number; removedOrphans: number }> {
  const result = { removedTmp: 0, removedOrphans: 0 }
  try {
    const { db } = await import("@/lib/db")
    const cwd = process.cwd()
    const mediaRoot = join(cwd, "public", "media")
    const now = Date.now()

    const readDirEntries = async (root: string): Promise<SweepDirEntry[]> => {
      const entries: SweepDirEntry[] = []
      for (const name of await readdir(root).catch(() => [] as string[])) {
        try {
          const s = await stat(join(root, name))
          if (s.isDirectory()) entries.push({ name, mtimeMs: s.mtimeMs })
        } catch {
          // Verzeichnis parallel verschwunden — egal.
        }
      }
      return entries
    }

    // 1. Temp-Leichen: .tmp-* im Volume und media-tmp-* Legacy unter public/.
    const volumeDirs = await readDirEntries(mediaRoot)
    const overlayDirs = await readDirEntries(join(cwd, "public"))
    for (const name of [
      ...selectStaleTmpDirs(volumeDirs, now).map((n) => join(mediaRoot, n)),
      ...selectStaleTmpDirs(overlayDirs, now).map((n) => join(cwd, "public", n)),
    ]) {
      await rm(name, { recursive: true, force: true })
      result.removedTmp++
    }

    // 2. Waisen: UUID-Dirs ohne media-Row, älter als 24 h.
    const { rows } = await db.query<{
      file_path: string
      thumbnail_path: string | null
      preview_path: string | null
    }>(`SELECT file_path, thumbnail_path, preview_path FROM media`)
    const referenced = new Set<string>()
    for (const row of rows) {
      for (const p of [row.file_path, row.thumbnail_path, row.preview_path]) {
        if (p) referenced.add(p)
      }
    }
    for (const name of selectOrphanMediaDirs(volumeDirs, referenced, now)) {
      await rm(join(mediaRoot, name), { recursive: true, force: true })
      result.removedOrphans++
    }

    if (result.removedTmp > 0 || result.removedOrphans > 0) {
      console.log(
        `[within/media-sweep] removed ${result.removedTmp} tmp dir(s), ${result.removedOrphans} orphan dir(s)`
      )
    }
  } catch (err) {
    logError("[within/media-sweep] sweep failed:", err)
  }
  return result
}
