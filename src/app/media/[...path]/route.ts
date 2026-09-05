import { NextRequest, NextResponse } from "next/server"
import { stat } from "fs/promises"
import { join, resolve, extname } from "path"
import { isPathSafe } from "@/lib/media-security"
import { resolveRange, createMediaStream } from "@/lib/media-stream"

// Resolved once at module load — stable for the lifetime of the process
const MEDIA_BASE = resolve(join(process.cwd(), "public", "media"))

const CONTENT_TYPES: Record<string, string> = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".webp": "image/webp",
  ".gif":  "image/gif",
  ".mp4":  "video/mp4",
  ".mov":  "video/quicktime",
  ".m4v":  "video/mp4",
  ".mp3":  "audio/mpeg",
  ".m4a":  "audio/mp4",
  ".aac":  "audio/aac",
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params

  // ── Security: prevent path traversal attacks ─────────────────────────────
  if (!isPathSafe(MEDIA_BASE, path)) {
    return new NextResponse(null, { status: 403 })
  }
  const filePath = resolve(join(MEDIA_BASE, ...path))

  // ── Check file exists and get size ────────────────────────────────────────
  let fileSize: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return new NextResponse(null, { status: 404 })
    fileSize = info.size
  } catch {
    return new NextResponse(null, { status: 404 })
  }

  const ext = extname(filePath).toLowerCase()
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream"
  const supportsRanges = /\.(mp4|mov|m4v|mp3|m4a|aac)$/.test(ext)

  // ── Resolve range (or full-file offsets) ─────────────────────────────────
  const rangeHeader = req.headers.get("range")
  const { start, end, isRange, unsatisfiable } = resolveRange(rangeHeader, fileSize, supportsRanges)

  // Range entirely beyond EOF → 416 statt die komplette Datei zu liefern
  // (Video-Player, die hinter das Dateiende seeken, zögen sonst 100 MB voll).
  if (unsatisfiable) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      },
    })
  }

  // ── Stream only the requested byte range ──────────────────────────────────
  // createMediaStream uses fs.createReadStream({ start, end }) so the kernel
  // reads only the requested bytes — memory usage is flat regardless of file
  // size. This prevents OOM on 100 MB+ videos on the Pi 4.
  if (isRange) {
    const chunk = end - start + 1
    return new NextResponse(createMediaStream(filePath, start, end), {
      status: 206,
      headers: {
        "Content-Type":   contentType,
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(chunk),
        "Accept-Ranges":  "bytes",
        // no-store wie der 200-Pfad — auch Video-Segmente sind Journal-Inhalt
        // und dürfen den HTTP-Disk-Cache nie erreichen (Vault P2/W-03).
        "Cache-Control":  "private, no-store",
      },
    })
  }

  // ── Full file response ────────────────────────────────────────────────────
  return new NextResponse(createMediaStream(filePath, 0, fileSize - 1), {
    status: 200,
    headers: {
      "Content-Type":   contentType,
      "Content-Length": String(fileSize),
      // Nur behaupten, was die Route für diesen Dateityp wirklich tut —
      // für Bilder werden Range-Header ignoriert.
      "Accept-Ranges":  supportsRanges ? "bytes" : "none",
      // HTTP-Cache-Leck (Gerätetest §2, 23.08.): public/immutable legte jedes
      // online angesehene Foto bis zu 1 Jahr UNVERSCHLÜSSELT in den Disk-Cache
      // des Browsers — am verschlüsselten Pin-Cache (Vault P2/W-03) vorbei.
      // Journal-Inhalt beantwortet der Browser nur aus Netz oder SW-Pfad.
      "Cache-Control":  "private, no-store",
    },
  })
}
