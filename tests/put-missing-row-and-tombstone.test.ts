/**
 * Server-Härtung Offline-Sync (Nebenbefunde):
 *
 * 1. PUT /api/entries/[id] antwortete 200 auf einen No-op-UPDATE — ein Client
 *    mit einer nie gepushten Offline-UUID hielt seinen Save für gespeichert,
 *    obwohl 0 Zeilen geschrieben wurden. Jetzt: 404 bei fehlender oder
 *    tombstoned Zeile.
 * 2. upsertEntries ließ Edits auf tombstoned Einträge weder in accepted noch
 *    in conflicts — der Client hätte sie ewig re-pusht. Jetzt: accepted
 *    (Tombstone gewinnt, Client dequeued, der Pull liefert den Tombstone).
 *
 * Echt-DB via @testcontainers/postgresql (braucht Docker, Muster
 * stats-tombstone.test.ts). Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"
import type { SyncEntry } from "../src/lib/sync/types"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")
const MISSING_ID = "99999999-0000-4000-8000-000000000000"

const putBody = (journalId: string) => ({
  text: "updated",
  journalId,
  createdAt: "2026-08-04T10:00:00.000Z",
  starred: false,
  tags: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
})

describe("PUT-404-Härtung + Upsert-Tombstone-Accept", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string
  let liveId: string
  let tombstonedId: string
  let routes: typeof import("../src/app/api/entries/[id]/route")

  const doPut = async (id: string) =>
    routes.PUT(
      new NextRequest(`http://localhost/api/entries/${id}`, {
        method: "PUT",
        body: JSON.stringify(putBody(journalId)),
      }),
      { params: Promise.resolve({ id }) }
    )

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    journalId = journal.id
    const insertEntry = async (deleted: boolean) => {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO entries (journal_id, text, created_at, deleted_at)
         VALUES ($1, 'synthetic', NOW(), ${deleted ? "NOW()" : "NULL"}) RETURNING id`,
        [journalId]
      )
      return row.id
    }
    liveId = await insertEntry(false)
    tombstonedId = await insertEntry(true)

    process.env.DATABASE_URL = container.getConnectionUri()
    routes = await import("../src/app/api/entries/[id]/route")
  }, 120_000)

  afterAll(async () => {
    const { db } = await import("../src/lib/db")
    await db.end()
    await client?.end()
    await container?.stop()
  })

  it("PUT auf eine existierende Zeile bleibt 200", async () => {
    const res = await doPut(liveId)
    expect(res.status).toBe(200)
  })

  it("PUT auf eine nicht existierende Zeile antwortet 404 statt Silent-ok", async () => {
    const res = await doPut(MISSING_ID)
    expect(res.status).toBe(404)
  })

  it("PUT auf eine tombstoned Zeile antwortet 404 und belebt nichts wieder", async () => {
    const res = await doPut(tombstonedId)
    expect(res.status).toBe(404)
    const { rows: [row] } = await client.query<{ text: string; deleted_at: Date | null }>(
      `SELECT text, deleted_at FROM entries WHERE id = $1`,
      [tombstonedId]
    )
    expect(row.text).toBe("synthetic")
    expect(row.deleted_at).not.toBeNull()
  })

  it("upsertEntries meldet Edits auf tombstoned Einträge als accepted (Client dequeued)", async () => {
    const { upsertEntries } = await import("../src/lib/db/sync")
    const edit: SyncEntry = {
      id: tombstonedId,
      journalId,
      text: "offline edit after delete",
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: new Date().toISOString(),
      revisionId: "30000000-0000-4000-8000-000000000001",
      starred: false,
      tags: [],
      locationName: null,
      locationLat: null,
      locationLng: null,
      weatherDescription: null,
      weatherTempCelsius: null,
      weatherIcon: null,
      deletedAt: null,
      thumbnailDataUrl: null,
    }
    const result = await upsertEntries([edit])
    expect(result.accepted).toEqual([tombstonedId])
    expect(result.conflicts).toEqual([])
    // Tombstone gewinnt — der Edit darf den Eintrag nicht wiederbeleben.
    const { rows: [row] } = await client.query<{ text: string; deleted_at: Date | null }>(
      `SELECT text, deleted_at FROM entries WHERE id = $1`,
      [tombstonedId]
    )
    expect(row.text).toBe("synthetic")
    expect(row.deleted_at).not.toBeNull()
  })

  it("getChangesSince terminiert und liefert alle Zeilen, wenn 50 Einträge denselben µs-Timestamp teilen (B01)", async () => {
    const { getChangesSince } = await import("../src/lib/db/sync")
    // Ein Batch-Upsert (PAGE_LIMIT = 50) stampt alle Zeilen mit demselben
    // SELECT NOW() — Mikrosekunden-Präzision. Der Seiten-Cursor lief bis B01
    // über new Date(...).toISOString() (ms-Präzision): der Cursor fiel hinter
    // die letzte gelieferte Zeile zurück und Seite 2 war identisch mit Seite 1.
    const T_SHARED = "2026-08-01T00:00:00.123456+00"
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO entries (journal_id, text, created_at, updated_at)
         VALUES ($1, 'b01-synthetic', NOW(), $2::timestamptz) RETURNING id`,
        [journalId, T_SHARED]
      )
      ids.push(row.id)
    }
    const { rows: [later] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, updated_at)
       VALUES ($1, 'b01-later', NOW(), '2026-08-01T00:00:01.5+00'::timestamptz) RETURNING id`,
      [journalId]
    )
    ids.push(later.id)

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await getChangesSince("2026-07-31T00:00:00.000Z", null, cursor, 50)
      for (const e of page.entries) seen.add(e.id)
      cursor = page.nextCursor
      pages++
      // Ohne Fix dreht die Paginierung endlos auf denselben 50 Zeilen.
      expect(pages).toBeLessThanOrEqual(5)
    } while (cursor)
    for (const id of ids) expect(seen.has(id)).toBe(true)
  })

  it("sync_conflict_copies ist pro Eintrag gedeckelt (B18)", async () => {
    // Der Strict-Win-Pfad feuert bei JEDEM gepushten Offline-Edit eines
    // serverseitig existierenden Eintrags und schrieb jedes Mal den kompletten
    // Volltext als neue Zeile — ohne jede Retention: über Jahre zehntausende
    // Volltext-Zeilen (Backup-/VACUUM-/Restore-Kosten), unsichtbar. Der einzige
    // Leser (conflicts-Route) zeigt ohnehin nur die jüngsten 20.
    const { upsertEntries } = await import("../src/lib/db/sync")
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, updated_at)
       VALUES ($1, 'b18-base', NOW(), NOW()) RETURNING id`,
      [journalId]
    )
    const entryId = row.id
    for (let i = 0; i < 25; i++) {
      await upsertEntries([{
        id: entryId,
        journalId,
        text: `b18-edit-${i}`,
        createdAt: "2026-08-04T10:00:00.000Z",
        // Weit in der Zukunft → Skew-Clamp macht daraus serverNow+5min:
        // strikter LWW-Win bei jedem Durchlauf, jedes Mal eine Konfliktkopie.
        updatedAt: "2030-01-01T00:00:00.000Z",
        revisionId: "30000000-0000-4000-8000-000000000002",
        starred: false,
        tags: [],
        locationName: null, locationLat: null, locationLng: null,
        weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
        deletedAt: null,
        thumbnailDataUrl: null,
      }])
    }
    const { rows: [count] } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_conflict_copies WHERE entry_id = $1`,
      [entryId]
    )
    expect(Number(count.n)).toBeLessThanOrEqual(20)
    // Die jüngste Kopie überlebt (Retention löscht nur die ältesten).
    const { rows: newest } = await client.query<{ text: string }>(
      `SELECT text FROM sync_conflict_copies WHERE entry_id = $1 ORDER BY saved_at DESC, id DESC LIMIT 1`,
      [entryId]
    )
    expect(newest[0].text).toBe("b18-edit-23")
  })

  it("DELETE hinterlässt einen textfreien Tombstone und räumt Konfliktkopien (B19)", async () => {
    // Tombstones behielten den kompletten Eintragstext für immer — in DB,
    // FTS-Index und jedem pg_dump; jeder Schema-Backfill re-transportierte
    // alle je gelöschten Texte. In einer Journal-App war "gelöscht" damit
    // faktisch nie gelöscht. Der Sync-Feed braucht vom Tombstone nur
    // id/updated_at/deleted_at.
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, updated_at, location_name)
       VALUES ($1, 'b19-privater-text', NOW(), NOW(), 'Geheimort') RETURNING id`,
      [journalId]
    )
    await client.query(
      `INSERT INTO sync_conflict_copies (entry_id, revision_id, text, created_at, updated_at, starred, tags)
       SELECT id, revision_id, 'b19-kopie', created_at, updated_at, starred, '{}' FROM entries WHERE id = $1`,
      [row.id]
    )

    const res = await routes.DELETE(
      new NextRequest(`http://localhost/api/entries/${row.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: row.id }) }
    )
    expect(res.status).toBe(200)

    const { rows: [after] } = await client.query<{
      text: string
      deleted_at: Date | null
      location_name: string | null
    }>(`SELECT text, deleted_at, location_name FROM entries WHERE id = $1`, [row.id])
    expect(after.deleted_at).not.toBeNull()
    expect(after.text).toBe("")
    expect(after.location_name).toBeNull()

    const { rows: [copies] } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_conflict_copies WHERE entry_id = $1`,
      [row.id]
    )
    expect(Number(copies.n)).toBe(0)
  })

  it("Schema-Bootstrap räumt Alt-Tombstones mit Text (B19, Bestandsdaten)", async () => {
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO entries (journal_id, text, created_at, updated_at, deleted_at)
       VALUES ($1, 'b19-legacy-text', NOW(), NOW(), NOW()) RETURNING id`,
      [journalId]
    )
    await client.query(
      `INSERT INTO sync_conflict_copies (entry_id, revision_id, text, created_at, updated_at, starred, tags)
       SELECT id, revision_id, 'b19-legacy-kopie', created_at, updated_at, starred, '{}' FROM entries WHERE id = $1`,
      [row.id]
    )

    // Idempotenter Boot-Lauf (migrate.ts wendet schema.sql bei jedem Start an)
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    const { rows: [after] } = await client.query<{ text: string }>(
      `SELECT text FROM entries WHERE id = $1`,
      [row.id]
    )
    expect(after.text).toBe("")
    const { rows: [copies] } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_conflict_copies WHERE entry_id = $1`,
      [row.id]
    )
    expect(Number(copies.n)).toBe(0)
  })
})
