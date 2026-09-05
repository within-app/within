/**
 * video-thumbnail lib: extractPoster, generateLoopClip, probeDuration
 *
 * Tests guard on ffmpeg/ffprobe presence and verify:
 * 1. probeDuration returns integer seconds from ffprobe JSON output
 * 2. extractPoster returns poster path on success, null on failure (no throw)
 * 3. generateLoopClip fires-and-forgets: returns void, writes DB on success,
 *    logs loudly (not silently) on ffmpeg failure
 * 4. Any binary-absent (ENOENT) error is logged, never propagated
 * 5. Hard timeout + SIGKILL for hanging ffmpeg/ffprobe processes
 *
 * No real journal content used (Constraint D).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSpawn = vi.fn()
vi.mock("child_process", () => ({ spawn: mockSpawn }))

const mockDbQuery = vi.fn().mockResolvedValue({ rows: [] })
vi.mock("@/lib/db", () => ({ db: { query: mockDbQuery } }))

const mockLogError = vi.fn()
vi.mock("@/lib/logger", () => ({ logError: mockLogError }))

// Helper: returns a spawn-like child-process mock
type ProcOpts = { exitCode?: number; stdout?: string; stderr?: string; error?: Error }
function makeProc({ exitCode = 0, stdout = "", stderr = "", error }: ProcOpts = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: () => void
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.unref = vi.fn()

  setImmediate(() => {
    if (error) {
      proc.emit("error", error)
    } else {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout))
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr))
      proc.emit("close", exitCode)
    }
  })

  return proc
}

// Helper: a proc that never emits close or error (simulates a hang)
function makeHangingProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: () => void
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.unref = vi.fn()
  return proc
}

// ── Imports (after mocks are wired) ──────────────────────────────────────────

const { probeDuration, extractPoster, generateLoopClip } = await import(
  "@/lib/video-thumbnail"
)

// ── probeDuration ─────────────────────────────────────────────────────────────

describe("probeDuration()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("parses duration from the first stream with a duration field", async () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "video", duration: "12.345" }],
    })
    mockSpawn.mockReturnValueOnce(makeProc({ stdout: json }))

    const result = await probeDuration("/tmp/clip.mp4")
    expect(result).toBe(12) // Math.round(12.345)
  })

  it("rounds fractional seconds to nearest integer", async () => {
    const json = JSON.stringify({
      streams: [{ duration: "9.7" }],
    })
    mockSpawn.mockReturnValueOnce(makeProc({ stdout: json }))

    const result = await probeDuration("/tmp/clip.mp4")
    expect(result).toBe(10)
  })

  it("skips streams without a duration, returns null when none found", async () => {
    const json = JSON.stringify({ streams: [{ codec_type: "data" }] })
    mockSpawn.mockReturnValueOnce(makeProc({ stdout: json }))

    const result = await probeDuration("/tmp/clip.mp4")
    expect(result).toBeNull()
  })

  it("returns null and logs loudly when ffprobe binary is absent (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" })
    mockSpawn.mockReturnValueOnce(makeProc({ error: enoent }))

    const result = await probeDuration("/tmp/clip.mp4")
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalledOnce()
    const [ctx] = mockLogError.mock.calls[0]
    expect(ctx).toContain("probeDuration")
  })

  it("returns null and logs loudly when ffprobe exits non-zero", async () => {
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 1, stderr: "No such file" }))

    const result = await probeDuration("/tmp/missing.mp4")
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalledOnce()
  })
})

// ── extractPoster ─────────────────────────────────────────────────────────────

describe("extractPoster()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the output path on success", async () => {
    const durationJson = JSON.stringify({ streams: [{ duration: "60" }] })
    // First spawn: ffprobe for probeDuration; second: ffmpeg for frame grab
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson }))
      .mockReturnValueOnce(makeProc({ exitCode: 0 }))

    const result = await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")
    expect(result).toBe("/tmp/poster.webp")
  })

  it("seeks to ~10% of duration", async () => {
    const durationJson = JSON.stringify({ streams: [{ duration: "100" }] })
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson }))
      .mockReturnValueOnce(makeProc({ exitCode: 0 }))

    await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")

    // Second spawn is the ffmpeg call; args[1] is the args array
    const ffmpegArgs: string[] = mockSpawn.mock.calls[1][1]
    const ssIdx = ffmpegArgs.indexOf("-ss")
    expect(ssIdx).toBeGreaterThanOrEqual(0)
    // 10% of 100s = 10s (Math.floor)
    expect(ffmpegArgs[ssIdx + 1]).toBe("10")
  })

  it("falls back to seek 0 when probeDuration returns null", async () => {
    mockSpawn
      .mockReturnValueOnce(makeProc({ error: new Error("ffprobe ENOENT") }))
      .mockReturnValueOnce(makeProc({ exitCode: 0 }))

    const result = await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")
    expect(result).toBe("/tmp/poster.webp")
    const ffmpegArgs: string[] = mockSpawn.mock.calls[1][1]
    expect(ffmpegArgs[ffmpegArgs.indexOf("-ss") + 1]).toBe("0")
  })

  it("returns null and logs loudly when ffmpeg binary is absent (ENOENT)", async () => {
    const durationJson = JSON.stringify({ streams: [{ duration: "30" }] })
    const enoent = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson }))
      .mockReturnValueOnce(makeProc({ error: enoent }))

    const result = await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalled()
    const posterCall = mockLogError.mock.calls.find(([ctx]) =>
      ctx.includes("extractPoster")
    )
    expect(posterCall).toBeTruthy()
  })

  it("returns null and logs loudly when ffmpeg exits non-zero", async () => {
    const durationJson = JSON.stringify({ streams: [{ duration: "30" }] })
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson }))
      .mockReturnValueOnce(makeProc({ exitCode: 1, stderr: "invalid data" }))

    const result = await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")
    expect(result).toBeNull()
    expect(mockLogError).toHaveBeenCalled()
  })
})

// ── generateLoopClip ──────────────────────────────────────────────────────────

describe("generateLoopClip()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns void synchronously (fire-and-forget)", () => {
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 0 }))
    const result = generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-uuid-1")
    expect(result).toBeUndefined()
  })

  it("writes preview_path to DB when ffmpeg succeeds", async () => {
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 0 }))
    generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-uuid-2")
    // Wait for setImmediate (close event) to fire
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r)) // second tick for db.query microtask
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("preview_path"),
      ["/tmp/loop.webp", "media-uuid-2"]
    )
  })

  it("logs loudly but does NOT throw when ffmpeg binary is absent (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })
    mockSpawn.mockReturnValueOnce(makeProc({ error: enoent }))

    expect(() =>
      generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-uuid-3")
    ).not.toThrow()

    await new Promise((r) => setImmediate(r))
    expect(mockLogError).toHaveBeenCalledOnce()
    expect(mockDbQuery).not.toHaveBeenCalled()
  })

  it("logs loudly but does NOT throw when ffmpeg exits non-zero", async () => {
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 1, stderr: "encoder error" }))

    expect(() =>
      generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-uuid-4")
    ).not.toThrow()

    await new Promise((r) => setImmediate(r))
    expect(mockLogError).toHaveBeenCalledOnce()
    const [ctx] = mockLogError.mock.calls[0]
    expect(ctx).toContain("generateLoopClip")
    expect(mockDbQuery).not.toHaveBeenCalled()
  })

  it("does NOT write DB when ffmpeg fails", async () => {
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 2 }))
    generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-uuid-5")
    await new Promise((r) => setImmediate(r))
    expect(mockDbQuery).not.toHaveBeenCalled()
  })
})

// ── Timeout + kill hardening ──────────────────────────────────────────────────
//
// Expected timeout constants (must match src/lib/video-thumbnail.ts):
//   PROBE_TIMEOUT_MS  = 10_000  (ffprobe: metadata read)
//   POSTER_TIMEOUT_MS =  8_000  (ffmpeg: single-frame, in upload request path)
//   LOOP_TIMEOUT_MS   = 120_000 (ffmpeg: loop clip, background)
//
// All tests use fake setTimeout only (setImmediate stays real so makeProc fires).

// ── FFMPEG_PATH / FFPROBE_PATH env-var override ───────────────────────────────
//
// ffmpegBin() returns process.env.FFMPEG_PATH ?? "ffmpeg".
// ffprobeBin() returns process.env.FFPROBE_PATH ?? "ffprobe".
// Both are read at call time, so setting the env var before the call is enough.

describe("FFMPEG_PATH + FFPROBE_PATH env-var override", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.FFMPEG_PATH
    delete process.env.FFPROBE_PATH
  })

  afterEach(() => {
    delete process.env.FFMPEG_PATH
    delete process.env.FFPROBE_PATH
  })

  it("probeDuration: uses FFPROBE_PATH when set", async () => {
    process.env.FFPROBE_PATH = "/opt/custom/ffprobe"
    const json = JSON.stringify({ streams: [{ duration: "5" }] })
    mockSpawn.mockReturnValueOnce(makeProc({ stdout: json }))

    await probeDuration("/tmp/clip.mp4")

    expect(mockSpawn.mock.calls[0][0]).toBe("/opt/custom/ffprobe")
  })

  it("probeDuration: falls back to 'ffprobe' when FFPROBE_PATH is unset", async () => {
    const json = JSON.stringify({ streams: [{ duration: "5" }] })
    mockSpawn.mockReturnValueOnce(makeProc({ stdout: json }))

    await probeDuration("/tmp/clip.mp4")

    expect(mockSpawn.mock.calls[0][0]).toBe("ffprobe")
  })

  it("extractPoster: uses FFMPEG_PATH for the ffmpeg frame-grab spawn", async () => {
    process.env.FFMPEG_PATH = "/opt/custom/ffmpeg"
    const durationJson = JSON.stringify({ streams: [{ duration: "30" }] })
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson })) // ffprobe
      .mockReturnValueOnce(makeProc({ exitCode: 0 }))          // ffmpeg

    await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")

    // spawn call[0] = ffprobe, call[1] = ffmpeg
    expect(mockSpawn.mock.calls[1][0]).toBe("/opt/custom/ffmpeg")
  })

  it("extractPoster: falls back to 'ffmpeg' when FFMPEG_PATH is unset", async () => {
    const durationJson = JSON.stringify({ streams: [{ duration: "10" }] })
    mockSpawn
      .mockReturnValueOnce(makeProc({ stdout: durationJson }))
      .mockReturnValueOnce(makeProc({ exitCode: 0 }))

    await extractPoster("/tmp/video.mp4", "/tmp/poster.webp")

    expect(mockSpawn.mock.calls[1][0]).toBe("ffmpeg")
  })

  it("generateLoopClip: uses FFMPEG_PATH when set", async () => {
    process.env.FFMPEG_PATH = "/opt/custom/ffmpeg"
    mockSpawn.mockReturnValueOnce(makeProc({ exitCode: 0 }))

    generateLoopClip("/tmp/video.mp4", "/tmp/loop.webp", "media-env-test")

    expect(mockSpawn.mock.calls[0][0]).toBe("/opt/custom/ffmpeg")
  })
})

// ── Timeout + kill hardening ──────────────────────────────────────────────────
//
// Expected timeout constants (must match src/lib/video-thumbnail.ts):
//   PROBE_TIMEOUT_MS  = 10_000  (ffprobe: metadata read)
//   POSTER_TIMEOUT_MS =  8_000  (ffmpeg: single-frame, in upload request path)
//   LOOP_TIMEOUT_MS   = 120_000 (ffmpeg: loop clip, background)
//
// All tests use fake setTimeout only (setImmediate stays real so makeProc fires).

describe("timeout + kill hardening", () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("probeDuration: kills hanging ffprobe after 10 s and returns null", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const proc = makeHangingProc()
    mockSpawn.mockReturnValueOnce(proc)

    const resultPromise = probeDuration("/tmp/hang.mp4")

    await vi.advanceTimersByTimeAsync(10_001)

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
    await expect(resultPromise).resolves.toBeNull()
    expect(mockLogError).toHaveBeenCalled()
  })

  it("extractPoster: kills hanging ffmpeg after 8 s and returns null", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    // ffprobe fails immediately (via real setImmediate) → seek falls back to 0
    const enoent = Object.assign(new Error("ffprobe ENOENT"), { code: "ENOENT" })
    const hangingProc = makeHangingProc()
    mockSpawn
      .mockReturnValueOnce(makeProc({ error: enoent }))
      .mockReturnValueOnce(hangingProc)

    const resultPromise = extractPoster("/tmp/hang.mp4", "/tmp/poster.webp")

    // Let real setImmediate fire (ffprobe error → probeDuration resolves null)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Advance past poster timeout
    await vi.advanceTimersByTimeAsync(8_001)

    expect(hangingProc.kill).toHaveBeenCalledWith("SIGKILL")
    await expect(resultPromise).resolves.toBeNull()
  })

  it("generateLoopClip: kills hanging ffmpeg after 120 s and logs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const proc = makeHangingProc()
    mockSpawn.mockReturnValueOnce(proc)

    generateLoopClip("/tmp/hang.mp4", "/tmp/loop.webp", "media-uuid-hang")

    await vi.advanceTimersByTimeAsync(120_001)

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
    expect(mockLogError).toHaveBeenCalled()
    const [ctx] = mockLogError.mock.calls[0]
    expect(ctx).toContain("generateLoopClip")
  })
})
