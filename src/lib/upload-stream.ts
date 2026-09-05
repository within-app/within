import { createWriteStream } from "fs"
import { pipeline } from "stream/promises"
import { Readable } from "stream"

/**
 * Writes a Web API File (or any stream()-capable object) to disk via Node.js pipeline.
 * Never calls arrayBuffer() — safe for 100 MB video on Pi 4 (no heap spike).
 */
export async function saveFileToDisk(
  file: { stream(): ReadableStream<Uint8Array> },
  destPath: string
): Promise<void> {
  const nodeReadable = Readable.fromWeb(
    file.stream() as import("stream/web").ReadableStream<Uint8Array>
  )
  await pipeline(nodeReadable, createWriteStream(destPath))
}
