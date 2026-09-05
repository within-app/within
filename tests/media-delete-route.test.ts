/**
 * DELETE route security: traversal path in DB must return 400,
 * and the DB record must NOT be deleted when the path guard rejects.
 *
 * Tests the runtime contract flagged as failing:
 * - traversal DELETE → 400/403 (was: 200)
 * - DB row NOT deleted when path guard rejects (was: row deleted)
 * - Security event logged as error (audit trail)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const BASE_URL = "http://localhost:3000"

// ── DB mock ──────────────────────────────────────────────────────────────────
// Simulates a compromised DB record with a traversal path stored as file_path.
// db.connect() liefert einen Client, dessen query auf mockQuery delegiert, damit
// die Call-Reihenfolge über Pool- und Transaktions-Statements hinweg prüfbar bleibt.
const mockQuery = vi.fn()
vi.mock("@/lib/db", () => ({
  db: {
    query: mockQuery,
    connect: vi.fn(async () => ({ query: mockQuery, release: vi.fn() })),
  },
}))

// ── Logger mock ───────────────────────────────────────────────────────────────
const mockLogError = vi.fn()
vi.mock("@/lib/logger", () => ({
  logError: mockLogError,
  logWarn: vi.fn(),
}))

// ── FS mock (no real files needed) ───────────────────────────────────────────
vi.mock("fs/promises", () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}))

function makeDeleteRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, BASE_URL), { method: "DELETE" })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── media/[id] DELETE ─────────────────────────────────────────────────────────

describe("DELETE /api/media/[id] — traversal path in DB", () => {
  it("returns 400 when file_path contains a path traversal sequence", async () => {
    const TRAVERSAL_PATH = "media/uuid/../../etc/passwd"
    mockQuery.mockResolvedValueOnce({
      rows: [{ file_path: TRAVERSAL_PATH, thumbnail_path: null }],
    })

    const { DELETE } = await import("../src/app/api/media/[id]/route")
    const req = makeDeleteRequest("/api/media/some-uuid")
    const res = await DELETE(req, { params: Promise.resolve({ id: "some-uuid" }) })

    expect(res.status).toBe(400)
    // DB DELETE must NOT have been called
    const deleteCalls = mockQuery.mock.calls.filter((args) =>
      String(args[0]).includes("DELETE FROM media")
    )
    expect(deleteCalls).toHaveLength(0)
  })

  it("returns 400 when file_path is a sibling-directory path (CWE-22)", async () => {
    const SIBLING_PATH = "media-backup/secret.txt"
    mockQuery.mockResolvedValueOnce({
      rows: [{ file_path: SIBLING_PATH, thumbnail_path: null }],
    })

    const { DELETE } = await import("../src/app/api/media/[id]/route")
    const req = makeDeleteRequest("/api/media/some-uuid")
    const res = await DELETE(req, { params: Promise.resolve({ id: "some-uuid" }) })

    expect(res.status).toBe(400)
    const deleteCalls = mockQuery.mock.calls.filter((args) =>
      String(args[0]).includes("DELETE FROM media")
    )
    expect(deleteCalls).toHaveLength(0)
  })

  it("logs a security error (not just a warning) when traversal is detected", async () => {
    const TRAVERSAL_PATH = "media/uuid/../../etc/passwd"
    mockQuery.mockResolvedValueOnce({
      rows: [{ file_path: TRAVERSAL_PATH, thumbnail_path: null }],
    })

    const { DELETE } = await import("../src/app/api/media/[id]/route")
    const req = makeDeleteRequest("/api/media/some-uuid")
    await DELETE(req, { params: Promise.resolve({ id: "some-uuid" }) })

    expect(mockLogError).toHaveBeenCalled()
  })

  it("returns 200 and calls DB DELETE for a valid path", async () => {
    const VALID_PATH = "media/uuid-abc/photo.jpg"
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 }) // BEGIN/UPDATE/DELETE/COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: VALID_PATH, thumbnail_path: null }] })

    const { DELETE } = await import("../src/app/api/media/[id]/route")
    const req = makeDeleteRequest("/api/media/some-uuid")
    const res = await DELETE(req, { params: Promise.resolve({ id: "some-uuid" }) })

    expect(res.status).toBe(200)
    const deleteCalls = mockQuery.mock.calls.filter((args) =>
      String(args[0]).includes("DELETE FROM media")
    )
    expect(deleteCalls).toHaveLength(1)
  })

  it("bumpt entries.updated_at VOR dem Löschen — Media-DELETE braucht ein Sync-Signal", async () => {
    // Ohne den Bump hat ein sync-basierter Abgleich prinzipiell kein Signal:
    // Gerät B löscht das Foto, Gerät A rendert es offline unbegrenzt weiter.
    const VALID_PATH = "media/uuid-abc/photo.jpg"
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 }) // BEGIN/UPDATE/DELETE/COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [{ file_path: VALID_PATH, thumbnail_path: null }] })

    const { DELETE } = await import("../src/app/api/media/[id]/route")
    const req = makeDeleteRequest("/api/media/some-uuid")
    await DELETE(req, { params: Promise.resolve({ id: "some-uuid" }) })

    const calls = mockQuery.mock.calls.map((args) => String(args[0]))
    const bumpIndex = calls.findIndex((sql) => sql.includes("UPDATE entries SET updated_at"))
    const deleteIndex = calls.findIndex((sql) => sql.includes("DELETE FROM media"))
    expect(bumpIndex).toBeGreaterThan(-1)
    expect(deleteIndex).toBeGreaterThan(-1)
    // Vor dem Löschen: der Bump findet entry_id über die media-Zeile.
    expect(bumpIndex).toBeLessThan(deleteIndex)
    // revision_id bleibt unangetastet — sonst entstünden künstliche Konfliktkopien.
    expect(calls[bumpIndex]).not.toContain("revision_id")
  })
})
