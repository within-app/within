/**
 * Media type on entry create (Pi field finding, 2026-09-10)
 *
 * A video uploaded before the entry existed (/api/upload without entryId)
 * returns { type: "video" } but writes no media row. The editor then sends
 * the media list via POST /api/entries — which hard-coded type = 'photo' and
 * CreateEntrySchema stripped the client's `type` field. Result: a .mov file
 * stored as type = photo, rendered as a broken image.
 *
 * Red: POST binds 'photo' regardless of the payload's type.
 * Green: POST binds `p.type ?? "photo"` per medium as a UNNEST array.
 *
 * Synthetic data only — no real journal content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { CreateEntrySchema } from "../src/lib/schemas/entry.schema"

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn(), connect: vi.fn() },
}))

const JOURNAL_ID = "00000000-0000-4000-8000-000000000001"
const ENTRY_ID = "00000000-0000-4000-8000-aaaaaaaaaaaa"

describe("CreateEntrySchema — photos[].type", () => {
  it("keeps type on each medium instead of stripping it", () => {
    const result = CreateEntrySchema.safeParse({
      journalId: JOURNAL_ID,
      photos: [{ filePath: "/media/x/x-original.mov", thumbnailPath: "/media/x/x-poster.webp", type: "video" }],
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.photos[0].type).toBe("video")
  })

  it("rejects an unknown type", () => {
    const result = CreateEntrySchema.safeParse({
      journalId: JOURNAL_ID,
      photos: [{ filePath: "/media/x/x.bin", type: "document" }],
    })
    expect(result.success).toBe(false)
  })
})

describe("POST /api/entries — media type binding", () => {
  beforeEach(() => vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb"))
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  async function postWithPhotos(photos: unknown[]) {
    const { db } = await import("@/lib/db")
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params })
        if (sql.includes("INSERT INTO entries")) return { rows: [{ id: ENTRY_ID }] }
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
      body: JSON.stringify({ text: "Synthetic entry", journalId: JOURNAL_ID, tags: [], photos }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const media = calls.find((c) => c.sql.includes("INSERT INTO media"))
    expect(media).toBeDefined()
    return media!
  }

  it("binds type = 'video' for a video medium instead of hard-coding 'photo'", async () => {
    const media = await postWithPhotos([
      { filePath: "/media/x/x-original.mov", thumbnailPath: "/media/x/x-poster.webp", type: "video" },
    ])
    expect(media.sql).not.toMatch(/'photo'/)
    expect(media.params).toContainEqual(["video"])
  })

  it("binds one type per medium in payload order", async () => {
    const media = await postWithPhotos([
      { filePath: "/media/a/a.jpg", thumbnailPath: "/media/a/a-thumb.webp", type: "photo" },
      { filePath: "/media/b/b-original.mov", thumbnailPath: "/media/b/b-poster.webp", type: "video" },
      { filePath: "/media/c/c-original.m4a", type: "audio" },
    ])
    expect(media.params).toContainEqual(["photo", "video", "audio"])
  })

  it("defaults to 'photo' when the payload carries no type (backwards compatible)", async () => {
    const media = await postWithPhotos([{ filePath: "/media/a/a.jpg", thumbnailPath: "/media/a/a-thumb.webp" }])
    expect(media.params).toContainEqual(["photo"])
  })
})
