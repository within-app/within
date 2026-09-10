import { createWriteStream } from "fs"
import { pipeline } from "stream/promises"
import { Readable } from "stream"

/** Thrown when the body outgrows maxBytes — the fail-safe behind content-length. */
export class UploadTooLargeError extends Error {
  constructor() { super("upload body exceeds the allowed size") }
}

/**
 * Streams a raw request body to disk via Node.js pipeline. Never buffers —
 * safe for 100 MB video on Pi 4 (no heap spike). Counts bytes and aborts with
 * UploadTooLargeError once the body exceeds maxBytes. Resolves with the byte
 * count. `flush: true` fsyncs before the promise settles.
 */
export async function saveBodyToDisk(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number
): Promise<number> {
  let total = 0
  await pipeline(
    Readable.fromWeb(body as import("stream/web").ReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        total += chunk.byteLength
        if (total > maxBytes) throw new UploadTooLargeError()
        yield chunk
      }
    },
    createWriteStream(destPath, { flush: true })
  )
  return total
}
