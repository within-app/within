import { createWriteStream } from "fs"
import { open } from "fs/promises"
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

/**
 * Reads a body to its end and throws the bytes away, one chunk at a time. For
 * answers that store nothing: replying while the client still sends gets the
 * connection cut at Caddy (WebKit over HTTP/2 sees the status but cannot read the
 * answer, HTTP/1.1 clients get a reset). Never rejects, a client that broke off
 * reads no answer anyway. The size gate in the route has already run.
 */
export async function discardBody(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const reader = body.getReader()
    while (!(await reader.read()).done) { /* discard */ }
  } catch {
    // client gone
  }
}

/**
 * Reads the first `bytes` of a file — for content checks that need only the
 * header (PDF magic). Opens, reads one small buffer, closes; never the file.
 */
export async function readFileHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const buf = new Uint8Array(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
