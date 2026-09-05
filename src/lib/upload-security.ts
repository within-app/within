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

// Explicit per-type MIME allowlists — NO broad video/* or audio/* wildcards
export const ALLOWED_VIDEO_MIMES = ["video/mp4", "video/quicktime"] as const
export const ALLOWED_AUDIO_MIMES = ["audio/mpeg", "audio/mp4", "audio/aac"] as const

const MIME_EXT: Record<string, string> = {
  "video/mp4":       "mp4",
  "video/quicktime": "mov",
  "audio/mpeg":      "mp3",
  "audio/mp4":       "m4a",
  "audio/aac":       "aac",
}

export type UploadMediaType = "photo" | "video" | "audio"

/**
 * Maps an allowed video/audio MIME type to a safe file extension.
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
  if (mime.startsWith("image/")) return "photo"
  return null
}

// Per-type size limits — ENV-tunable
const MAX_VIDEO_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB ?? "100", 10)
const MAX_AUDIO_MB = parseInt(process.env.MAX_AUDIO_SIZE_MB ?? "50",  10)
const MAX_IMAGE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB ?? "20",  10)

export function getMaxBytesForType(type: UploadMediaType): number {
  if (type === "video") return MAX_VIDEO_MB * 1024 * 1024
  if (type === "audio") return MAX_AUDIO_MB * 1024 * 1024
  return MAX_IMAGE_MB * 1024 * 1024
}

export function getMaxMBForType(type: UploadMediaType): number {
  if (type === "video") return MAX_VIDEO_MB
  if (type === "audio") return MAX_AUDIO_MB
  return MAX_IMAGE_MB
}
