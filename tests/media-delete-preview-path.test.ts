/**
 * preview_path must be deleted alongside file_path + thumbnail_path
 * in both DELETE /api/media/[id] and DELETE /api/entries/[id].
 *
 * Defect: both routes previously SELECT'd only file_path + thumbnail_path,
 * guaranteeing file orphans (loop-clip WebPs) once the pipeline is wired.
 *
 * Fix: add preview_path to the SELECT and to the file-deletion loop in each route.
 *
 * No real journal content used (Constraint D).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDbQuery = vi.fn()
// db.connect() liefert einen Client, dessen query auf mockDbQuery delegiert —
// beide DELETE-Routen wickeln ihre DB-Writes inzwischen in einer Transaktion ab.
vi.mock("@/lib/db", () => ({
  db: {
    query: mockDbQuery,
    connect: vi.fn(async () => ({ query: mockDbQuery, release: vi.fn() })),
  },
}))

const mockDeleteMediaFile = vi.fn().mockResolvedValue(undefined)
vi.mock("@/lib/media-cleanup", () => ({ deleteMediaFile: mockDeleteMediaFile }))

// safeMediaPath: validates path; in tests all paths are valid, so just return p
vi.mock("@/lib/media-security", () => ({
  safeMediaPath: (_cwd: string, p: string) => p,
}))

vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))

// Stubs for modules imported at top of entries/[id]/route.ts but not used in DELETE
vi.mock("@/lib/env", () => ({
  dbUnavailableResponse: () => new Response(JSON.stringify({ error: "DB unavailable" }), { status: 503 }),
}))
vi.mock("@/lib/schemas/entry.schema", () => ({
  UpdateEntrySchema: { safeParse: vi.fn() },
}))
vi.mock("@/lib/schemas", () => ({ validationError: vi.fn() }))

// DATABASE_URL must be truthy so the handlers don't early-return
process.env.DATABASE_URL = "postgresql://fake/fake"

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const { DELETE: deleteMediaById } = await import("@/app/api/media/[id]/route")
const { DELETE: deleteEntryById } = await import("@/app/api/entries/[id]/route")

// ── DELETE /api/media/[id] ────────────────────────────────────────────────────

describe("DELETE /api/media/[id] — preview_path cleanup", () => {
  beforeEach(() => vi.clearAllMocks())

  it("deletes original + poster (thumbnail_path) + loop (preview_path)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          file_path: "media/abc/video.mp4",
          thumbnail_path: "media/abc/poster.webp",
          preview_path: "media/abc/loop.webp",
        }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 }) // BEGIN/UPDATE/DELETE/COMMIT

    const req = new NextRequest("http://localhost/api/media/test-uuid")
    const res = await deleteMediaById(req, { params: Promise.resolve({ id: "test-uuid" }) })

    expect(res.status).toBe(200)
    expect(mockDeleteMediaFile).toHaveBeenCalledTimes(3)
    const deleted = mockDeleteMediaFile.mock.calls.map((call) => call[1] as string)
    expect(deleted).toContain("media/abc/video.mp4")
    expect(deleted).toContain("media/abc/poster.webp")
    expect(deleted).toContain("media/abc/loop.webp")
  })

  it("omits preview_path from deletion when it is null (not yet generated)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          file_path: "media/def/video.mp4",
          thumbnail_path: "media/def/poster.webp",
          preview_path: null,
        }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 })

    const req = new NextRequest("http://localhost/api/media/test-uuid-2")
    const res = await deleteMediaById(req, { params: Promise.resolve({ id: "test-uuid-2" }) })

    expect(res.status).toBe(200)
    expect(mockDeleteMediaFile).toHaveBeenCalledTimes(2)
  })

  it("SELECT query includes preview_path column", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          file_path: "media/ghi/video.mp4",
          thumbnail_path: null,
          preview_path: null,
        }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 })

    const req = new NextRequest("http://localhost/api/media/test-uuid-3")
    await deleteMediaById(req, { params: Promise.resolve({ id: "test-uuid-3" }) })

    const [selectSql] = mockDbQuery.mock.calls[0]
    expect(selectSql).toContain("preview_path")
  })
})

// ── DELETE /api/entries/[id] ─────────────────────────────────────────────────

describe("DELETE /api/entries/[id] — preview_path cleanup", () => {
  beforeEach(() => vi.clearAllMocks())

  it("deletes original + poster + loop for a video media row", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          file_path: "media/xyz/video.mp4",
          thumbnail_path: "media/xyz/poster.webp",
          preview_path: "media/xyz/loop.webp",
        }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 }) // BEGIN/UPDATE/DELETEs/COMMIT

    const req = new NextRequest("http://localhost/api/entries/entry-uuid")
    const res = await deleteEntryById(req, { params: Promise.resolve({ id: "entry-uuid" }) })

    expect(res.status).toBe(200)
    expect(mockDeleteMediaFile).toHaveBeenCalledTimes(3)
    const deleted = mockDeleteMediaFile.mock.calls.map((call) => call[1] as string)
    expect(deleted).toContain("media/xyz/video.mp4")
    expect(deleted).toContain("media/xyz/poster.webp")
    expect(deleted).toContain("media/xyz/loop.webp")
  })

  it("handles multiple media rows, deleting all preview_paths", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          { file_path: "media/a/v.mp4", thumbnail_path: "media/a/p.webp", preview_path: "media/a/l.webp" },
          { file_path: "media/b/v.mp4", thumbnail_path: null,              preview_path: null },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 })

    const req = new NextRequest("http://localhost/api/entries/entry-multi")
    const res = await deleteEntryById(req, { params: Promise.resolve({ id: "entry-multi" }) })

    expect(res.status).toBe(200)
    // row 1: 3 files; row 2: 1 file
    expect(mockDeleteMediaFile).toHaveBeenCalledTimes(4)
  })

  it("SELECT query includes preview_path column", async () => {
    mockDbQuery
      .mockResolvedValue({ rows: [], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 })

    const req = new NextRequest("http://localhost/api/entries/entry-empty")
    await deleteEntryById(req, { params: Promise.resolve({ id: "entry-empty" }) })

    const [selectSql] = mockDbQuery.mock.calls[0]
    expect(selectSql).toContain("preview_path")
  })
})
