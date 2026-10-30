// Erlaubte Bildformate laut sharp-Ausgabe
const ALLOWED_FORMATS = ["jpeg", "png", "webp", "gif"] as const
type AllowedFormat = (typeof ALLOWED_FORMATS)[number]

const FORMAT_TO_EXT: Record<AllowedFormat, string> = {
  jpeg: "jpg",
  png:  "png",
  webp: "webp",
  gif:  "gif",
}

/**
 * Gibt die sichere Datei-Extension basierend auf dem sharp-Format zurück.
 * Gibt null zurück wenn das Format nicht erlaubt ist.
 * Niemals den Client-Dateinamen verwenden — nur diesen Rückgabewert.
 */
export function safeExtFromFormat(format: string | undefined): string | null {
  if (!format || !ALLOWED_FORMATS.includes(format as AllowedFormat)) return null
  return FORMAT_TO_EXT[format as AllowedFormat]
}

// Explicit per-type MIME allowlists — NO broad video/*, audio/* or application/* wildcards
export const ALLOWED_VIDEO_MIMES = ["video/mp4", "video/quicktime"] as const
export const ALLOWED_AUDIO_MIMES = ["audio/mpeg", "audio/mp4", "audio/aac"] as const
export const ALLOWED_PDF_MIMES   = ["application/pdf"] as const

const MIME_EXT: Record<string, string> = {
  "video/mp4":       "mp4",
  "video/quicktime": "mov",
  "audio/mpeg":      "mp3",
  "audio/mp4":       "m4a",
  "audio/aac":       "aac",
  "application/pdf": "pdf",
}

export type UploadMediaType = "photo" | "video" | "audio" | "pdf"

/**
 * Maps an allowed video/audio/PDF MIME type to a safe file extension.
 * Returns null for unrecognised or image MIME types (use safeExtFromFormat for images).
 */
export function safeExtFromMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null
}

/**
 * Determines the media type from the client-supplied MIME type.
 * Returns null for non-allowlisted types (images pass through to sharp validation).
 */
export function detectMediaTypeFromMime(mime: string): UploadMediaType | null {
  if ((ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime)) return "video"
  if ((ALLOWED_AUDIO_MIMES as readonly string[]).includes(mime)) return "audio"
  if ((ALLOWED_PDF_MIMES as readonly string[]).includes(mime)) return "pdf"
  if (mime.startsWith("image/")) return "photo"
  return null
}

// Per-type size limits — ENV-tunable
const MAX_VIDEO_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB ?? "100", 10)
const MAX_AUDIO_MB = parseInt(process.env.MAX_AUDIO_SIZE_MB ?? "50",  10)
const MAX_IMAGE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB ?? "20",  10)
const MAX_PDF_MB   = parseInt(process.env.MAX_PDF_SIZE_MB   ?? "50",  10)

export function getMaxBytesForType(type: UploadMediaType): number {
  return getMaxMBForType(type) * 1024 * 1024
}

export function getMaxMBForType(type: UploadMediaType): number {
  if (type === "video") return MAX_VIDEO_MB
  if (type === "audio") return MAX_AUDIO_MB
  if (type === "pdf")   return MAX_PDF_MB
  return MAX_IMAGE_MB
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// Within never decodes a PDF (no poppler, no pdf.js on the server — the
// browser's own sandboxed viewer renders it). The only content check is the
// file header: ISO 32000 requires "%PDF-" at offset 0. Everything else that
// arrives with an application/pdf MIME is rejected, like sharp rejects a
// non-image with an image/* MIME.

/** Bytes the header check needs — read only this much of the stored file. */
export const PDF_HEADER_BYTES = 5

export function isPdfHeader(head: Uint8Array): boolean {
  if (head.byteLength < PDF_HEADER_BYTES) return false
  // "%PDF-" — compared byte-wise so no decoder or sniffing library is involved.
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
}

/** Display name cap (DB column is TEXT; the cap is a sanity limit, not a format). */
export const MAX_ORIGINAL_NAME_LENGTH = 200

/**
 * Sanitises a client-supplied file name for DISPLAY and the export manifest.
 * It never becomes a path on disk (files are stored as <uuid>-original.<ext>):
 * only the last path segment survives, control characters are dropped, the
 * length is capped. Returns null when nothing usable remains.
 */
export function safeOriginalName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const base = raw.split(/[\\/]/).pop() ?? ""
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return null
  return cleaned.slice(0, MAX_ORIGINAL_NAME_LENGTH)
}
