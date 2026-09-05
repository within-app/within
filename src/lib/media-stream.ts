import { createReadStream } from "fs"
import { Readable } from "stream"

/**
 * Parse a Range header against a known file size.
 *
 * Returns the resolved byte offsets and whether this is truly a range
 * request (i.e. the client sent a Range header AND the route supports it).
 * When isRange is false, start/end still cover the full file so callers
 * can use them unconditionally.
 */
export function resolveRange(
  rangeHeader: string | null,
  fileSize: number,
  supportsRanges: boolean
): { start: number; end: number; isRange: boolean; unsatisfiable?: boolean } {
  if (!rangeHeader || !supportsRanges) {
    return { start: 0, end: fileSize - 1, isRange: false }
  }
  const rangeValue = rangeHeader.replace(/bytes=/, "")
  // Multi-range ("bytes=0-100,200-300") is valid per RFC 7233 but was mangled
  // by the split below (parseInt("100,200") → 100, rest silently dropped).
  // A server MAY ignore Range — answer with the full file instead of a wrong slice.
  if (rangeValue.includes(",")) {
    return { start: 0, end: fileSize - 1, isRange: false }
  }
  const [startStr, endStr] = rangeValue.split("-")
  let start: number
  let end: number
  if (startStr === "") {
    // RFC-7233 suffix-range e.g. "bytes=-500" = last 500 bytes
    const suffixLength = parseInt(endStr, 10)
    start = Math.max(fileSize - suffixLength, 0)
    end = fileSize - 1
  } else {
    start = parseInt(startStr, 10)
    end = endStr ? parseInt(endStr, 10) : fileSize - 1
  }
  // Guard against malformed headers (e.g. "bytes=abc-") — fall back to full-file
  // rather than passing NaN to createReadStream which would crash with a 500.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
    return { start: 0, end: fileSize - 1, isRange: false }
  }
  // Start beyond EOF: RFC 7233 says 416, not a full 200 — a video player
  // polling past the end would otherwise pull the entire 100-MB file.
  // (Checked before the start>end guard: "bytes=<beyond-EOF>-" resolves end to
  // fileSize-1 and would otherwise be misread as merely malformed.)
  if (start >= fileSize) {
    return { start: 0, end: fileSize - 1, isRange: false, unsatisfiable: true }
  }
  if (start > end) {
    return { start: 0, end: fileSize - 1, isRange: false }
  }
  end = Math.min(end, fileSize - 1)
  return { start, end, isRange: true }
}

/**
 * Create a Web ReadableStream from a file, reading only [start, end] bytes.
 *
 * Uses fs.createReadStream with explicit start/end so the OS only fetches
 * the requested region — heap usage is proportional to the chunk size,
 * not the file size. This is the correct primitive for Range responses
 * and prevents OOM on large video files on the Pi 4.
 */
export function createMediaStream(
  filePath: string,
  start: number,
  end: number
): ReadableStream {
  const nodeStream = createReadStream(filePath, { start, end })
  return Readable.toWeb(nodeStream) as ReadableStream
}
