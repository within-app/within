import { PassThrough } from "stream"
import { ReadableStream as NodeReadableStream } from "stream/web"
import { ZipArchive } from "archiver"

interface ExportMediaFile {
  absPath: string
  zipName: string
}

export function buildExportLocationWeather(row: {
  location_name: string | null; location_lat: number | null; location_lng: number | null
  weather_icon: string | null; weather_description: string | null; weather_temp_celsius: number | null
}) {
  return {
    location: row.location_name
      ? { name: row.location_name, latitude: row.location_lat, longitude: row.location_lng }
      : null,
    weather: row.weather_icon
      ? { description: row.weather_description, temperatureCelsius: row.weather_temp_celsius, icon: row.weather_icon }
      : null,
  }
}

/**
 * Create a streaming ZIP archive as a Web ReadableStream.
 *
 * Pipes archiver directly into a PassThrough → Web ReadableStream so the ZIP
 * is never assembled in memory. The caller should pass this stream as the
 * NextResponse body without buffering it. This prevents OOM on GB-sized
 * journals on the Pi 4.
 *
 * Note: Content-Length cannot be set upfront (size is unknown until the
 * archive finalises), but browsers handle streaming downloads correctly
 * without it.
 */
export function createExportArchiveStream(
  jsonFileName: string,
  jsonContent: string,
  mediaFiles: ExportMediaFile[]
): ReadableStream {
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const passThrough = new PassThrough()

  // Propagate archiver errors into the stream so the consumer sees them
  archive.on("error", (err) => passThrough.destroy(err))
  archive.pipe(passThrough)

  archive.append(jsonContent, { name: jsonFileName })
  for (const { absPath, zipName } of mediaFiles) {
    archive.file(absPath, { name: zipName })
  }

  // finalize() starts the archiving; the "end" event propagates through the
  // pipe and closes the PassThrough naturally.
  archive.finalize()

  // ReadableStream.from, not Readable.toWeb — same cancel race as in
  // media-stream.ts (client aborts the download → enqueue on a closed controller).
  return NodeReadableStream.from(passThrough) as ReadableStream
}
