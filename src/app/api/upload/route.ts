import { NextRequest, NextResponse } from "next/server"
import { mkdir, rm, rename } from "fs/promises"
import { join } from "path"
import { logError, logWarn } from "@/lib/logger"
import {
  safeExtFromFormat,
  safeExtFromMime,
  detectMediaTypeFromMime,
  getMaxBytesForType,
  getMaxMBForType,
} from "@/lib/upload-security"
import { extractPoster, generateLoopClip, probeDuration, probeMediaStreams } from "@/lib/video-thumbnail"
import { saveBodyToDisk, UploadTooLargeError } from "@/lib/upload-stream"
import { guardApiRequest } from "@/lib/request-guard"
import type { Pool } from "pg"

/**
 * The outbox id travels with the upload so a retry after a lost
 * response finds its already-inserted row instead of creating a duplicate.
 * Anything malformed degrades to null — same behavior as an old client that
 * sends no id at all.
 */
function parseClientMediaId(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string") return null
  return /^[A-Za-z0-9._-]{1,100}$/.test(raw) ? raw : null
}

interface AttachedRow {
  id: string
  filePath: string
  thumbnailPath: string | null
  /** True when a concurrent retry won the insert race — its files are the files. */
  reused: boolean
}

/**
 * Insert the media row, honoring the client_media_id UNIQUE arbiter. When a
 * concurrent retry already inserted the row, the freshly written duplicate
 * files are removed and the winner's row is returned.
 */
async function insertMediaRow(db: Pool, params: {
  entryId: string
  type: "photo" | "video" | "audio"
  filePath: string
  thumbnailPath: string | null
  durationSeconds: number | null
  clientMediaId: string | null
  uploadDir: string
}): Promise<AttachedRow | null> {
  // order_index atomically inside the INSERT — a separate MAX()+1 read gave two
  // concurrent uploads to the same entry the same index (unstable UI order).
  const { rows: [media] } = await db.query(
    `INSERT INTO media (entry_id, type, file_path, thumbnail_path, duration_seconds, order_index, client_media_id)
     VALUES ($1,$2,$3,$4,$5,
       (SELECT COALESCE(MAX(order_index), -1) + 1 FROM media WHERE entry_id = $1),
       $6)
     ON CONFLICT (client_media_id) WHERE client_media_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      params.entryId,
      params.type,
      params.filePath,
      params.thumbnailPath,
      params.durationSeconds,
      params.clientMediaId,
    ]
  )
  if (media) {
    return { id: media.id, filePath: params.filePath, thumbnailPath: params.thumbnailPath, reused: false }
  }

  // Conflict: a concurrent upload with the same client_media_id won the race.
  const { rows: [winner] } = await db.query(
    `SELECT id, file_path, thumbnail_path FROM media WHERE client_media_id = $1`,
    [params.clientMediaId]
  )
  await removeUploadDir(params.uploadDir)
  if (!winner) return null
  return { id: winner.id, filePath: winner.file_path, thumbnailPath: winner.thumbnail_path, reused: true }
}

/** Best-effort cleanup of a written-but-unreferenced upload directory. */
async function removeUploadDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    logWarn(`[upload] orphaned upload dir could not be removed: ${dir}`, err)
  }
}

const MEDIA_INSERT_FAILED = { error: "Medium konnte nicht gespeichert werden", code: "media_insert_failed" }

/**
 * Attach the written file to its entry: insert the media row and answer 201
 * with `respond(row)`. Any failure answers 503 (`media_insert_failed`, retry
 * semantics for the outbox client) and never leaves files no row references:
 * a conflict loser was already cleaned up by insertMediaRow, every other
 * failure (timeouts/disconnects included) removes the upload dir here.
 */
async function attachOrFail(
  params: Parameters<typeof insertMediaRow>[1],
  respond: (row: AttachedRow) => object
): Promise<NextResponse> {
  try {
    const { db } = await import("@/lib/db")
    const row = await insertMediaRow(db, params)
    if (row) return NextResponse.json(respond(row), { status: 201 })
    // Conflict winner vanished — insertMediaRow already removed the upload
    // dir; a 201 with its path would point at a deleted file. 503 = retry.
    return NextResponse.json(MEDIA_INSERT_FAILED, { status: 503 })
  } catch (err) {
    logError("[upload] DB insert failed:", err)
    await removeUploadDir(params.uploadDir)
    return NextResponse.json(MEDIA_INSERT_FAILED, { status: 503 })
  }
}

function tooLarge(mediaType: "photo" | "video" | "audio"): NextResponse {
  const maxMB = getMaxMBForType(mediaType)
  const label = mediaType === "video" ? "Videos" : mediaType === "audio" ? "Audio" : "Bilder"
  return NextResponse.json(
    { error: `Datei zu groß (max. ${maxMB} MB für ${label})`, code: "file_too_large", maxMB, kind: mediaType },
    { status: 400 }
  )
}

/**
 * Raw-body upload: the file IS the body, its MIME type is the content-type,
 * its size the content-length; entryId and clientMediaId travel as query
 * parameters. Multipart buffered the whole body in RAM before anything could
 * stream (60 MB file → +125 MB RSS on the Pi). The route sits outside the
 * proxy matcher (Next would clone the body into RAM there) and guards itself.
 */
export async function POST(req: NextRequest) {
  const guard = await guardApiRequest(req)
  if (guard) return guard

  const entryId = req.nextUrl.searchParams.get("entryId")

  let body: ReadableStream<Uint8Array> | null
  let contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim()
  let contentLength: string
  let clientMediaIdRaw: FormDataEntryValue | null
  if (contentType.startsWith("multipart/")) {
    // intentionally transitional: multipart path for pre-#530 clients (their
    // cached JS still sends FormData; buffers like before). Remove after 2026-10-15.
    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return NextResponse.json({ error: "Ungültiger Request", code: "invalid_request" }, { status: 400 })
    }
    const file = formData.get("file")
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Keine Datei übermittelt", code: "no_file" }, { status: 400 })
    }
    body = file.stream()
    contentType = file.type
    contentLength = String(file.size)
    clientMediaIdRaw = formData.get("clientMediaId")
  } else {
    body = req.body
    contentLength = req.headers.get("content-length") ?? ""
    clientMediaIdRaw = req.nextUrl.searchParams.get("clientMediaId")
  }

  const mediaType = detectMediaTypeFromMime(contentType)
  if (!mediaType) {
    return NextResponse.json(
      { error: "Dateiformat nicht erlaubt (MP4, MOV, MP3, M4A, AAC, JPG, PNG, WebP, GIF)", code: "file_type_not_allowed" },
      { status: 400 }
    )
  }

  // Size gate BEFORE any byte is read; a byte counter in saveBodyToDisk backs it up.
  if (!/^\d+$/.test(contentLength) || !body) {
    return NextResponse.json({ error: "Ungültiger Request", code: "length_required" }, { status: 411 })
  }
  const maxBytes = getMaxBytesForType(mediaType)
  if (Number(contentLength) > maxBytes) return tooLarge(mediaType)

  const clientMediaId = parseClientMediaId(clientMediaIdRaw)

  // Settle idempotency and entry existence BEFORE bytes hit the
  // disk. Best-effort — a DB hiccup here falls through to today's behavior
  // (write, try the insert, 201 without id on failure = client retries).
  if (entryId && process.env.DATABASE_URL) {
    try {
      const { db } = await import("@/lib/db")

      if (clientMediaId) {
        const { rows: [existing] } = await db.query(
          `SELECT id, type, file_path, thumbnail_path FROM media WHERE client_media_id = $1`,
          [clientMediaId]
        )
        if (existing) {
          // Retry of an upload whose response got lost — the row is already there.
          return NextResponse.json(
            {
              id: existing.id,
              filePath: existing.file_path,
              thumbnailPath: existing.thumbnail_path,
              type: existing.type,
            },
            { status: 201 }
          )
        }
      }

      const { rows: [entryRow] } = await db.query(
        `SELECT deleted_at FROM entries WHERE id = $1`,
        [entryId]
      )
      if (!entryRow) {
        // Entry not pushed yet — retryable, same meaning as 201 without id,
        // but without stacking an orphaned file copy on disk per attempt.
        return NextResponse.json(
          { error: "Eintrag ist serverseitig noch nicht vorhanden", code: "entry_missing" },
          { status: 409 }
        )
      }
      if (entryRow.deleted_at) {
        // Entry deleted — the file has no home anymore; client drops the outbox item.
        return NextResponse.json(
          { error: "Eintrag wurde gelöscht", code: "entry_deleted" },
          { status: 410 }
        )
      }
    } catch (err) {
      logWarn("[upload] pre-insert check failed, continuing with upload:", err)
    }
  }

  const uuid = crypto.randomUUID()
  const dir = join(process.cwd(), "public", "media", uuid)
  await mkdir(dir, { recursive: true })

  // ── Photo path (sharp is the sole content validator, reads from disk) ─────
  if (mediaType === "photo") {
    // Extension is only known after sharp has looked at the bytes → temp name first.
    const tmpPath = join(dir, `${uuid}-original`)
    try {
      await saveBodyToDisk(body, tmpPath, maxBytes)
    } catch (err) {
      await removeUploadDir(dir)
      if (err instanceof UploadTooLargeError) return tooLarge(mediaType)
      throw err
    }
    let ext: string
    try {
      const sharpValidate = (await import("sharp")).default
      const metadata = await sharpValidate(tmpPath).metadata()
      const safeExt = safeExtFromFormat(metadata.format)
      if (!safeExt) {
        await removeUploadDir(dir) // sonst bleibt pro abgelehntem Upload ein leeres Verzeichnis zurück
        return NextResponse.json(
          { error: "Nur Bilder (JPG, PNG, WebP, GIF) erlaubt", code: "only_images_allowed" },
          { status: 400 }
        )
      }
      ext = safeExt
    } catch {
      await removeUploadDir(dir)
      return NextResponse.json({ error: "Keine gültige Bilddatei", code: "invalid_image" }, { status: 400 })
    }

    const originalName = `${uuid}-original.${ext}`
    const originalFsPath = join(dir, originalName)
    await rename(tmpPath, originalFsPath)
    const filePath = `/media/${uuid}/${originalName}`

    const thumbName = `${uuid}-thumb.webp`
    let thumbPath = filePath
    try {
      const sharp = (await import("sharp")).default
      await sharp(originalFsPath)
        .rotate()
        .resize({ width: 400, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(join(dir, thumbName))
      thumbPath = `/media/${uuid}/${thumbName}`
    } catch (err) {
      logWarn("[upload] sharp thumbnail failed, using original:", err)
    }

    if (entryId && process.env.DATABASE_URL) {
      return attachOrFail(
        { entryId, type: "photo", filePath, thumbnailPath: thumbPath, durationSeconds: null, clientMediaId, uploadDir: dir },
        (row) => ({ id: row.id, filePath: row.filePath, thumbnailPath: row.thumbnailPath, type: "photo" })
      )
    }

    return NextResponse.json({ filePath, thumbnailPath: thumbPath, type: "photo" }, { status: 201 })
  }

  // ── Video / Audio path ───────────────────────────────────────────────────
  // Extension derived from the explicit MIME allowlist (content validated by ffprobe below)
  // Stream directly to disk — never buffer 100 MB video into heap
  const ext = safeExtFromMime(contentType)!
  const originalName = `${uuid}-original.${ext}`
  const originalFsPath = join(dir, originalName)
  try {
    await saveBodyToDisk(body, originalFsPath, maxBytes)
  } catch (err) {
    await removeUploadDir(dir)
    if (err instanceof UploadTooLargeError) return tooLarge(mediaType)
    throw err
  }
  const filePath = `/media/${uuid}/${originalName}`

  // Content-Validierung analog zum sharp-Gate beim Foto-Pfad: der MIME-Header
  // ist Client-gesetzt — beliebige Bytes mit video/*-Header wurden vorher
  // dauerhaft gespeichert und mit Video-Content-Type ausgeliefert. "unknown"
  // (ffmpeg fehlt/Timeout) bleibt fail-open.
  if (await probeMediaStreams(originalFsPath, mediaType) === "invalid") {
    await removeUploadDir(dir)
    return NextResponse.json(
      { error: "Keine gültige Video-/Audiodatei", code: "invalid_media_content" },
      { status: 400 }
    )
  }

  if (mediaType === "video") {
    // Synchronous poster extraction (falls back to null on ffmpeg failure)
    const posterName = `${uuid}-poster.webp`
    const posterFsPath = join(dir, posterName)
    const posterWebPath = `/media/${uuid}/${posterName}`
    const posterResult = await extractPoster(originalFsPath, posterFsPath)
    const thumbnailPath = posterResult ? posterWebPath : null

    const durationSeconds = await probeDuration(originalFsPath)

    if (entryId && process.env.DATABASE_URL) {
      return attachOrFail(
        { entryId, type: "video", filePath, thumbnailPath, durationSeconds, clientMediaId, uploadDir: dir },
        (row) => {
          if (!row.reused) {
            // Detached best-effort loop-clip; stores web path in preview_path via dbPath arg
            const loopName = `${uuid}-loop.webp`
            const loopFsPath = join(dir, loopName)
            const loopWebPath = `/media/${uuid}/${loopName}`
            generateLoopClip(originalFsPath, loopFsPath, row.id, loopWebPath)
          }
          return { id: row.id, filePath: row.filePath, thumbnailPath: row.thumbnailPath, type: "video" }
        }
      )
    }

    return NextResponse.json({ filePath, thumbnailPath, type: "video" }, { status: 201 })
  }

  // ── Audio ────────────────────────────────────────────────────────────────
  const durationSeconds = await probeDuration(originalFsPath)

  if (entryId && process.env.DATABASE_URL) {
    return attachOrFail(
      { entryId, type: "audio", filePath, thumbnailPath: null, durationSeconds, clientMediaId, uploadDir: dir },
      (row) => ({ id: row.id, filePath: row.filePath, type: "audio" })
    )
  }

  return NextResponse.json({ filePath, type: "audio" }, { status: 201 })
}
