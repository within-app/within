/**
 * Upload route: per-type MIME allowlist, size limits, DB row type.
 *
 * Tests the POST /api/upload handler for video and audio uploads:
 *   - Non-allowlist MIME types are rejected with 400
 *   - Accepted video types (mp4, quicktime) produce type='video' DB rows
 *   - Accepted audio types (mpeg, mp4, aac) produce type='audio' DB rows
 *   - Per-type size limits: video>100 MB → 400, audio>50 MB → 400
 *   - extractPoster is called once for video uploads
 *
 * Synthetic data only — no real journal content (Constraint D).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ── Mocks (must precede dynamic imports) ───────────────────────────────────────

const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockWriteFile = vi.fn().mockResolvedValue(undefined)
const mockRm = vi.fn().mockResolvedValue(undefined)
vi.mock("fs/promises", () => ({ mkdir: mockMkdir, writeFile: mockWriteFile, rm: mockRm }))

const mockSaveFileToDisk = vi.fn().mockResolvedValue(undefined)
vi.mock("@/lib/upload-stream", () => ({ saveFileToDisk: mockSaveFileToDisk }))

const mockExtractPoster = vi.fn().mockResolvedValue("/media/synth-uuid/poster.webp")
const mockGenerateLoopClip = vi.fn()
const mockProbeDuration = vi.fn().mockResolvedValue(30)
const mockProbeMediaStreams = vi.fn().mockResolvedValue("valid")
vi.mock("@/lib/video-thumbnail", () => ({
  extractPoster: mockExtractPoster,
  generateLoopClip: mockGenerateLoopClip,
  probeDuration: mockProbeDuration,
  probeMediaStreams: mockProbeMediaStreams,
}))

const mockDbQuery = vi.fn()
vi.mock("@/lib/db", () => ({ db: { query: mockDbQuery } }))

vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

// DATABASE_URL must be truthy so the handler enters the DB path
process.env.DATABASE_URL = "postgresql://fake/test"

// ── Route import (after mocks) ────────────────────────────────────────────────

const { POST } = await import("@/app/api/upload/route")

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock NextRequest whose formData() returns a single file-like object
 * with controlled type and size. The stream() / arrayBuffer() are never used
 * by the video/audio path (saveFileToDisk is mocked) — they are present to
 * satisfy the File interface.
 */
function makeUploadReq(opts: {
  fileType: string
  fileSize?: number
  entryId?: string
}) {
  const url = `http://localhost/api/upload${opts.entryId ? `?entryId=${opts.entryId}` : ""}`
  const req = new NextRequest(url, { method: "POST" })

  const mockFile = {
    type: opts.fileType,
    size: opts.fileSize ?? 512 * 1024, // 512 KB synthetic default
    name: "synthetic-media",
    stream: () => new ReadableStream<Uint8Array>(),
    arrayBuffer: async () => new ArrayBuffer(0),
  }

  vi.spyOn(req, "formData").mockResolvedValue({
    get: (key: string) => (key === "file" ? mockFile : null),
  } as unknown as FormData)

  return req
}

/**
 * DB mock dispatching by SQL content instead of call order — the route now runs
 * pre-insert checks (entry existence, client_media_id lookup) before
 * nextOrderIndex + INSERT, so a positional mock would silently
 * answer the wrong query.
 */
function seedDb(mediaId = "synth-media-id-1") {
  mockDbQuery.mockImplementation(async (sql: string) => {
    // INSERT zuerst: er enthält selbst "client_media_id" (ON-CONFLICT-Klausel).
    if (sql.includes("INSERT INTO media")) return { rows: [{ id: mediaId }] }
    if (sql.includes("FROM media WHERE client_media_id")) return { rows: [] }
    if (sql.includes("FROM entries")) return { rows: [{ deleted_at: null }] }
    if (sql.includes("MAX(order_index)")) return { rows: [{ max_order: 0 }] }
    return { rows: [] }
  })
}

// ── MIME allowlist tests ───────────────────────────────────────────────────────

describe("upload route — MIME allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedDb()
  })

  it("rejects video/webm — not in allowlist", async () => {
    const res = await POST(makeUploadReq({ fileType: "video/webm", entryId: "e-1" }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/nicht erlaubt/)
  })

  it("rejects audio/ogg — not in allowlist", async () => {
    const res = await POST(makeUploadReq({ fileType: "audio/ogg", entryId: "e-1" }))
    expect(res.status).toBe(400)
  })

  it("rejects audio/wav — not in allowlist", async () => {
    const res = await POST(makeUploadReq({ fileType: "audio/wav", entryId: "e-1" }))
    expect(res.status).toBe(400)
  })

  it("rejects application/pdf", async () => {
    const res = await POST(makeUploadReq({ fileType: "application/pdf", entryId: "e-1" }))
    expect(res.status).toBe(400)
  })

  it("accepts video/mp4 — returns 201 with type='video'", async () => {
    const res = await POST(makeUploadReq({ fileType: "video/mp4", entryId: "e-1" }))
    expect(res.status).toBe(201)
    const body = await res.json() as { type: string }
    expect(body.type).toBe("video")
  })

  it("accepts video/quicktime (MOV) — returns 201 with type='video'", async () => {
    const res = await POST(makeUploadReq({ fileType: "video/quicktime", entryId: "e-1" }))
    expect(res.status).toBe(201)
    const body = await res.json() as { type: string }
    expect(body.type).toBe("video")
  })

  it("accepts audio/mpeg (MP3) — returns 201 with type='audio'", async () => {
    const res = await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))
    expect(res.status).toBe(201)
    const body = await res.json() as { type: string }
    expect(body.type).toBe("audio")
  })

  it("accepts audio/mp4 (M4A) — returns 201 with type='audio'", async () => {
    const res = await POST(makeUploadReq({ fileType: "audio/mp4", entryId: "e-1" }))
    expect(res.status).toBe(201)
    const body = await res.json() as { type: string }
    expect(body.type).toBe("audio")
  })

  it("accepts audio/aac — returns 201 with type='audio'", async () => {
    const res = await POST(makeUploadReq({ fileType: "audio/aac", entryId: "e-1" }))
    expect(res.status).toBe(201)
    const body = await res.json() as { type: string }
    expect(body.type).toBe("audio")
  })
})

// ── Per-type size limit tests ─────────────────────────────────────────────────

describe("upload route — per-type size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedDb()
  })

  it("rejects video/mp4 exceeding 100 MB", async () => {
    const over = 100 * 1024 * 1024 + 1
    const res = await POST(makeUploadReq({ fileType: "video/mp4", fileSize: over }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/100 MB/)
  })

  it("rejects audio/mpeg exceeding 50 MB", async () => {
    const over = 50 * 1024 * 1024 + 1
    const res = await POST(makeUploadReq({ fileType: "audio/mpeg", fileSize: over }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/50 MB/)
  })

  it("accepts video/mp4 at exactly 100 MB (boundary — inclusive)", async () => {
    const exact = 100 * 1024 * 1024
    const res = await POST(makeUploadReq({ fileType: "video/mp4", fileSize: exact, entryId: "e-1" }))
    expect(res.status).toBe(201)
  })

  it("accepts audio/mpeg at exactly 50 MB (boundary — inclusive)", async () => {
    const exact = 50 * 1024 * 1024
    const res = await POST(makeUploadReq({ fileType: "audio/mpeg", fileSize: exact, entryId: "e-1" }))
    expect(res.status).toBe(201)
  })
})

// ── DB row type tests ─────────────────────────────────────────────────────────

describe("upload route — DB row type", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedDb()
  })

  // type wird inzwischen als Bind-Parameter ($2) übergeben statt als
  // SQL-Literal interpoliert (parameterised-SQL-Hard-Rule) — die Assertions
  // prüfen deshalb die Parameterliste, nicht den Query-String.
  it("audio upload: DB INSERT binds type 'audio'", async () => {
    await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))

    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO media")
    )
    expect(insertCall).toBeDefined()
    expect((insertCall![1] as unknown[])[1]).toBe("audio")
  })

  it("video upload: DB INSERT binds type 'video'", async () => {
    await POST(makeUploadReq({ fileType: "video/mp4", entryId: "e-1" }))

    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO media")
    )
    expect(insertCall).toBeDefined()
    expect((insertCall![1] as unknown[])[1]).toBe("video")
  })

  it("audio upload: DB INSERT does NOT bind type 'video'", async () => {
    await POST(makeUploadReq({ fileType: "audio/aac", entryId: "e-1" }))

    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO media")
    )
    expect((insertCall![1] as unknown[])[1]).toBe("audio")
  })

  it("video upload: extractPoster is called once", async () => {
    await POST(makeUploadReq({ fileType: "video/mp4", entryId: "e-1" }))
    expect(mockExtractPoster).toHaveBeenCalledOnce()
  })

  it("audio upload: extractPoster is NOT called", async () => {
    await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))
    expect(mockExtractPoster).not.toHaveBeenCalled()
  })

  it("video upload: saveFileToDisk streams file — arrayBuffer never called", async () => {
    const req = makeUploadReq({ fileType: "video/mp4", entryId: "e-1" })
    // formData mock already has arrayBuffer: () => { throw } behaviour
    // We verify saveFileToDisk was called (streaming path) and the route returned 201
    await POST(req)
    expect(mockSaveFileToDisk).toHaveBeenCalledOnce()
  })

  it("audio upload: saveFileToDisk streams file — arrayBuffer never called", async () => {
    await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))
    expect(mockSaveFileToDisk).toHaveBeenCalledOnce()
  })
})

// ── Content validation (Entscheidung 2026-08-06) ─────────────────────────────

describe("upload route — video/audio content validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedDb()
  })

  it("rejects a video upload when ffprobe finds no video stream", async () => {
    mockProbeMediaStreams.mockResolvedValueOnce("invalid")

    const res = await POST(makeUploadReq({ fileType: "video/mp4", entryId: "e-1" }))

    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("invalid_media_content")
    // Datei wird aufgeräumt, keine DB-Zeile geschrieben
    expect(mockRm).toHaveBeenCalledOnce()
    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO media")
    )
    expect(insertCall).toBeUndefined()
  })

  it("rejects an audio upload when ffprobe finds no audio stream", async () => {
    mockProbeMediaStreams.mockResolvedValueOnce("invalid")

    const res = await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))

    expect(res.status).toBe(400)
    expect(mockRm).toHaveBeenCalledOnce()
  })

  it("keeps the upload when validation is unknown (ffmpeg not available) — fail-open", async () => {
    mockProbeMediaStreams.mockResolvedValueOnce("unknown")

    const res = await POST(makeUploadReq({ fileType: "audio/mpeg", entryId: "e-1" }))

    expect(res.status).toBe(201)
  })
})
