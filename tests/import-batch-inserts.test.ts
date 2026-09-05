/**
 * Batch tag/media inserts in import and entry-create
 *
 * Red assertions (fail before batching):
 *   - Importing one entry with N tags must issue exactly 2 tag-related queries
 *     (one batch UNNEST upsert into tags, one batch link into entry_tags),
 *     not 2*N sequential per-tag queries.
 *   - Importing one entry with M photos must issue exactly 1 media INSERT,
 *     not M separate inserts.
 *   - POST /api/entries with N tags must issue exactly 2 tag-related queries.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

// Mock the Node `fs` module so the streaming ZIP writer never touches the real disk.
vi.mock("fs", () => {
  function makeFakeWriteStream() {
    const cbs: Record<string, Array<(...a: unknown[]) => void>> = {}
    return {
      once(ev: string, cb: (...a: unknown[]) => void) { (cbs[ev] ??= []).push(cb); return this },
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(function (this: ReturnType<typeof makeFakeWriteStream>) {
        ;(cbs["finish"] ?? []).forEach(fn => fn())
      }),
      destroy: vi.fn(function (this: ReturnType<typeof makeFakeWriteStream>) {
        ;(cbs["error"] ?? []).forEach(fn => fn(new Error("destroyed")))
      }),
    }
  }
  return {
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => makeFakeWriteStream()),
  }
})

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────

function buildZip(entries: object[]): Uint8Array {
  return zipSync({
    "Journal.json": strToU8(JSON.stringify({ entries })),
    // provide a photo blob for any referenced md5
    "photos/aabbcc.jpeg": new Uint8Array(64).fill(0xff),
    "photos/ddeeff.jpeg": new Uint8Array(64).fill(0xee),
  })
}

function makeImportRequest(body: Uint8Array): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/import"), {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: body as unknown as BodyInit,
  })
}

// ── Import batch tests ─────────────────────────────────────────────────────

describe("POST /api/import — batch tag/media inserts", () => {
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")

    const { db } = await import("@/lib/db")

    // Pool.connect() returns a PoolClient-like object; wrap pool.query mock behind it
    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
          return { rows: [] }
        if (s.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
        if (s.includes("INSERT INTO journals")) return { rows: [{ id: "j-id" }] }
        if (s.includes("SELECT id FROM entries")) return { rows: [] }
        if (s.includes("INSERT INTO entries")) return { rows: [] }
        if (s.includes("INSERT INTO media")) return { rows: [] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }

    vi.mocked(db.query).mockImplementation(async (sql: string) => {
      const s = sql.trim()
      if (s.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
      if (s.includes("INSERT INTO journals")) return { rows: [{ id: "j-id" }] }
      return { rows: [] }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("issues exactly 2 tag queries for a 3-tag entry (not 6 sequential)", async () => {
    const { db } = await import("@/lib/db")
    const mockClient = (await vi.mocked(db.connect)())
    const capturedSqls: string[] = []

    vi.mocked(mockClient.query).mockImplementation(async (sql: string) => {
      capturedSqls.push(sql.trim())
      const s = sql.trim()
      if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
        return { rows: [] }
      if (s.includes("SELECT id FROM entries")) return { rows: [] }
      if (s.includes("INSERT INTO entries")) return { rows: [] }
      if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }
      if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
      if (s.includes("INSERT INTO media")) return { rows: [] }
      return { rows: [] }
    })

    const zip = buildZip([
      {
        uuid: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        text: "Synthetic batch test entry",
        creationDate: "2024-03-01T10:00:00Z",
        starred: false,
        tags: ["alpha", "beta", "gamma"],
      },
    ])

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(zip))
    expect(res.status).toBe(200)

    const tagQueries = capturedSqls.filter(s => s.includes("tags"))
    // Batch: exactly 1 INSERT INTO tags + 1 INSERT INTO entry_tags = 2
    // Sequential (old): 3 × (INSERT tags + INSERT entry_tags) = 6
    expect(tagQueries).toHaveLength(2)

    // The tags INSERT must use UNNEST (batch), not a single VALUES($1)
    const tagsInsert = tagQueries.find(s => s.includes("INSERT INTO tags"))
    expect(tagsInsert).toBeDefined()
    expect(tagsInsert!.toLowerCase()).toContain("unnest")
  })

  it("issues exactly 1 media INSERT for a 2-photo entry (not 2 sequential)", async () => {
    const { db } = await import("@/lib/db")
    const mockClient = (await vi.mocked(db.connect)())
    const capturedSqls: string[] = []

    vi.mocked(mockClient.query).mockImplementation(async (sql: string) => {
      capturedSqls.push(sql.trim())
      const s = sql.trim()
      if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
        return { rows: [] }
      if (s.includes("SELECT id FROM entries")) return { rows: [] }
      if (s.includes("INSERT INTO entries")) return { rows: [] }
      if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }] }
      if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
      if (s.includes("INSERT INTO media")) return { rows: [] }
      return { rows: [] }
    })

    const zip = buildZip([
      {
        uuid: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        text: "Synthetic 2-photo entry",
        creationDate: "2024-03-02T10:00:00Z",
        starred: false,
        tags: ["test"],
        photos: [
          { identifier: "p1", md5: "aabbcc", type: "jpeg", orderInEntry: 0 },
          { identifier: "p2", md5: "ddeeff", type: "jpeg", orderInEntry: 1 },
        ],
      },
    ])

    const { POST } = await import("../src/app/api/import/route")
    const res = await POST(makeImportRequest(zip))
    expect(res.status).toBe(200)

    const mediaQueries = capturedSqls.filter(s => s.includes("INSERT INTO media"))
    // Batch: exactly 1 INSERT for both photos
    // Sequential (old): 2 separate INSERTs
    expect(mediaQueries).toHaveLength(1)
  })
})

// ── Entry create batch tests ───────────────────────────────────────────────

// POST /api/entries now uses db.connect() + BEGIN/COMMIT/ROLLBACK
describe("POST /api/entries — batch tag inserts", () => {
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    const { db } = await import("@/lib/db")
    vi.mocked(db.connect).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("issues exactly 2 tag queries for a 3-tag entry create (not 6 sequential)", async () => {
    const { db } = await import("@/lib/db")
    const capturedSqls: string[] = []

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        capturedSqls.push(sql.trim())
        const s = sql.trim()
        if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] }
        if (s.includes("INSERT INTO entries")) return { rows: [{ id: "entry-new-id" }] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        if (s.includes("INSERT INTO media")) return { rows: [] }
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
        text: "Synthetic tag-batch entry",
        journalId: "00000000-0000-4000-8000-000000000001",
        starred: false,
        tags: ["alpha", "beta", "gamma"],
        photos: [],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(201)

    const tagQueries = capturedSqls.filter(s => s.includes("tags"))
    // Batch: exactly 1 INSERT INTO tags + 1 INSERT INTO entry_tags = 2
    expect(tagQueries).toHaveLength(2)

    const tagsInsert = tagQueries.find(s => s.includes("INSERT INTO tags"))
    expect(tagsInsert!.toLowerCase()).toContain("unnest")
  })
})
