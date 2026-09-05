/**
 * Streaming ZIP decompressor for the import route.
 *
 * Root-level JSON files are buffered in RAM (they're small metadata).
 * All other entries (photos, videos) are written chunk-by-chunk to disk via
 * a WriteStream, so at most one file's in-flight chunks occupy RAM at any
 * moment — preventing Pi 4 OOM on imports with large media payloads.
 */

import { mkdirSync, createWriteStream, type WriteStream } from "fs"
import { join, dirname } from "path"
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate"
import type { UnzipFile } from "fflate"

export class ImportZipError extends Error {
  constructor(
    message: string,
    public readonly kind: "too_large" | "security" | "format",
  ) {
    super(message)
    this.name = "ImportZipError"
  }
}

const MAX_IMPORT_COMPRESSED   = 100 * 1024 * 1024
const MAX_IMPORT_UNCOMPRESSED = 200 * 1024 * 1024
const MAX_IMPORT_FILES        = 10_000
const MAX_SINGLE_FILE_BYTES   = 100 * 1024 * 1024

// Sanitize a zip entry name for safe use as a relative path under tmpDir.
// Only alphanumeric, dots, hyphens, underscores, and slashes (already checked
// for ".." and absolute paths before this is called).
function safeTmpName(zipName: string): string {
  return zipName
    .split("/")
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .join("/")
}

/**
 * Stream-decompress a ZIP ReadableStream to a temp directory.
 *
 * - Root-level `.json` files → buffered in `jsonData` (they're small)
 * - Everything else → written chunk-by-chunk to `tmpDir` via a WriteStream
 *
 * Returns the root JSON content and a map from zip-entry-name → disk path.
 * The caller is responsible for cleaning up `tmpDir` after processing.
 */
export async function streamUnzipToDisk(
  body: ReadableStream<Uint8Array>,
  tmpDir: string,
): Promise<{
  jsonName: string | null
  jsonData: Uint8Array | null
  diskFiles: Map<string, string>
}> {
  const diskFiles = new Map<string, string>()
  let jsonName: string | null = null
  let jsonData: Uint8Array | null = null

  let totalCompressed   = 0
  let totalUncompressed = 0
  let fileCount         = 0
  let fatalError: ImportZipError | null = null

  const writeStreamFinishes: Promise<void>[] = []
  // Every WriteStream ever opened — destroyed in the finally below so a fatal
  // abort (e.g. compressed-size limit) can't leak open file descriptors.
  const allWriteStreams: WriteStream[] = []
  // Disk paths already claimed. safeTmpName maps different zip names onto the
  // same sanitized path (a:b.jpg / a?b.jpg) and a malformed ZIP can contain the
  // same entry name twice — both previously truncated a file mid-write.
  const usedDiskPaths = new Set<string>()
  // Backpressure: when a WriteStream's buffer is full, the network read loop
  // awaits this before pushing more data into the unzipper (bounded RAM).
  let pendingDrain: Promise<void> | null = null

  try {
  await new Promise<void>((resolve, reject) => {
    const unzipper = new Unzip((stream: UnzipFile) => {
      if (fatalError) return

      // Skip directory entries
      if (stream.name.endsWith("/")) { stream.start(); return }

      const name = stream.name

      // Path-traversal guard
      if (name.includes("..") || name.startsWith("/") || name.includes("\0")) {
        fatalError = new ImportZipError("ZIP enthält ungültige Dateipfade", "security")
        reject(fatalError)
        return
      }

      fileCount++
      if (fileCount > MAX_IMPORT_FILES) {
        fatalError = new ImportZipError(
          `ZIP enthält zu viele Dateien (max. ${MAX_IMPORT_FILES})`,
          "security",
        )
        reject(fatalError)
        return
      }

      const isRootJson = name.endsWith(".json") && !name.includes("/")

      if (isRootJson && jsonName !== null) {
        // Previously the LAST root JSON silently won — a multi-journal DayOne
        // export imported only one journal while reporting success.
        fatalError = new ImportZipError(
          "ZIP enthält mehrere Journal-JSON-Dateien — bitte Journale einzeln exportieren und importieren",
          "format",
        )
        reject(fatalError)
        return
      }

      if (isRootJson) {
        // Buffer the JSON manifest in memory — it's small metadata text
        const chunks: Uint8Array[] = []
        let fileBytes = 0

        stream.ondata = (err, chunk, final) => {
          if (fatalError) return
          if (err) {
            reject(new ImportZipError("ZIP konnte nicht gelesen werden", "format"))
            return
          }
          fileBytes += chunk.length
          totalUncompressed += chunk.length
          if (fileBytes > MAX_SINGLE_FILE_BYTES) {
            fatalError = new ImportZipError(
              "ZIP enthält eine Datei die 100 MB überschreitet",
              "security",
            )
            reject(fatalError)
            return
          }
          if (totalUncompressed > MAX_IMPORT_UNCOMPRESSED) {
            fatalError = new ImportZipError(
              "ZIP-Inhalt zu groß unkomprimiert (max. 200 MB)",
              "security",
            )
            reject(fatalError)
            return
          }
          chunks.push(chunk)
          if (final) {
            jsonName = name
            jsonData = Buffer.concat(chunks)
          }
        }
        stream.start()
      } else {
        // Media file — write directly to disk via a WriteStream.
        // mkdirSync is intentional: fflate's entry callbacks run synchronously
        // inside push(), so the directory must exist before start() is called
        // or chunks will be lost before ondata is wired up.
        let diskPath = join(tmpDir, safeTmpName(name))
        if (usedDiskPaths.has(diskPath)) {
          // Collision (sanitized twin or duplicate entry name): pick a unique
          // sibling instead of truncating a file another stream is writing.
          const dot = diskPath.lastIndexOf(".")
          const stem = dot > diskPath.lastIndexOf("/") ? diskPath.slice(0, dot) : diskPath
          const ext  = dot > diskPath.lastIndexOf("/") ? diskPath.slice(dot) : ""
          diskPath = `${stem}__${fileCount}${ext}`
        }
        usedDiskPaths.add(diskPath)
        try {
          mkdirSync(dirname(diskPath), { recursive: true })
        } catch {
          fatalError = new ImportZipError(
            "Fehler beim Anlegen temporärer Verzeichnisse",
            "format",
          )
          reject(fatalError)
          return
        }

        const ws = createWriteStream(diskPath)
        allWriteStreams.push(ws)
        let fileBytes = 0
        let wsDestroyed = false

        const finish = new Promise<void>((res, rej) => {
          ws.once("finish", () => { diskFiles.set(name, diskPath); res() })
          ws.once("error", (e) => {
            if (!fatalError) {
              fatalError = new ImportZipError(
                "Fehler beim Schreiben temporärer Dateien",
                "format",
              )
              reject(fatalError)
            }
            rej(e)
          })
        })
        writeStreamFinishes.push(finish)

        stream.ondata = (err, chunk, final) => {
          if (fatalError || wsDestroyed) return
          if (err) {
            wsDestroyed = true
            ws.destroy()
            fatalError = new ImportZipError("ZIP konnte nicht gelesen werden", "format")
            reject(fatalError)
            return
          }
          fileBytes += chunk.length
          totalUncompressed += chunk.length
          if (fileBytes > MAX_SINGLE_FILE_BYTES) {
            wsDestroyed = true
            ws.destroy()
            fatalError = new ImportZipError(
              "ZIP enthält eine Datei die 100 MB überschreitet",
              "security",
            )
            reject(fatalError)
            return
          }
          if (totalUncompressed > MAX_IMPORT_UNCOMPRESSED) {
            wsDestroyed = true
            ws.destroy()
            fatalError = new ImportZipError(
              "ZIP-Inhalt zu groß unkomprimiert (max. 200 MB)",
              "security",
            )
            reject(fatalError)
            return
          }
          if (!ws.write(chunk)) {
            // Buffer full (slow SD card vs. fast network): make the read loop
            // wait for drain before pushing more — otherwise Node buffers every
            // pending write in RAM, up to the whole file (Pi 4 OOM).
            const drained = new Promise<void>((res) => {
              ws.once("drain", res)
              ws.once("close", res) // destroyed streams never drain — don't hang the read loop
            })
            pendingDrain = pendingDrain ? pendingDrain.then(() => drained) : drained
          }
          if (final) ws.end()
        }
        stream.start()
      }
    })

    unzipper.register(UnzipInflate)
    unzipper.register(UnzipPassThrough)

    const reader = body.getReader()
    ;(async () => {
      try {
        for (;;) {
          if (fatalError) { reader.cancel().catch(() => {}); return }
          if (pendingDrain) {
            const wait = pendingDrain
            await wait
            if (pendingDrain === wait) pendingDrain = null
          }
          if (fatalError) { reader.cancel().catch(() => {}); return }
          const { done, value } = await reader.read()
          if (done) {
            try {
              unzipper.push(new Uint8Array(0), true)
            } catch {
              if (!fatalError) {
                reject(new ImportZipError("ZIP konnte nicht gelesen werden", "format"))
              }
              return
            }
            if (!fatalError) resolve()
            return
          }
          totalCompressed += value.length
          if (totalCompressed > MAX_IMPORT_COMPRESSED) {
            fatalError = new ImportZipError("Datei zu groß (max. 100 MB)", "too_large")
            reject(fatalError)
            reader.cancel().catch(() => {})
            return
          }
          try {
            unzipper.push(value)
          } catch {
            if (!fatalError) {
              reject(new ImportZipError("ZIP konnte nicht gelesen werden", "format"))
            }
            return
          }
          if (fatalError) { reader.cancel().catch(() => {}); return }
        }
      } catch (e) {
        if (!fatalError) {
          reject(
            e instanceof ImportZipError
              ? e
              : new ImportZipError("ZIP konnte nicht gelesen werden", "format"),
          )
        }
      }
    })()
  })

  // Wait for all streaming writes to flush before returning.
  await Promise.all(writeStreamFinishes).catch((e) => {
    throw e instanceof ImportZipError
      ? e
      : new ImportZipError("Fehler beim Schreiben temporärer Dateien", "format")
  })
  } finally {
    // Fatal aborts (size limits, traversal, reader errors) previously left the
    // WriteStream of the in-flight media file open — a leaked fd per failed
    // import in a long-lived process. destroy() on finished streams is a no-op.
    for (const ws of allWriteStreams) ws.destroy()
  }

  return { jsonName, jsonData, diskFiles }
}
