import { NextRequest, NextResponse } from "next/server"
import { mkdir, unlink, rename, copyFile, rm, stat } from "fs/promises"
import { join } from "path"
import { cleanText } from "@/lib/clean-text"
import { streamUnzipToDisk, ImportZipError } from "@/lib/import-stream"
import { mapWeatherCode, toUUID, buildLocationName } from "@/lib/dayone-import"
import { guardApiRequest } from "@/lib/request-guard"
import { safeExtFromFormat, safeOriginalName, isPdfHeader, PDF_HEADER_BYTES } from "@/lib/upload-security"
import { readFileHead } from "@/lib/upload-stream"
import { acceptedTimeZone } from "@/lib/db/time-zone"
import { rotateDatasetId } from "@/lib/db/dataset-id"
import { extractPoster, generateLoopClip, probeDuration, probeMediaStreams } from "@/lib/video-thumbnail"

export const maxDuration = 120 // allow up to 2 minutes for large imports
// Pi-safe ceiling: DayOne real exports are ~28 MB; 100 MiB (104,857,600 bytes) gives
// generous headroom without risking OOM on the Raspberry Pi 4.
// Set to "105mb" (105,000,000 bytes decimal) so Next.js does not truncate the stream
// before the streaming guard (MAX_IMPORT_COMPRESSED = 100 * 1024 * 1024 = 104,857,600)
// has a chance to fire and return 413. "100mb" (decimal) = 100,000,000 < 104,857,600
// and caused fflate to receive a truncated ZIP → 422 instead of 413.
export const maxRequestBodySize = "105mb"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Move a file, falling back to copy+delete on cross-device rename errors.
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(src, dest)
      await unlink(src)
    } else {
      throw e
    }
  }
}

/**
 * Moves an unpacked photo into its own media dir and writes the 400px webp
 * thumbnail (thumbPath falls back to the original when sharp fails). Returns
 * the web paths for the media row and every file written (cleanup on rollback).
 *
 * Same trust boundary as the upload (upload/route.ts): sharp reads only the
 * header, the format must be on the allowlist, and the extension comes from
 * that format — never from the filename in the ZIP. Returns null when the file
 * is not JPEG/PNG/WebP/GIF, before any decode happens (AVIF/HEIC would
 * otherwise go through libheif).
 */
async function importPhoto(tempPath: string): Promise<{ filePath: string; thumbPath: string; written: string[] } | null> {
  const sharp = (await import("sharp")).default
  let ext: string | null = null
  try {
    ext = safeExtFromFormat((await sharp(tempPath).metadata()).format)
  } catch {
    // unreadable header → treated like a disallowed format
  }
  if (!ext) return null

  const mediaUuid = crypto.randomUUID()
  const dir = join(process.cwd(), "public", "media", mediaUuid)
  await mkdir(dir, { recursive: true })

  const origName = `${mediaUuid}-original.${ext}`
  const thumbName = `${mediaUuid}-thumb.webp`
  const finalOrigPath = join(dir, origName)

  await moveFile(tempPath, finalOrigPath)
  const written = [finalOrigPath]

  const filePath = `/media/${mediaUuid}/${origName}`
  let thumbPath = filePath

  try {
    await sharp(finalOrigPath)
      .rotate()
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(join(dir, thumbName))
    thumbPath = `/media/${mediaUuid}/${thumbName}`
    written.push(join(dir, thumbName))
  } catch {
    // Thumbnail generation failed; thumbPath stays as filePath
  }

  return { filePath, thumbPath, written }
}

interface ImportedPdf {
  filePath: string
  written: string[]
  originalName: string | null
  sizeBytes: number | null
}

/**
 * Moves an unpacked PDF into its own media dir. Same trust boundary as the
 * upload (upload/route.ts): the "%PDF-" header on the unpacked bytes decides,
 * the extension is fixed, nothing decodes the file. Returns null — BEFORE any
 * mkdir/rename — when the file is not a PDF, so a rejected file leaves nothing
 * behind. `originalName` is the display name from the manifest (already
 * sanitised by the caller); the size comes from disk, the manifest's value is
 * only the fallback.
 */
async function importPdf(
  tempPath: string,
  originalName: string | null,
  sizeHint: number | null
): Promise<ImportedPdf | null> {
  let valid = false
  try {
    valid = isPdfHeader(await readFileHead(tempPath, PDF_HEADER_BYTES))
  } catch {
    // unreadable header → treated like a disallowed format
  }
  if (!valid) return null

  const mediaUuid = crypto.randomUUID()
  const dir = join(process.cwd(), "public", "media", mediaUuid)
  await mkdir(dir, { recursive: true })

  const origName = `${mediaUuid}-original.pdf`
  const finalOrigPath = join(dir, origName)
  await moveFile(tempPath, finalOrigPath)

  let sizeBytes = sizeHint
  try {
    sizeBytes = (await stat(finalOrigPath)).size
  } catch {
    // keep the manifest's value
  }

  return { filePath: `/media/${mediaUuid}/${origName}`, written: [finalOrigPath], originalName, sizeBytes }
}

type PdfBatchRow = { filePath: string; orderIdx: number; originalName: string | null; sizeBytes: number | null }

/** One INSERT for all PDFs of an entry — UNNEST like the other media types. */
async function insertPdfBatch(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  entryId: string,
  batch: PdfBatchRow[]
): Promise<void> {
  if (batch.length === 0) return
  await client.query(
    `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index, original_name, size_bytes)
     SELECT $1::uuid, 'pdf', f, NULL, o, n, s
     FROM UNNEST($2::text[], $3::int[], $4::text[], $5::int[]) AS u(f, o, n, s)`,
    [
      entryId,
      batch.map(p => p.filePath),
      batch.map(p => p.orderIdx),
      batch.map(p => p.originalName),
      batch.map(p => p.sizeBytes),
    ]
  )
}

/**
 * Importierte Einträge behalten ihr altes updated_at, der Delta-Sync erreicht sie
 * nie. Eine neue Kennung lässt jedes Gerät beim nächsten Sync vollständig abgleichen.
 * Die Einträge sind hier schon committet: Ein Fehler ist nur noch eine Warnung, und
 * sie steht vorn, damit sie in einer langen Liste nicht untergeht. Auch bei nur
 * übersprungenen Einträgen rotieren: Brach ein früherer Lauf nach dem Commit ab, ist
 * dieselbe Datei noch einmal der einzige Weg, die Geräte nachzuholen.
 */
async function rotateAfterImport(
  client: Parameters<typeof rotateDatasetId>[0],
  known: number,
  warnings: string[]
): Promise<void> {
  if (known === 0) return
  try {
    await rotateDatasetId(client)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("import: rotateDatasetId failed:", err)
    warnings.unshift(
      `Geräteabgleich nicht angestoßen (${msg}). Die Einträge sind gespeichert. Damit verbundene Geräte sie bekommen, dieselbe Datei noch einmal importieren.`
    )
  }
}

// Day One nennt format "aac", die Datei heißt aber .m4a: In dieser Reihenfolge suchen,
// die Endung kommt damit aus dieser Liste, nie aus dem JSON.
const DAY_ONE_AUDIO_EXTS = ["m4a", "aac", "mp3"] as const

const DAY_ONE_VIDEO_EXTS = ["mov", "mp4", "m4v"] as const

export async function POST(req: NextRequest) {
  // Outside the proxy matcher (body must stream) — guard here, same functions.
  const guard = await guardApiRequest(req)
  if (guard) return guard

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Kein Datenbankzugang. Import nur auf dem Server mit DATABASE_URL möglich.", code: "import_no_db" },
      { status: 503 }
    )
  }

  // journalId comes from the query string: /api/import?journalId=<uuid>
  const targetJournalId = req.nextUrl.searchParams.get("journalId")

  // journalName names the auto-created DayOne journal; empty falls back to
  // "DayOne Import". Validated before the body is streamed (fail fast).
  const rawJournalName = req.nextUrl.searchParams.get("journalName")?.trim() ?? ""
  if (rawJournalName.length > 200) {
    return NextResponse.json(
      { error: "Ungültige Eingabedaten", code: "validation_error" },
      { status: 400 }
    )
  }
  const importJournalName = rawJournalName || "DayOne Import"

  const start = Date.now()

  if (!req.body) {
    return NextResponse.json({ error: "Ungültiger Request: kein Body", code: "invalid_request_body" }, { status: 400 })
  }

  // Temp INSIDE the media volume — public/ selbst ist in Prod der
  // Container-Overlay-Layer: dort war der "same-filesystem rename" real ein
  // EXDEV-copy+delete (doppelter Platzbedarf), und OOM-Crash-Leichen lagen
  // außerhalb des Volumes, wo kein Sweep sie fand. Der Punkt-Präfix hält das
  // Dir aus jedem UUID-Matching heraus; media-sweep räumt Reste nach 24 h.
  // Cleaned up in the finally block regardless of import outcome.
  const importSessionId = crypto.randomUUID()
  const tmpDir = join(process.cwd(), "public", "media", ".tmp-" + importSessionId)

  let diskFiles: Map<string, string>
  let jsonName: string | null
  let jsonData: Uint8Array | null

  try {
    try {
      ;({ jsonName, jsonData, diskFiles } = await streamUnzipToDisk(req.body, tmpDir))
    } catch (err) {
      if (err instanceof ImportZipError) {
        const status = err.kind === "too_large" ? 413 : 422
        const code =
          err.kind === "too_large" ? "import_zip_too_large" :
          err.kind === "security"  ? "import_zip_invalid" :
          "import_zip_format_error"
        return NextResponse.json({ error: err.message, code }, { status })
      }
      console.error("import: unzip failed:", err)
      return NextResponse.json({ error: "ZIP-Datei konnte nicht gelesen werden", code: "zip_read_failed" }, { status: 422 })
    }

    // Find the root-level JSON file (journal name may vary, e.g. "Tagebuch.json", "Journal.json")
    if (!jsonName || !jsonData) {
      return NextResponse.json({ error: "Keine Journal-JSON-Datei im ZIP gefunden", code: "no_journal_json" }, { status: 422 })
    }

    let parsed: { version?: string; journals?: WithinV1Journal[]; entries?: DayOneEntry[] | WithinV1Entry[] }
    try {
      const text = new TextDecoder("utf-8").decode(jsonData)
      parsed = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: "Journal-JSON konnte nicht gelesen werden", code: "journal_json_read_failed" }, { status: 422 })
    }

    // ── v1.0: within's own export format — detect before DayOne logic ─────────
    if (parsed.version === "1.0") {
      const v1 = parsed as unknown as WithinV1Export
      const v1Entries = (v1.entries ?? []) as WithinV1Entry[]

      if (v1Entries.length === 0) {
        return NextResponse.json({ imported: 0, skipped: 0, errors: [], duration: Date.now() - start })
      }

      const { db: dbV1 } = await import("@/lib/db")
      let importedV1 = 0
      let skippedV1 = 0
      const warningsV1: string[] = []
      const errorsV1: string[] = []

      // ── Journals anlegen — Merge-Semantik ───────
      // Name/Farbe nur bei Neuanlage aus dem Export übernehmen. Ein Re-Import
      // derselben ZIP setzte vorher eine spätere Umbenennung (z.B. via
      // Settings) stillschweigend auf den alten Exportstand zurück,
      // obwohl alle Entries korrekt als "skipped" gemeldet wurden.
      const journalIdSet = new Set<string>()
      for (const journal of v1.journals ?? []) {
        if (!UUID_RE.test(journal.id ?? "")) continue
        await dbV1.query(
          `INSERT INTO journals (id, name, color)
           VALUES ($1::uuid, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [journal.id, journal.name, journal.color ?? "#000000"]
        )
        journalIdSet.add(journal.id)
      }

      let fallbackJournalId: string | null = null

      for (const entry of v1Entries) {
        // ── Validate entry UUID ──────────────────────────────────────────
        if (!UUID_RE.test(entry.id ?? "")) {
          errorsV1.push(`${entry.id ?? "unknown"}: Ungültige oder fehlende UUID`)
          continue
        }

        // ── Resolve journal ──────────────────────────────────────────────
        let entryJournalId = entry.journalId
        if (!journalIdSet.has(entryJournalId)) {
          if (!fallbackJournalId) {
            const { rows: jFb } = await dbV1.query(
              `SELECT id FROM journals WHERE name = 'within Import' LIMIT 1`
            )
            if (jFb.length > 0) {
              fallbackJournalId = jFb[0].id
            } else {
              const { rows: [jFbNew] } = await dbV1.query(
                `INSERT INTO journals (name, color) VALUES ('within Import', '#5856D6') RETURNING id`
              )
              fallbackJournalId = jFbNew.id
            }
          }
          entryJournalId = fallbackJournalId!
        }

        // ── 1. Existence check — pool query, no connection held ──────────
        let timeZoneV1: string | null
        try {
          const { rows: existV1 } = await dbV1.query(
            `SELECT id FROM entries WHERE id = $1`, [entry.id]
          )
          if (existV1.length > 0) {
            skippedV1++
            continue
          }
          // Here, before any file moves and outside the transaction: a database
          // error only fails this entry, and a refused zone cannot abort BEGIN.
          timeZoneV1 = await acceptedTimeZone(dbV1, entry.timeZone)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errorsV1.push(`${entry.id}: ${msg}`)
          continue
        }

        // ── 2. File I/O — outside transaction, no connection held ────────
        const writtenV1: string[] = []
        const photoPathsV1: { filePath: string; thumbPath: string; orderIdx: number }[] = []
        const videoPathsV1: { filePath: string; thumbPath: string | null; previewPath: string | null; orderIdx: number; duration: number | null }[] = []
        const audioPathsV1: { filePath: string; orderIdx: number; duration: number | null }[] = []
        const pdfPathsV1: PdfBatchRow[] = []
        let fileIoErrV1: string | null = null

        try {
          if (entry.photos && entry.photos.length > 0) {
            const sortedPhotos = [...entry.photos].sort(
              (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
            )
            for (const photo of sortedPhotos) {
              const zipPath = `photos/${entry.id}/${photo.filename}`
              const tempPath = diskFiles.get(zipPath)
              if (!tempPath) {
                // In der JSON referenziert, aber nicht im ZIP — vorher stiller Datenverlust.
                warningsV1.push(`${entry.id}: Datei fehlt im ZIP: ${zipPath}`)
                continue
              }

              const imported = await importPhoto(tempPath)
              if (!imported) {
                warningsV1.push(`${entry.id}: Übersprungen, kein JPEG/PNG/WebP/GIF: ${zipPath}`)
                continue
              }
              const { filePath, thumbPath, written } = imported
              writtenV1.push(...written)
              photoPathsV1.push({ filePath, thumbPath, orderIdx: photo.orderIndex ?? 0 })
            }
          }

          if (entry.videos && entry.videos.length > 0) {
            const sortedVideos = [...entry.videos].sort(
              (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
            )
            for (const video of sortedVideos) {
              const zipPath = `videos/${entry.id}/${video.filename}`
              const tempPath = diskFiles.get(zipPath)
              if (!tempPath) {
                // In der JSON referenziert, aber nicht im ZIP — vorher stiller Datenverlust.
                warningsV1.push(`${entry.id}: Datei fehlt im ZIP: ${zipPath}`)
                continue
              }

              const mediaUuid = crypto.randomUUID()
              const dir = join(process.cwd(), "public", "media", mediaUuid)
              await mkdir(dir, { recursive: true })

              const ext = video.filename.split(".").pop() ?? "mp4"
              const origName = `${mediaUuid}-original.${ext}`
              const finalOrigPath = join(dir, origName)

              await moveFile(tempPath, finalOrigPath)
              writtenV1.push(finalOrigPath)

              // Restore poster (thumbnail_path) from ZIP if exported
              let thumbWebPath: string | null = null
              if (video.thumbnailFilename) {
                const thumbZipPath = `video-thumbnails/${entry.id}/${video.thumbnailFilename}`
                const thumbTmp = diskFiles.get(thumbZipPath)
                if (thumbTmp) {
                  const thumbName = `${mediaUuid}-thumb.webp`
                  const finalThumbPath = join(dir, thumbName)
                  await moveFile(thumbTmp, finalThumbPath)
                  writtenV1.push(finalThumbPath)
                  thumbWebPath = `/media/${mediaUuid}/${thumbName}`
                }
              }

              // Restore loop-clip (preview_path) from ZIP if exported
              let previewWebPath: string | null = null
              if (video.previewFilename) {
                const previewZipPath = `video-previews/${entry.id}/${video.previewFilename}`
                const previewTmp = diskFiles.get(previewZipPath)
                if (previewTmp) {
                  const previewName = `${mediaUuid}-preview.webp`
                  const finalPreviewPath = join(dir, previewName)
                  await moveFile(previewTmp, finalPreviewPath)
                  writtenV1.push(finalPreviewPath)
                  previewWebPath = `/media/${mediaUuid}/${previewName}`
                }
              }

              videoPathsV1.push({
                filePath: `/media/${mediaUuid}/${origName}`,
                thumbPath: thumbWebPath,
                previewPath: previewWebPath,
                orderIdx: video.orderIndex ?? 0,
                duration: video.durationSeconds != null ? Math.round(video.durationSeconds) : null,
              })
            }
          }

          if (entry.audios && entry.audios.length > 0) {
            const sortedAudios = [...entry.audios].sort(
              (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
            )
            for (const audio of sortedAudios) {
              const zipPath = `audios/${entry.id}/${audio.filename}`
              const tempPath = diskFiles.get(zipPath)
              if (!tempPath) {
                // In der JSON referenziert, aber nicht im ZIP — vorher stiller Datenverlust.
                warningsV1.push(`${entry.id}: Datei fehlt im ZIP: ${zipPath}`)
                continue
              }

              const mediaUuid = crypto.randomUUID()
              const dir = join(process.cwd(), "public", "media", mediaUuid)
              await mkdir(dir, { recursive: true })

              const ext = audio.filename.split(".").pop() ?? "m4a"
              const origName = `${mediaUuid}-original.${ext}`
              const finalOrigPath = join(dir, origName)

              await moveFile(tempPath, finalOrigPath)
              writtenV1.push(finalOrigPath)

              audioPathsV1.push({
                filePath: `/media/${mediaUuid}/${origName}`,
                orderIdx: audio.orderIndex ?? 0,
                duration: audio.durationSeconds != null ? Math.round(audio.durationSeconds) : null,
              })
            }
          }

          if (entry.pdfs && entry.pdfs.length > 0) {
            const sortedPdfs = [...entry.pdfs].sort(
              (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)
            )
            for (const pdf of sortedPdfs) {
              const zipPath = `pdfs/${entry.id}/${pdf.filename}`
              const tempPath = diskFiles.get(zipPath)
              if (!tempPath) {
                warningsV1.push(`${entry.id}: Datei fehlt im ZIP: ${zipPath}`)
                continue
              }
              const imported = await importPdf(tempPath, safeOriginalName(pdf.originalName), pdf.sizeBytes ?? null)
              if (!imported) {
                warningsV1.push(`${entry.id}: Übersprungen, keine PDF-Datei: ${zipPath}`)
                continue
              }
              writtenV1.push(...imported.written)
              pdfPathsV1.push({
                filePath: imported.filePath,
                orderIdx: pdf.orderIndex ?? 0,
                originalName: imported.originalName,
                sizeBytes: imported.sizeBytes,
              })
            }
          }
        } catch (err) {
          fileIoErrV1 = err instanceof Error ? err.message : String(err)
        }

        if (fileIoErrV1 !== null) {
          for (const f of writtenV1) await unlink(f).catch(() => {})
          errorsV1.push(`${entry.id}: ${fileIoErrV1}`)
          continue
        }

        // ── 3. Transaction — DB writes only ──────────────────────────────
        // Fails this entry only: entries committed before it still need the rotation below.
        let clientV1
        try {
          clientV1 = await dbV1.connect()
        } catch (err) {
          for (const f of writtenV1) await unlink(f).catch(() => {})
          errorsV1.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        try {
          await clientV1.query("BEGIN")

          const textV1   = cleanText(entry.text ?? "")
          const locV1    = entry.location
          const wxV1     = entry.weather

          const insV1 = await clientV1.query(
            `INSERT INTO entries
               (id, journal_id, text, created_at, updated_at, starred,
                location_name, location_lat, location_lng,
                weather_description, weather_temp_celsius, weather_icon, time_zone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (id) DO NOTHING`,
            [
              entry.id,
              entryJournalId,
              textV1,
              entry.createdAt,
              entry.updatedAt,
              entry.starred ?? false,
              locV1?.name ?? null,
              locV1?.latitude ?? null,
              locV1?.longitude ?? null,
              wxV1?.description ?? null,
              wxV1?.temperatureCelsius != null ? Math.round(wxV1.temperatureCelsius) : null,
              wxV1?.icon ?? null,  // DIRECT — icon is already the final WeatherIcon value
              timeZoneV1,
            ]
          )
          if ((insV1.rowCount ?? 1) === 0) {
            // Doppelklick/Retry-Race: ein paralleler Import hat den Entry
            // zwischen Duplikat-Check und INSERT angelegt — skipped, kein Fehler.
            await clientV1.query("ROLLBACK").catch(() => {})
            for (const f of writtenV1) await unlink(f).catch(() => {})
            writtenV1.length = 0
            skippedV1++
            continue
          }

          if (photoPathsV1.length > 0) {
            await clientV1.query(
              `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index)
               SELECT $1::uuid, 'photo', f, t, o
               FROM UNNEST($2::text[], $3::text[], $4::int[]) AS u(f, t, o)`,
              [
                entry.id,
                photoPathsV1.map(p => p.filePath),
                photoPathsV1.map(p => p.thumbPath),
                photoPathsV1.map(p => p.orderIdx),
              ]
            )
          }

          if (videoPathsV1.length > 0) {
            await clientV1.query(
              `INSERT INTO media (entry_id, type, file_path, thumbnail_path, preview_path, order_index, duration_seconds)
               SELECT $1::uuid, 'video', f, t, p, o, d
               FROM UNNEST($2::text[], $3::text[], $4::text[], $5::int[], $6::int[]) AS u(f, t, p, o, d)`,
              [
                entry.id,
                videoPathsV1.map(v => v.filePath),
                videoPathsV1.map(v => v.thumbPath),
                videoPathsV1.map(v => v.previewPath),
                videoPathsV1.map(v => v.orderIdx),
                videoPathsV1.map(v => v.duration),
              ]
            )
          }

          if (audioPathsV1.length > 0) {
            await clientV1.query(
              `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index, duration_seconds)
               SELECT $1::uuid, 'audio', f, NULL, o, d
               FROM UNNEST($2::text[], $3::int[], $4::int[]) AS u(f, o, d)`,
              [
                entry.id,
                audioPathsV1.map(a => a.filePath),
                audioPathsV1.map(a => a.orderIdx),
                audioPathsV1.map(a => a.duration),
              ]
            )
          }

          await insertPdfBatch(clientV1, entry.id, pdfPathsV1)

          // ── Tags ───────────────────────────────────────────────────────
          const tagNamesV1 = (entry.tags ?? []).map((t: string) => t.trim()).filter(Boolean)
          if (tagNamesV1.length > 0) {
            const { rows: tagRowsV1 } = await clientV1.query(
              `INSERT INTO tags (name) SELECT DISTINCT UNNEST($1::text[]) ORDER BY 1
               ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [tagNamesV1]
            )
            await clientV1.query(
              `INSERT INTO entry_tags (entry_id, tag_id)
               SELECT $1::uuid, UNNEST($2::uuid[])
               ON CONFLICT DO NOTHING`,
              [entry.id, tagRowsV1.map((r: { id: string }) => r.id)]
            )
          }

          await clientV1.query("COMMIT")
          writtenV1.length = 0
          importedV1++
        } catch (err) {
          await clientV1.query("ROLLBACK").catch(() => {})
          for (const f of writtenV1) await unlink(f).catch(() => {})
          const msg = err instanceof Error ? err.message : String(err)
          errorsV1.push(`${entry.id}: ${msg}`)
        } finally {
          clientV1.release()
        }
      }

      await rotateAfterImport(dbV1, importedV1 + skippedV1, warningsV1)

      return NextResponse.json({
        imported: importedV1,
        skipped: skippedV1,
        errors: errorsV1,
        warnings: warningsV1,
        duration: Date.now() - start,
      })
    }

    // ── DayOne path ───────────────────────────────────────────────────────────
    const entries = (parsed as { entries?: DayOneEntry[] }).entries ?? []
    if (entries.length === 0) {
      return NextResponse.json({ imported: 0, skipped: 0, errors: [], duration: Date.now() - start })
    }

    const { db } = await import("@/lib/db")
    let imported = 0
    let skipped = 0
    const errors: string[] = []
    const warnings: string[] = []

    // ── Resolve import journal once (no UNIQUE constraint on journals.name) ─
    let importJournalId: string
    if (targetJournalId) {
      const { rows } = await db.query(
        `SELECT id FROM journals WHERE id = $1::uuid`,
        [targetJournalId]
      )
      if (rows.length === 0) {
        return NextResponse.json({ error: "Journal nicht gefunden", code: "journal_not_found" }, { status: 404 })
      }
      importJournalId = rows[0].id
    } else {
      const { rows: jRows } = await db.query(
        `SELECT id FROM journals WHERE name = $1 LIMIT 1`,
        [importJournalName]
      )
      if (jRows.length > 0) {
        importJournalId = jRows[0].id
      } else {
        const { rows: [jRow] } = await db.query(
          `INSERT INTO journals (name, color) VALUES ($1, '#FF9500') RETURNING id`,
          [importJournalName]
        )
        importJournalId = jRow.id
      }
    }

    for (const entry of entries) {
      // 32 Hex-Zeichen erzwingen — toUUID würde aus Malformed-Werten sonst
      // stillschweigend verkürzte Pseudo-UUIDs bauen (Kollisionsrisiko).
      if (!/^[0-9a-f]{32}$/i.test(String(entry.uuid ?? "").replace(/-/g, ""))) {
        errors.push(`${entry.uuid}: ungültige UUID im Export`)
        continue
      }
      const entryId = toUUID(entry.uuid)

      // ── 1. Existence check — pool query, no connection held ───────────────
      let timeZone: string | null
      try {
        const { rows: existing } = await db.query(
          `SELECT id FROM entries WHERE id = $1`, [entryId]
        )
        if (existing.length > 0) {
          skipped++
          continue
        }
        // Here, before any file moves and outside the transaction: a database
        // error only fails this entry, and a refused zone cannot abort BEGIN.
        timeZone = await acceptedTimeZone(db, entry.timeZone)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${entry.uuid}: ${msg}`)
        continue
      }

      // ── 2. File I/O — outside transaction, no connection held ─────────────
      const allWrittenFiles: string[] = []
      const photoBatch: { filePath: string; thumbPath: string; orderIdx: number }[] = []
      const videoBatch: {
        filePath: string
        thumbPath: string | null
        orderIdx: number
        duration: number | null
        origFsPath: string
        loopFsPath: string
        loopWebPath: string
      }[] = []
      const pdfBatch: PdfBatchRow[] = []
      const audioBatch: { filePath: string; orderIdx: number; duration: number | null }[] = []
      let insertedVideos: { id: string; file_path: string }[] = []
      let fileIoErr: string | null = null

      try {
        if (entry.photos && entry.photos.length > 0) {
          const sortedPhotos = [...entry.photos].sort(
            (a, b) => (a.orderInEntry ?? 0) - (b.orderInEntry ?? 0)
          )
          for (const photo of sortedPhotos) {
            const zipPath = `photos/${photo.md5}.${photo.type}`
            const tempPath = diskFiles.get(zipPath)
            if (!tempPath) {
              // In der JSON referenziert, aber nicht im ZIP — vorher stiller Datenverlust.
              warnings.push(`${entry.uuid}: Datei fehlt im ZIP: ${zipPath}`)
              continue
            }

            const imported = await importPhoto(tempPath)
            if (!imported) {
              warnings.push(`${entry.uuid}: Übersprungen, kein JPEG/PNG/WebP/GIF: ${zipPath}`)
              continue
            }
            const { filePath, thumbPath, written } = imported
            allWrittenFiles.push(...written)
            photoBatch.push({ filePath, thumbPath, orderIdx: photo.orderInEntry ?? 0 })
          }
        }

        if (entry.videos && entry.videos.length > 0) {
          for (const video of entry.videos) {
            const zipPath = `videos/${video.md5}.${video.type}`
            const tempPath = diskFiles.get(zipPath)
            if (!tempPath) {
              // In der JSON referenziert, aber nicht im ZIP — vorher stiller Datenverlust.
              warnings.push(`${entry.uuid}: Datei fehlt im ZIP: ${zipPath}`)
              continue
            }
            // Same trust boundary as the upload, before ffmpeg touches the file:
            // the extension from a fixed list, the content checked by ffprobe.
            const ext = DAY_ONE_VIDEO_EXTS.find((e) => e === video.type.toLowerCase())
            if (!ext || await probeMediaStreams(tempPath, "video") === "invalid") {
              warnings.push(`${entry.uuid}: Übersprungen, keine Videodatei: ${zipPath}`)
              continue
            }

            const mediaUuid = crypto.randomUUID()
            const dir = join(process.cwd(), "public", "media", mediaUuid)
            await mkdir(dir, { recursive: true })
            const origName = `${mediaUuid}-original.${ext}`
            const finalOrigPath = join(dir, origName)

            await moveFile(tempPath, finalOrigPath)
            allWrittenFiles.push(finalOrigPath)

            // Same as the upload: one awaited frame, null on ffmpeg failure, the
            // video still comes along. Listed up front, ffmpeg may leave a partial file.
            const posterName = `${mediaUuid}-poster.webp`
            const posterFsPath = join(dir, posterName)
            allWrittenFiles.push(posterFsPath)
            const poster = await extractPoster(finalOrigPath, posterFsPath)
            if (!poster) await unlink(posterFsPath).catch(() => {})

            const loopName = `${mediaUuid}-loop.webp`
            videoBatch.push({
              filePath: `/media/${mediaUuid}/${origName}`,
              thumbPath: poster ? `/media/${mediaUuid}/${posterName}` : null,
              orderIdx: video.orderInEntry ?? 0,
              duration: video.duration ? Math.round(video.duration) : null,
              origFsPath: finalOrigPath,
              loopFsPath: join(dir, loopName),
              loopWebPath: `/media/${mediaUuid}/${loopName}`,
            })
          }
        }

        // Day One: pdfAttachments[] → pdfs/<md5>.pdf; pdfName is the user's
        // file name, fileSize only the fallback for the size on disk.
        if (entry.pdfAttachments && entry.pdfAttachments.length > 0) {
          const sortedPdfs = [...entry.pdfAttachments].sort(
            (a, b) => (a.orderInEntry ?? 0) - (b.orderInEntry ?? 0)
          )
          for (const pdf of sortedPdfs) {
            const zipPath = `pdfs/${pdf.md5}.${pdf.type || "pdf"}`
            const tempPath = diskFiles.get(zipPath)
            if (!tempPath) {
              warnings.push(`${entry.uuid}: Datei fehlt im ZIP: ${zipPath}`)
              continue
            }
            const imported = await importPdf(tempPath, safeOriginalName(pdf.pdfName), pdf.fileSize ?? null)
            if (!imported) {
              warnings.push(`${entry.uuid}: Übersprungen, keine PDF-Datei: ${zipPath}`)
              continue
            }
            allWrittenFiles.push(...imported.written)
            pdfBatch.push({
              filePath: imported.filePath,
              orderIdx: pdf.orderInEntry ?? 0,
              originalName: imported.originalName,
              sizeBytes: imported.sizeBytes,
            })
          }
        }

        if (entry.audios && entry.audios.length > 0) {
          const sortedAudios = [...entry.audios].sort(
            (a, b) => (a.orderInEntry ?? 0) - (b.orderInEntry ?? 0)
          )
          for (const audio of sortedAudios) {
            const ext = DAY_ONE_AUDIO_EXTS.find((e) => diskFiles.has(`audios/${audio.md5}.${e}`))
            if (!ext) {
              warnings.push(`${entry.uuid}: Datei fehlt im ZIP: audios/${audio.md5}.${DAY_ONE_AUDIO_EXTS[0]}`)
              continue
            }
            const zipPath = `audios/${audio.md5}.${ext}`
            const tempPath = diskFiles.get(zipPath)!
            // Before any mkdir/rename, so a rejected file leaves nothing behind.
            // "unknown" (no ffprobe, timeout) stays fail-open like the upload.
            if ((await probeMediaStreams(tempPath, "audio")) === "invalid") {
              warnings.push(`${entry.uuid}: Übersprungen, keine Audiodatei: ${zipPath}`)
              continue
            }

            const mediaUuid = crypto.randomUUID()
            const dir = join(process.cwd(), "public", "media", mediaUuid)
            await mkdir(dir, { recursive: true })
            const origName = `${mediaUuid}-original.${ext}`
            const finalOrigPath = join(dir, origName)
            await moveFile(tempPath, finalOrigPath)
            allWrittenFiles.push(finalOrigPath)

            // A value the INTEGER column cannot take would fail the whole entry.
            const jsonDuration = audio.duration
            const usable = typeof jsonDuration === "number" && jsonDuration > 0 && jsonDuration < 2 ** 31 - 1
            audioBatch.push({
              filePath: `/media/${mediaUuid}/${origName}`,
              orderIdx: audio.orderInEntry ?? 0,
              duration: usable ? Math.round(jsonDuration) : await probeDuration(finalOrigPath),
            })
          }
        }
      } catch (err) {
        fileIoErr = err instanceof Error ? err.message : String(err)
      }

      if (fileIoErr !== null) {
        for (const f of allWrittenFiles) await unlink(f).catch(() => {})
        errors.push(`${entry.uuid}: ${fileIoErr}`)
        continue
      }

      // ── 3. Transaction — DB writes only ──────────────────────────────────
      // Fails this entry only: entries committed before it still need the rotation below.
      let client
      try {
        client = await db.connect()
      } catch (err) {
        for (const f of allWrittenFiles) await unlink(f).catch(() => {})
        errors.push(`${entry.uuid}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      try {
        await client.query("BEGIN")

        // ── Text ──────────────────────────────────────────────────────────
        const text = cleanText(entry.text ?? "")

        // ── Location ──────────────────────────────────────────────────────
        const loc = entry.location
        const locationName = buildLocationName(loc as Record<string, string> | undefined)
        const locationLat = loc?.latitude ?? null
        const locationLng = loc?.longitude ?? null

        // ── Weather ───────────────────────────────────────────────────────
        const wx = entry.weather
        const weatherDescription = wx?.conditionsDescription ?? null
        const weatherTemp = wx?.temperatureCelsius != null ? Math.round(wx.temperatureCelsius) : null
        const weatherIcon = wx ? mapWeatherCode(wx.weatherCode) : null

        const journalId = importJournalId

        // ── Insert entry ──────────────────────────────────────────────────
        const insDayOne = await client.query(
          `INSERT INTO entries
             (id, journal_id, text, created_at, updated_at, starred,
              location_name, location_lat, location_lng,
              weather_description, weather_temp_celsius, weather_icon, time_zone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO NOTHING`,
          [
            entryId,
            journalId,
            text,
            entry.creationDate,
            entry.modifiedDate ?? entry.creationDate,
            entry.starred ?? false,
            locationName,
            locationLat,
            locationLng,
            weatherDescription,
            weatherTemp,
            weatherIcon,
            timeZone,
          ]
        )
        if ((insDayOne.rowCount ?? 1) === 0) {
          // Doppelklick/Retry-Race: paralleler Import gewann zwischen
          // Duplikat-Check und INSERT — skipped, kein Fehler.
          await client.query("ROLLBACK").catch(() => {})
          for (const f of allWrittenFiles) await unlink(f).catch(() => {})
          allWrittenFiles.length = 0
          skipped++
          continue
        }

        // ── Photos ────────────────────────────────────────────────────────
        if (photoBatch.length > 0) {
          await client.query(
            `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index)
             SELECT $1::uuid, 'photo', f, t, o
             FROM UNNEST($2::text[], $3::text[], $4::int[]) AS u(f, t, o)`,
            [
              entryId,
              photoBatch.map(p => p.filePath),
              photoBatch.map(p => p.thumbPath),
              photoBatch.map(p => p.orderIdx),
            ]
          )
        }

        // ── Videos ───────────────────────────────────────────────────────
        if (videoBatch.length > 0) {
          const { rows } = await client.query(
            `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index, duration_seconds)
             SELECT $1::uuid, 'video', f, t, o, d
             FROM UNNEST($2::text[], $3::text[], $4::int[], $5::int[]) AS u(f, t, o, d)
             RETURNING id, file_path`,
            [
              entryId,
              videoBatch.map(v => v.filePath),
              videoBatch.map(v => v.thumbPath),
              videoBatch.map(v => v.orderIdx),
              videoBatch.map(v => v.duration),
            ]
          )
          insertedVideos = rows
        }

        // ── PDFs ─────────────────────────────────────────────────────────
        await insertPdfBatch(client, entryId, pdfBatch)

        // ── Audio memos ──────────────────────────────────────────────────
        if (audioBatch.length > 0) {
          await client.query(
            `INSERT INTO media (entry_id, type, file_path, thumbnail_path, order_index, duration_seconds)
             SELECT $1::uuid, 'audio', f, NULL, o, d
             FROM UNNEST($2::text[], $3::int[], $4::int[]) AS u(f, o, d)`,
            [
              entryId,
              audioBatch.map(a => a.filePath),
              audioBatch.map(a => a.orderIdx),
              audioBatch.map(a => a.duration),
            ]
          )
        }

        // ── Tags — batch-upsert names, then batch-link to entry ────────────
        const tagNames = (entry.tags ?? []).map((t: string) => t.trim()).filter(Boolean)
        if (tagNames.length > 0) {
          const { rows: tagRows } = await client.query(
            `INSERT INTO tags (name) SELECT DISTINCT UNNEST($1::text[]) ORDER BY 1
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [tagNames]
          )
          await client.query(
            `INSERT INTO entry_tags (entry_id, tag_id)
             SELECT $1::uuid, UNNEST($2::uuid[])
             ON CONFLICT DO NOTHING`,
            [entryId, tagRows.map((r: { id: string }) => r.id)]
          )
        }

        await client.query("COMMIT")
        allWrittenFiles.length = 0 // committed — no file cleanup needed
        imported++
        // Detached and one at a time (module-wide chain), like the upload.
        for (const row of insertedVideos) {
          const video = videoBatch.find(v => v.filePath === row.file_path)!
          generateLoopClip(video.origFsPath, video.loopFsPath, row.id, video.loopWebPath)
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {})
        for (const f of allWrittenFiles) await unlink(f).catch(() => {})
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${entry.uuid}: ${msg}`)
      } finally {
        client.release()
      }
    }

    await rotateAfterImport(db, imported + skipped, warnings)

    return NextResponse.json({
      imported,
      skipped,
      errors,
      warnings,
      duration: Date.now() - start,
    })
  } finally {
    // Best-effort cleanup: remove any temp files not yet moved to final location.
    try { await rm(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

// ── within v1.0 JSON types ────────────────────────────────────────────────────

interface WithinV1Journal {
  id: string
  name: string
  color?: string
}

interface WithinV1Photo {
  filename: string
  orderIndex?: number
}

interface WithinV1Video {
  filename: string
  orderIndex?: number
  durationSeconds?: number | null
  thumbnailFilename?: string | null
  previewFilename?: string | null
}

interface WithinV1Audio {
  filename: string
  orderIndex?: number
  durationSeconds?: number | null
}

interface WithinV1Pdf {
  filename: string
  orderIndex?: number
  originalName?: string | null
  sizeBytes?: number | null
}

interface WithinV1Entry {
  id: string
  journalId: string
  text?: string
  createdAt: string
  updatedAt: string
  timeZone?: string | null
  starred?: boolean
  location?: { name?: string; latitude?: number; longitude?: number } | null
  weather?: { description?: string | null; temperatureCelsius?: number | null; icon?: string | null } | null
  tags?: string[]
  photos?: WithinV1Photo[]
  videos?: WithinV1Video[]
  audios?: WithinV1Audio[]
  pdfs?: WithinV1Pdf[]
}

interface WithinV1Export {
  version: "1.0"
  journals?: WithinV1Journal[]
  entries?: WithinV1Entry[]
}

// ── DayOne JSON types ──────────────────────────────────────────────────────

interface DayOnePhoto {
  identifier: string
  md5: string
  type: string
  orderInEntry?: number
}

interface DayOneVideo {
  identifier: string
  md5: string
  type: string        // "mov"
  orderInEntry?: number
  duration?: number   // seconds
  width?: number
  height?: number
}

interface DayOnePdfAttachment {
  identifier: string
  md5: string
  type: string        // "pdf"
  pdfName?: string    // the user's file name
  fileSize?: number
  orderInEntry?: number
}

interface DayOneAudio {
  identifier: string
  md5: string
  format?: string     // "aac", says nothing about the file name (audios/<md5>.m4a)
  orderInEntry?: number
  duration?: number   // seconds
}

interface DayOneEntry {
  uuid: string
  text?: string
  creationDate: string
  modifiedDate?: string
  timeZone?: string
  starred?: boolean
  tags?: string[]
  photos?: DayOnePhoto[]
  videos?: DayOneVideo[]
  pdfAttachments?: DayOnePdfAttachment[]
  audios?: DayOneAudio[]
  location?: {
    latitude?: number
    longitude?: number
    placeName?: string
    localityName?: string
    country?: string
  }
  weather?: {
    weatherCode?: string
    conditionsDescription?: string
    temperatureCelsius?: number
  }
}
