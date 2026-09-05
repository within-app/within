/**
 * Übersicht zeigt veraltete Zahlen: /api/stats zählt
 * Soft-Delete-Tombstones mit.
 *
 * Deletes are soft (DELETE sets deleted_at, the row stays in
 * entries). Every aggregate of the stats route must therefore filter on
 * deleted_at IS NULL — this test seeds one live and two tombstoned entries
 * into a real Postgres and asserts that no tombstone shows up in any of the
 * six JournalStats numbers.
 *
 * Uses @testcontainers/postgresql (needs a running Docker daemon, like
 * schema-fresh-db.test.ts) so it cannot pass on a mocked query string.
 * Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"
import type { JournalStats } from "../src/types/journal"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")

describe("GET /api/stats — tombstones must not be counted", () => {
  let container: StartedPostgreSqlContainer
  let stats: JournalStats

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()

    const client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    // One journal; one live entry (today) and two tombstoned entries.
    // The tombstone timestamps are chosen so each stat would move without the
    // fix: today's tombstone inflates totalEntries/onThisDay/media/countries,
    // yesterday's extends streak and totalDays.
    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    const insertEntry = async (createdAt: string, location: string, deleted: boolean) => {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO entries (journal_id, text, created_at, location_name, deleted_at)
         VALUES ($1, 'synthetic', ${createdAt}, $2, ${deleted ? "NOW()" : "NULL"})
         RETURNING id`,
        [journal.id, location]
      )
      await client.query(
        `INSERT INTO media (entry_id, type, file_path) VALUES ($1, 'photo', '/uploads/synthetic.jpg')`,
        [row.id]
      )
      return row.id
    }
    await insertEntry("NOW()", "Hamburg, Deutschland", false)
    await insertEntry("NOW()", "Paris, Frankreich", true)
    await insertEntry("NOW() - INTERVAL '1 day'", "Rom, Italien", true)
    await client.end()

    // The pool in @/lib/db captures DATABASE_URL at first import — set it
    // before the route module (and thus the pool) is loaded.
    process.env.DATABASE_URL = container.getConnectionUri()
    const { GET } = await import("../src/app/api/stats/route")
    const res = await GET(new NextRequest("http://localhost/api/stats"))
    expect(res.status).toBe(200)
    stats = await res.json()
  }, 120_000)

  afterAll(async () => {
    const { db } = await import("../src/lib/db")
    await db.end()
    await container?.stop()
  })

  it("totalEntries counts only live entries", () => {
    expect(stats.totalEntries).toBe(1)
  })

  it("totalMedia ignores media of tombstoned entries", () => {
    expect(stats.totalMedia).toBe(1)
  })

  it("totalDays ignores days that only have tombstones", () => {
    expect(stats.totalDays).toBe(1)
  })

  it("totalCountries ignores countries that only appear on tombstones", () => {
    expect(stats.totalCountries).toBe(1)
  })

  it("onThisDayCount ignores tombstones from today", () => {
    expect(stats.onThisDayCount).toBe(1)
  })

  it("streak is not extended by yesterday's tombstone", () => {
    expect(stats.streak).toBe(1)
  })
})
