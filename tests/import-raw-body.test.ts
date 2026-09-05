/**
 * Regression test: raw-body import (no req.formData())
 *
 * Proves:
 * 1. A multi-MB raw-ZIP body is accepted by POST /api/import and returns
 *    `imported > 0` (not a 400).
 * 2. This test WOULD have failed against the pre-fix formData() code because
 *    NextRequest.formData() throws when Content-Type is application/zip
 *    (not multipart/form-data), producing a 400 "Ungültiger Request" and
 *    imported === undefined.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"

// ── Mocks ─────────────────────────────────────────────────────────────────

// DB: pool-level query (journal resolution) + connect() for per-entry transactions.
vi.mock("@/lib/db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

// fs/promises: no-op so the test doesn't touch the filesystem.
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

// sharp: dynamically imported inside the route — stub it so thumbnail
// generation succeeds without a real image processor.
vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a synthetic DayOne-style ZIP that is several MB in size.
 * Contains:
 *   - Journal.json with two minimal entries
 *   - photos/<md5>.jpeg for each referenced photo (padded to fill bytes)
 *   - padding.bin — large enough to push the ZIP over 3 MB total
 * No real journal content — UUIDs and text are synthetic.
 */
function buildSyntheticDayOneZip(): Uint8Array {
  const entry1Uuid = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1"
  const entry2Uuid = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2"
  const photo1Md5 = "aabbccddeeff00112233445566778800"

  const journal = {
    entries: [
      {
        uuid: entry1Uuid,
        text: "Synthetic entry one. This is test data only.",
        creationDate: "2024-01-01T10:00:00Z",
        modifiedDate: "2024-01-01T10:00:00Z",
        starred: false,
        tags: ["synth-tag"],
        photos: [
          { identifier: "photo1", md5: photo1Md5, type: "jpeg", orderInEntry: 0 },
        ],
      },
      {
        uuid: entry2Uuid,
        text: "Synthetic entry two. This is test data only.",
        creationDate: "2024-01-02T10:00:00Z",
        modifiedDate: "2024-01-02T10:00:00Z",
        starred: true,
        tags: [],
      },
    ],
  }

  // A 1 MB synthetic JPEG blob (not a valid image — sharp is mocked)
  const photoBlob = new Uint8Array(1 * 1024 * 1024).fill(0xab)

  // 3 MB stored without compression (level:0) so the ZIP file itself is
  // multi-MB — repeating bytes deflate to near-zero otherwise.
  const paddingBlob = new Uint8Array(3 * 1024 * 1024)
  // Simple LCG to fill with pseudo-random bytes without importing crypto
  let seed = 0x12345678
  for (let i = 0; i < paddingBlob.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    paddingBlob[i] = seed & 0xff
  }

  return zipSync({
    "Journal.json": strToU8(JSON.stringify(journal)),
    [`photos/${photo1Md5}.jpeg`]: [photoBlob, { level: 0 }],
    "padding.bin": [paddingBlob, { level: 0 }],
  })
}

function makeImportRequest(body: Uint8Array): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/import"), {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: body as unknown as BodyInit,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/import — raw-body path (regression)", () => {
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")

    // Wire up DB mock responses by inspecting the SQL string.
    const { db } = await import("@/lib/db")

    // Pool-level query handles journal resolution (before the per-entry loop).
    vi.mocked(db.query).mockImplementation(async (sql: string) => {
      const s = sql.trim()
      if (s.includes("SELECT id FROM journals WHERE name")) return { rows: [] }
      if (s.includes("INSERT INTO journals")) return { rows: [{ id: "journal-synth-id" }] }
      if (s.includes("SELECT id FROM journals WHERE id")) return { rows: [{ id: "journal-synth-id" }] }
      return { rows: [] }
    })

    // PoolClient returned by db.connect() handles per-entry transaction queries.
    const mockClient = {
      query: vi.fn(async (sql: string) => {
        const s = sql.trim()
        if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK"))
          return { rows: [] }
        if (s.includes("SELECT id FROM entries")) return { rows: [] } // new entry each time
        if (s.includes("INSERT INTO entries")) return { rows: [] }
        if (s.includes("INSERT INTO media")) return { rows: [] }
        if (s.includes("INSERT INTO tags")) return { rows: [{ id: "tag-synth-id" }] }
        if (s.includes("INSERT INTO entry_tags")) return { rows: [] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.connect).mockResolvedValue(mockClient as any)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("accepts a multi-MB raw ZIP body and imports entries (not a 400)", async () => {
    // This assertion FAILS against the pre-fix formData() code:
    // formData() throws on application/zip content → route returns 400
    // → data.imported is undefined → expect(undefined).toBeGreaterThan(0) fails.
    const { POST } = await import("../src/app/api/import/route")

    const zipBytes = buildSyntheticDayOneZip()
    // Confirm the payload is multi-MB (regression guard)
    expect(zipBytes.byteLength).toBeGreaterThan(1 * 1024 * 1024)

    const req = makeImportRequest(zipBytes)
    const res = await POST(req)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported?: number; errors?: string[] }
    expect(body.imported).toBeGreaterThan(0)
  })

  it("returns 413 when the streaming body exceeds 100 MB (Pi-safe ceiling)", async () => {
    // Sanity-check that the streaming size guard returns 413.
    // Cap is 100 MB; send 101 MB to reliably trigger the limit.
    const { POST } = await import("../src/app/api/import/route")

    const oversize = new Uint8Array(101 * 1024 * 1024)
    const req = new NextRequest(new URL("http://localhost:3000/api/import"), {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: oversize as unknown as BodyInit,
    })

    const res = await POST(req)
    expect(res.status).toBe(413)
  })

  it("returns 503 when DATABASE_URL is missing", async () => {
    vi.unstubAllEnvs()
    // Do not stub DATABASE_URL → it will be absent in a clean test env
    vi.stubEnv("DATABASE_URL", "")
    const { POST } = await import("../src/app/api/import/route")

    const req = makeImportRequest(new Uint8Array(100))
    const res = await POST(req)
    expect(res.status).toBe(503)
  })
})
