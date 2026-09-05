/**
 * Koordinaten ohne Ortsname (GPS-Standort, Regression-Fix).
 *
 * Der GPS-Button speichert bewusst nur Koordinaten (kein Reverse Geocoding).
 * GET /api/entries/[id] gab `location` aber nur zurück, wenn location_name
 * gesetzt war — die Koordinaten lagen korrekt in der DB, waren jedoch in
 * Detailansicht und Editor unsichtbar. Schlimmer: Jeder Client, der seinen
 * PUT-Payload aus der GET-Antwort aufbaut (Favorit-Toggle in der
 * Detailansicht, erneutes Speichern im Editor), schrieb dadurch NULL in die
 * Koordinaten-Spalten zurück — echter Datenverlust.
 *
 * Round-Trip gegen echtes Postgres (@testcontainers/postgresql, braucht einen
 * laufenden Docker-Daemon wie stats-tombstone.test.ts). Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"
import type { JournalEntryDetail } from "../src/types/journal"

const SCHEMA_PATH = join(__dirname, "../src/lib/db/schema.sql")

describe("GET/PUT /api/entries/[id] — Koordinaten ohne Ortsname überleben den Round-Trip", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let coordsOnlyId: string
  let namedId: string
  let bareId: string
  let routes: typeof import("../src/app/api/entries/[id]/route")

  const getDetail = async (id: string): Promise<{ status: number; body: JournalEntryDetail }> => {
    const res = await routes.GET(new NextRequest(`http://localhost/api/entries/${id}`), {
      params: Promise.resolve({ id }),
    })
    return { status: res.status, body: await res.json() }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()

    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(readFileSync(SCHEMA_PATH, "utf-8"))

    const { rows: [journal] } = await client.query<{ id: string }>(
      `INSERT INTO journals (name, color) VALUES ('QA-Synthetic', '#6B7280') RETURNING id`
    )
    const insertEntry = async (name: string | null, lat: number | null, lng: number | null) => {
      const { rows: [row] } = await client.query<{ id: string }>(
        `INSERT INTO entries (journal_id, text, created_at, location_name, location_lat, location_lng)
         VALUES ($1, 'synthetic', NOW(), $2, $3, $4) RETURNING id`,
        [journal.id, name, lat, lng]
      )
      return row.id
    }
    coordsOnlyId = await insertEntry(null, 53.52599, 10.30889)
    namedId = await insertEntry("Hamburg, Deutschland", 53.55034, 9.99302)
    bareId = await insertEntry(null, null, null)

    // The pool in @/lib/db captures DATABASE_URL at first import — set it
    // before the route module (and thus the pool) is loaded.
    process.env.DATABASE_URL = container.getConnectionUri()
    routes = await import("../src/app/api/entries/[id]/route")
  }, 120_000)

  afterAll(async () => {
    const { db } = await import("../src/lib/db")
    await db.end()
    await client?.end()
    await container?.stop()
  })

  it("GET liefert die Koordinaten auch ohne Ortsnamen", async () => {
    const { status, body } = await getDetail(coordsOnlyId)
    expect(status).toBe(200)
    expect(body.location).toEqual({
      name: null,
      latitude: 53.52599,
      longitude: 10.30889,
    })
  })

  it("GET liefert benannte Standorte unverändert", async () => {
    const { body } = await getDetail(namedId)
    expect(body.location).toEqual({
      name: "Hamburg, Deutschland",
      latitude: 53.55034,
      longitude: 9.99302,
    })
  })

  it("GET liefert kein location-Objekt ohne Name und Koordinaten", async () => {
    const { body } = await getDetail(bareId)
    expect(body.location).toBeUndefined()
  })

  it("Favorit-Toggle-Round-Trip (PUT aus GET-Antwort) erhält die Koordinaten", async () => {
    // Exakt der Payload, den entry-detail.tsx beim Favorit-Toggle aus der
    // geladenen GET-Antwort baut — vor dem Fix war entry.location undefined
    // und der PUT nullte beide Koordinaten-Spalten.
    const { body: entry } = await getDetail(coordsOnlyId)
    const res = await routes.PUT(
      new NextRequest(`http://localhost/api/entries/${coordsOnlyId}`, {
        method: "PUT",
        body: JSON.stringify({
          text: entry.text,
          journalId: entry.journalId,
          createdAt: entry.createdAt,
          starred: true,
          tags: entry.tags.map((t) => t.name),
          locationName: entry.location?.name ?? null,
          locationLat: entry.location?.latitude ?? null,
          locationLng: entry.location?.longitude ?? null,
          weatherDescription: entry.weather?.description ?? null,
          weatherTempCelsius: entry.weather?.temperatureCelsius ?? null,
          weatherIcon: entry.weather?.icon ?? null,
        }),
      }),
      { params: Promise.resolve({ id: coordsOnlyId }) }
    )
    expect(res.status).toBe(200)

    const { rows: [row] } = await client.query<{
      starred: boolean
      location_lat: number | null
      location_lng: number | null
    }>(`SELECT starred, location_lat, location_lng FROM entries WHERE id = $1`, [coordsOnlyId])
    expect(row.starred).toBe(true)
    expect(row.location_lat).toBe(53.52599)
    expect(row.location_lng).toBe(10.30889)
  })
})
