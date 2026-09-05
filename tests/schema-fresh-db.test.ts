/**
 * Regression: schema.sql must apply to a fresh empty Postgres with zero errors.
 *
 * Guards against 42P17 (invalid IMMUTABLE expression index) and any other DDL error
 * that would block `docker compose up` on a brand-new volume.
 *
 * Uses @testcontainers/postgresql to start a real empty Postgres so this cannot pass
 * on a mocked DB or stale schema snapshot.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")

describe("schema.sql — fresh-DB regression", () => {
  let container: StartedPostgreSqlContainer
  let client: Client

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
  }, 120_000)

  afterAll(async () => {
    await client?.end()
    await container?.stop()
  })

  it("applies schema.sql to an empty DB with zero errors (no 42P17)", async () => {
    const schema = readFileSync(SCHEMA_PATH, "utf-8")
    await expect(client.query(schema)).resolves.toBeDefined()
  }, 30_000)

  it("Zeitzone P4: idx_entries_month_day and month_day_utc() are gone (superseded by a zoned function, no functional index)", async () => {
    const indexResult = await client.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_entries_month_day'
    `)
    expect(indexResult.rows).toHaveLength(0)

    const fnResult = await client.query<{ proname: string }>(`
      SELECT proname FROM pg_proc WHERE proname = 'month_day_utc'
    `)
    expect(fnResult.rows).toHaveLength(0)
  }, 10_000)

  it("month_day_in() is registered as STABLE in pg_proc (depends on the zone database, not IMMUTABLE)", async () => {
    const result = await client.query<{ provolatile: string }>(`
      SELECT provolatile FROM pg_proc WHERE proname = 'month_day_in'
    `)
    expect(result.rows).toHaveLength(1)
    // 'i' = IMMUTABLE, 's' = STABLE, 'v' = VOLATILE
    expect(result.rows[0].provolatile).toBe("s")
  }, 10_000)

  it("month_day_in() reproduces the Silvester crossover in UTC−5 (Zeitzone P4)", async () => {
    const result = await client.query<{ month_day: string; year: number }>(
      `SELECT month_day_in($1::timestamptz, 'Etc/GMT+5') AS month_day,
              EXTRACT(YEAR FROM $1::timestamptz AT TIME ZONE 'Etc/GMT+5')::int AS year`,
      ["2026-01-01T04:00:00Z"]
    )
    expect(result.rows[0].month_day).toBe("12-31")
    expect(result.rows[0].year).toBe(2025)
  }, 10_000)
})
