/**
 * Transactional writes for POST /api/entries and PUT /api/entries/[id]
 *
 * Red: before fix, no db.connect() is used, so ROLLBACK is never called when a
 *      mid-write query fails — orphan rows persist.
 * Green: after fix, a ROLLBACK is issued on failure and COMMIT only on full success.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

// ── POST /api/entries — transactional write ────────────────────────────────

describe("POST /api/entries — transactional write", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("calls ROLLBACK and not COMMIT when photos INSERT fails after entry INSERT succeeds", async () => {
    const { db } = await import("@/lib/db")
    let rollbackCalled = false
    let commitCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN") return { rows: [] }
        if (s === "ROLLBACK") { rollbackCalled = true; return { rows: [] } }
        if (s === "COMMIT") { commitCalled = true; return { rows: [] } }
        if (s.includes("INSERT INTO entries")) return { rows: [{ id: "00000000-0000-4000-8000-aaaaaaaaaaaa" }] }
        if (s.includes("INSERT INTO media")) throw new Error("Simulated connection failure mid-write")
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { POST } = await import("../src/app/api/entries/route")
    const req = new NextRequest(new URL("http://localhost:3000/api/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Synthetic entry with photo — transaction test",
        journalId: "00000000-0000-4000-8000-000000000001",
        starred: false,
        tags: [],
        photos: [{ filePath: "/media/abc123/photo.jpg", thumbnailPath: "/media/abc123/thumb.webp" }],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(500)
    expect(rollbackCalled).toBe(true)
    expect(commitCalled).toBe(false)
  })

  it("calls ROLLBACK and not COMMIT when tags INSERT fails after entry INSERT succeeds", async () => {
    const { db } = await import("@/lib/db")
    let rollbackCalled = false
    let commitCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN") return { rows: [] }
        if (s === "ROLLBACK") { rollbackCalled = true; return { rows: [] } }
        if (s === "COMMIT") { commitCalled = true; return { rows: [] } }
        if (s.includes("INSERT INTO entries")) return { rows: [{ id: "00000000-0000-4000-8000-bbbbbbbbbbbb" }] }
        if (s.includes("INSERT INTO tags")) throw new Error("Simulated tag failure")
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { POST } = await import("../src/app/api/entries/route")
    const req = new NextRequest(new URL("http://localhost:3000/api/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Synthetic entry with tags — transaction test",
        journalId: "00000000-0000-4000-8000-000000000001",
        starred: false,
        tags: ["alpha", "beta"],
        photos: [],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(500)
    expect(rollbackCalled).toBe(true)
    expect(commitCalled).toBe(false)
  })

  it("calls COMMIT (and not ROLLBACK) on full success", async () => {
    const { db } = await import("@/lib/db")
    let rollbackCalled = false
    let commitCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN") return { rows: [] }
        if (s === "ROLLBACK") { rollbackCalled = true; return { rows: [] } }
        if (s === "COMMIT") { commitCalled = true; return { rows: [] } }
        if (s.includes("INSERT INTO entries")) return { rows: [{ id: "00000000-0000-4000-8000-cccccccccccc" }] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }, { id: "t2" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { POST } = await import("../src/app/api/entries/route")
    const req = new NextRequest(new URL("http://localhost:3000/api/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Synthetic entry — success path test",
        journalId: "00000000-0000-4000-8000-000000000001",
        starred: false,
        tags: ["alpha", "beta"],
        photos: [],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    expect(commitCalled).toBe(true)
    expect(rollbackCalled).toBe(false)
  })
})

// ── PUT /api/entries/[id] — transactional write ───────────────────────────

describe("PUT /api/entries/[id] — transactional write", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("calls ROLLBACK and not COMMIT when tags INSERT fails after DELETE from entry_tags", async () => {
    const { db } = await import("@/lib/db")
    let rollbackCalled = false
    let commitCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN") return { rows: [] }
        if (s === "ROLLBACK") { rollbackCalled = true; return { rows: [] } }
        if (s === "COMMIT") { commitCalled = true; return { rows: [] } }
        if (s.includes("UPDATE entries")) return { rows: [] }
        if (s.includes("DELETE FROM entry_tags")) return { rows: [] }
        if (s.includes("INSERT INTO tags")) throw new Error("Simulated tag failure after DELETE")
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const req = new NextRequest(new URL("http://localhost:3000/api/entries/synthetic-id"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journalId: "00000000-0000-4000-8000-000000000001",
        text: "Updated synthetic text",
        createdAt: "2024-01-01T00:00:00.000Z",
        starred: false,
        tags: ["newtag"],
      }),
    })

    const res = await PUT(req, { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) })
    expect(res.status).toBe(500)
    expect(rollbackCalled).toBe(true)
    expect(commitCalled).toBe(false)
  })

  it("calls COMMIT (and not ROLLBACK) on full success", async () => {
    const { db } = await import("@/lib/db")
    let rollbackCalled = false
    let commitCalled = false

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s === "BEGIN") return { rows: [] }
        if (s === "ROLLBACK") { rollbackCalled = true; return { rows: [] } }
        if (s === "COMMIT") { commitCalled = true; return { rows: [] } }
        if (s.includes("UPDATE entries")) return { rows: [] }
        if (s.includes("DELETE FROM entry_tags")) return { rows: [] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)

    const { PUT } = await import("../src/app/api/entries/[id]/route")
    const req = new NextRequest(new URL("http://localhost:3000/api/entries/synthetic-id"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journalId: "00000000-0000-4000-8000-000000000001",
        text: "Updated synthetic text — success path",
        createdAt: "2024-01-01T00:00:00.000Z",
        starred: false,
        tags: ["newtag"],
      }),
    })

    const res = await PUT(req, { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) })
    expect(res.status).toBe(200)
    expect(commitCalled).toBe(true)
    expect(rollbackCalled).toBe(false)
  })
})
