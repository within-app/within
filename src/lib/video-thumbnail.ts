import { spawn } from "child_process"
import { unlink } from "fs/promises"
import { db } from "@/lib/db"
import { logError, logWarn } from "@/lib/logger"

const MAX_POSTER_DIM = 400 // px width, height auto
const LOOP_CLIP_SECS = 3   // loop-clip target duration

// Hard timeouts for ffprobe/ffmpeg processes (Pi 4 worst-case budgets)
const PROBE_TIMEOUT_MS = 10_000   // ffprobe: metadata read only
const POSTER_TIMEOUT_MS = 8_000   // ffmpeg: single frame, in upload request path
const LOOP_TIMEOUT_MS = 120_000   // ffmpeg: 3-second animated clip, background

function ffmpegBin(): string { return process.env.FFMPEG_PATH ?? "ffmpeg" }
function ffprobeBin(): string { return process.env.FFPROBE_PATH ?? "ffprobe" }

/**
 * Spawn a command and resolve with stdout; rejects on non-zero exit, error, or timeout.
 * On timeout, sends SIGKILL before rejecting so the process does not linger on Pi 4.
 */
function run(cmd: string, args: string[], timeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let settled = false

    const settle = (fn: () => void) => {
      if (!settled) { settled = true; clearTimeout(timer); fn() }
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          settle(() => {
            proc.kill("SIGKILL")
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
          })
        }, timeoutMs)
      : undefined

    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    proc.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    proc.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf8"))
        } else {
          reject(
            new Error(
              `${cmd} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`
            )
          )
        }
      })
    })
    proc.on("error", (e) => settle(() => reject(e)))
  })
}

/**
 * ffprobe → duration of media file in integer seconds.
 * Returns null if ffprobe is absent or no duration stream is found.
 * Logs loudly on failure (never silent).
 */
export async function probeDuration(mediaPath: string): Promise<number | null> {
  try {
    const raw = await run(ffprobeBin(), [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      mediaPath,
    ], PROBE_TIMEOUT_MS)
    const data = JSON.parse(raw) as { streams?: { duration?: string }[] }
    for (const s of data.streams ?? []) {
      const secs = parseFloat(s.duration ?? "")
      if (!isNaN(secs) && secs > 0) return Math.round(secs)
    }
    return null
  } catch (err) {
    logError("[video-thumbnail] probeDuration failed", err)
    return null
  }
}

export type ProbeVerdict = "valid" | "invalid" | "unknown"

/**
 * Content validation for video/audio uploads:
 * "invalid" NUR, wenn ffprobe die Datei gelesen hat und keinen passenden
 * Stream findet (oder sie gar nicht parsen kann). Fehlendes Tooling (ENOENT)
 * oder ein Timeout ist "unknown" — fail-open, damit ein Setup ohne ffmpeg
 * Uploads nicht pauschal blockiert.
 */
export async function probeMediaStreams(
  mediaPath: string,
  kind: "video" | "audio",
): Promise<ProbeVerdict> {
  try {
    const raw = await run(ffprobeBin(), [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      mediaPath,
    ], PROBE_TIMEOUT_MS)
    const data = JSON.parse(raw) as { streams?: { codec_type?: string }[] }
    const hasStream = (t: string) => (data.streams ?? []).some((s) => s.codec_type === t)
    // Ein Video ohne Video-Stream (reine Audiodatei mit video/mp4-Header) ist
    // ebenso invalid wie beliebige Bytes mit Audio-MIME.
    return hasStream(kind) ? "valid" : "invalid"
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      logWarn("[video-thumbnail] ffprobe not available — content validation skipped", err)
      return "unknown"
    }
    if (err instanceof Error && err.message.includes("timed out")) {
      logError("[video-thumbnail] probeMediaStreams timed out", err)
      return "unknown"
    }
    // ffprobe lief und konnte die Datei nicht lesen → kein gültiges Medium.
    logError("[video-thumbnail] probeMediaStreams: unreadable media file", err)
    return "invalid"
  }
}

/**
 * Single-frame poster extraction, awaited in the upload request.
 * Tight timeout (POSTER_TIMEOUT_MS) so the upload never blocks on a broken file.
 * Returns outputPath on success, null on failure (caller falls back to generic icon).
 */
export async function extractPoster(
  videoPath: string,
  outputPath: string
): Promise<string | null> {
  try {
    const duration = (await probeDuration(videoPath)) ?? 0
    const seekSec = Math.floor(duration * 0.1)
    await run(ffmpegBin(), [
      "-ss", String(seekSec),
      "-i", videoPath,
      "-vframes", "1",
      "-vf", `scale=${MAX_POSTER_DIM}:-1`,
      "-f", "webp",
      "-y",
      outputPath,
    ], POSTER_TIMEOUT_MS)
    return outputPath
  } catch (err) {
    logError("[video-thumbnail] extractPoster failed", err)
    return null
  }
}

/**
 * Best-effort background loop-clip generator.
 * Spawns ffmpeg detached; returns immediately (fire-and-forget).
 * A hard kill timer (LOOP_TIMEOUT_MS) ensures a broken video cannot leave an
 * unkillable ffmpeg process consuming CPU/RAM on the Pi 4.
 * On ffmpeg success writes preview_path on the media row.
 * Logs loudly on any failure — never throws, never silently drops.
 *
 * @param outputPath  Filesystem path for ffmpeg to write the animated WebP.
 * @param dbPath      Web-accessible path stored in preview_path (defaults to outputPath).
 */
export function generateLoopClip(
  videoPath: string,
  outputPath: string,
  mediaId: string,
  dbPath?: string
): void {
  const proc = spawn(
    ffmpegBin(),
    [
      "-i", videoPath,
      "-t", String(LOOP_CLIP_SECS),
      "-vf", `scale=${MAX_POSTER_DIM}:-1`,
      "-loop", "0",  // animated WebP: loop forever
      "-an",         // mute
      "-y",
      outputPath,
    ],
    { stdio: "ignore" }
  )

  // Hard kill: if ffmpeg hangs on a broken/truncated file, clean it up
  const killTimer = setTimeout(() => {
    proc.kill("SIGKILL")
    logError(
      "[video-thumbnail] generateLoopClip timed out",
      new Error(`ffmpeg exceeded ${LOOP_TIMEOUT_MS}ms on ${videoPath}`)
    )
  }, LOOP_TIMEOUT_MS)

  proc.on("error", (err) => {
    clearTimeout(killTimer)
    logError("[video-thumbnail] generateLoopClip spawn error", err)
  })

  proc.on("close", (code) => {
    clearTimeout(killTimer)
    if (code !== 0) {
      logError(
        "[video-thumbnail] generateLoopClip failed",
        new Error(`ffmpeg exited ${code}`)
      )
      return
    }
    db.query("UPDATE media SET preview_path = $1 WHERE id = $2", [
      dbPath ?? outputPath,
      mediaId,
    ]).then((result) => {
      if ((result.rowCount ?? 0) === 0) {
        // Media row deleted while ffmpeg was running (fire-and-forget path) —
        // without this the finished loop clip stays on disk forever, referenced
        // by nothing and invisible to the DELETE route.
        logWarn("[video-thumbnail] media row gone — removing orphaned loop clip:", mediaId)
        return unlink(outputPath).catch(() => {})
      }
    }).catch((err) =>
      logError("[video-thumbnail] generateLoopClip: DB write failed", err)
    )
  })
}
