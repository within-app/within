/**
 * GET /api/media/preview-stats gegen echtes Postgres:
 * beweist Zeitraum-Filter (created_at >= since), Tombstone-Filter,
 * Foto-only und fs-stat-Summe auf realen synthetischen Dateien — kann auf
 * einem gemockten Query-String nicht grün werden.
 *
 * Uses @testcontainers/postgresql (needs a running Docker daemon, like
 * schema-fresh-db.test.ts). Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")
const SYNTH_DIR = join(process.cwd(), "public", "media", "__vitest-preview-stats-ct__")

describe("GET /api/media/preview-stats — Zeitraum + Tombstone gegen echtes Postgres", () => {
  let container: StartedPostgreSqlContainer
  let GET: (req: NextRequest) => Promise<Response>

  beforeAll(async () => {
    mkdirSync(SYNTH_DIR, { recursive: true })
    // Zwei Thumbs im Zeitraum-Test relevant: alt (2026-01) und neu (2026-08).
    writeFileSync(join(SYNTH_DIR, "old-thumb.webp"), Buffer.alloc(1111, 0x01))
    writeFileSync(join(SYNTH_DIR, "new-thumb.webp"), Buffer.alloc(2222, 0x02))
    writeFileSync(join(SYNTH_DIR, "dead-thumb.webp"), Buffer.alloc(4444, 0x03))

    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    const client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    const insertEntry = async (createdAt: string, deleted: boolean) => {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO entries (journal_id, text, created_at, deleted_at)
         VALUES ($1, 'synthetic', $2, ${deleted ? "NOW()" : "NULL"}) RETURNING id`,
        [journal.id, createdAt]
      )
      return row.id
    }
    const addMedia = async (entryId: string, type: string, thumb: string | null) => {
      await client.query(
        `INSERT INTO media (entry_id, type, file_path, thumbnail_path)
         VALUES ($1, $2, '/media/__vitest-preview-stats-ct__/synthetic-full.jpg', $3)`,
        [entryId, type, thumb]
      )
    }

    const oldEntry = await insertEntry("2026-01-15T10:00:00Z", false)
    await addMedia(oldEntry, "photo", "/media/__vitest-preview-stats-ct__/old-thumb.webp")
    const newEntry = await insertEntry("2026-08-20T10:00:00Z", false)
    await addMedia(newEntry, "photo", "/media/__vitest-preview-stats-ct__/new-thumb.webp")
    // Tombstone mit Thumb — darf nie zählen.
    const deadEntry = await insertEntry("2026-08-21T10:00:00Z", true)
    await addMedia(deadEntry, "photo", "/media/__vitest-preview-stats-ct__/dead-thumb.webp")
    // Video mit Poster-Thumb — Spiegel ist Foto-only.
    const videoEntry = await insertEntry("2026-08-22T10:00:00Z", false)
    await addMedia(videoEntry, "video", "/media/__vitest-preview-stats-ct__/new-thumb.webp")
    // Foto ohne Thumb — zählt nicht (nichts zu spiegeln).
    await addMedia(newEntry, "photo", null)
    await client.end()

    process.env.DATABASE_URL = container.getConnectionUri()
    ;({ GET } = await import("../src/app/api/media/preview-stats/route"))
  }, 120_000)

  afterAll(async () => {
    rmSync(SYNTH_DIR, { recursive: true, force: true })
    await container?.stop()
  })

  it("ohne since: alle lebenden Foto-Thumbs (alt + neu), Tombstone/Video/thumb-los draußen", async () => {
    const res = await GET(new NextRequest("http://localhost/api/media/preview-stats"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 2, bytes: 3333 })
  })

  it("mit since: nur Fotos von Einträgen im Zeitraum", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/media/preview-stats?since=" +
          encodeURIComponent("2026-06-01T00:00:00.000Z")
      )
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 1, bytes: 2222 })
  })
}, 180_000)
