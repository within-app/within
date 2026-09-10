/**
 * Verlorene Antwort ≠ Konflikt (Server-Idempotenz):
 *
 * Der Client sendet updatedAt = queuedAt und ein frisches revisionId. Der
 * Server schrieb bei Annahme updated_at = NOW() und ein NEUES revision_id.
 * Ging die Antwort verloren (WLAN-Abriss nach dem POST), kam derselbe Eintrag
 * erneut: clientUpdatedAt < serverUpdatedAt → Konfliktzweig samt Konfliktkopie,
 * obwohl der Text identisch war. Jetzt speichert der Accept das revision_id des
 * Clients, und ein Retry mit demselben revision_id ist ein No-op-Accept.
 *
 * Echt-DB via @testcontainers/postgresql (Muster put-missing-row-and-tombstone).
 * Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import type { SyncEntry } from "../src/lib/sync/types"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")
const CREATED_ID = "40000000-0000-4000-8000-000000000001"
const REV_CREATE = "30000000-0000-4000-8000-000000000001"
const REV_UPDATE = "30000000-0000-4000-8000-000000000002"

describe("Upsert-Retry mit gleichem revisionId ist idempotent", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string
  let upsertEntries: typeof import("../src/lib/db/sync").upsertEntries

  const makeEntry = (id: string, revisionId: string, updatedAt: string): SyncEntry => ({
    id, journalId, text: "synthetic text", createdAt: "2026-08-04T10:00:00.000Z", updatedAt, revisionId,
    starred: false, tags: ["qa"],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
  })

  const conflictCopies = async (entryId: string) =>
    Number((await client.query(`SELECT COUNT(*)::int AS n FROM sync_conflict_copies WHERE entry_id = $1`, [entryId])).rows[0].n)
  const storedRevision = async (entryId: string) =>
    (await client.query<{ revision_id: string }>(`SELECT revision_id FROM entries WHERE id = $1`, [entryId])).rows[0].revision_id

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))
    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    journalId = journal.id
    process.env.DATABASE_URL = container.getConnectionUri()
    ;({ upsertEntries } = await import("../src/lib/db/sync"))
  }, 120_000)

  afterAll(async () => {
    const { db } = await import("../src/lib/db")
    await db.end()
    await client?.end()
    await container?.stop()
  })

  it("Create zweimal gesendet (Antwort verloren): zweiter Upsert ist accepted, kein Konflikt, keine Konfliktkopie", async () => {
    const entry = makeEntry(CREATED_ID, REV_CREATE, "2026-08-04T10:00:00.000Z")
    expect((await upsertEntries([entry])).accepted).toEqual([CREATED_ID])
    expect(await storedRevision(CREATED_ID)).toBe(REV_CREATE)

    const retry = await upsertEntries([entry])
    expect(retry.accepted).toEqual([CREATED_ID])
    expect(retry.conflicts).toEqual([])
    expect(await conflictCopies(CREATED_ID)).toBe(0)
  })

  it("Update (LWW-Sieg) speichert das Client-revisionId; der Retry ist accepted ohne zweite Konfliktkopie", async () => {
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, updated_at)
       VALUES ($1, 'older server text', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day') RETURNING id`,
      [journalId]
    )
    const entry = makeEntry(row.id, REV_UPDATE, new Date().toISOString())

    const first = await upsertEntries([entry])
    expect(first.accepted).toEqual([row.id])
    expect(await storedRevision(row.id)).toBe(REV_UPDATE)
    // Strict-Win-Snapshot der Server-Version — unverändertes Verhalten.
    expect(await conflictCopies(row.id)).toBe(1)

    const retry = await upsertEntries([entry])
    expect(retry.accepted).toEqual([row.id])
    expect(retry.conflicts).toEqual([])
    expect(await conflictCopies(row.id)).toBe(1)
  })

  it("LWW bleibt: ein ANDERES revisionId mit älterem updatedAt ist weiterhin ein Konflikt", async () => {
    const stale = makeEntry(CREATED_ID, "30000000-0000-4000-8000-000000000009", "2026-08-01T10:00:00.000Z")
    const result = await upsertEntries([stale])
    expect(result.accepted).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(await storedRevision(CREATED_ID)).toBe(REV_CREATE)
  })
})
