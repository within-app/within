/**
 * Datenbestand-Kennung (app_settings.dataset_id) — Server-Seite.
 *
 *   - ensureDatasetId: legt die Kennung einmalig an (ON CONFLICT DO NOTHING),
 *     die UUID kommt aus der Datenbank (gen_random_uuid), nie aus dem Client.
 *   - rotateDatasetId: setzt eine neue Kennung (Upsert) — Restore, Neuaufsetzen,
 *     Journal-Löschung.
 *   - runMigrations ruft ensureDatasetId nach dem Schema auf, in derselben
 *     Verbindung.
 *
 * Synthetic data only — no real DB connections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const client = { query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })), release: vi.fn() }
vi.mock("@/lib/db", () => ({ db: { connect: vi.fn(async () => client) } }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return { ...actual, readFileSync: vi.fn().mockReturnValue("-- stub schema") }
})

describe("dataset-id helpers", () => {
  beforeEach(() => { client.query.mockClear() })

  it("ensureDatasetId: INSERT … ON CONFLICT DO NOTHING mit gen_random_uuid(), Schlüssel als Parameter", async () => {
    const { ensureDatasetId, DATASET_ID_KEY } = await import("@/lib/db/dataset-id")
    await ensureDatasetId(client)
    expect(client.query).toHaveBeenCalledTimes(1)
    const [sql, params] = client.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO app_settings/)
    expect(sql).toMatch(/gen_random_uuid\(\)/)
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/)
    expect(params).toEqual([DATASET_ID_KEY])
    expect(DATASET_ID_KEY).toBe("dataset_id")
  })

  it("rotateDatasetId: Upsert, der den Wert ersetzt", async () => {
    const { rotateDatasetId } = await import("@/lib/db/dataset-id")
    await rotateDatasetId(client)
    const [sql, params] = client.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/gen_random_uuid\(\)/)
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value/)
    expect(params).toEqual(["dataset_id"])
  })
})

describe("runMigrations seeds dataset_id", () => {
  beforeEach(() => {
    client.query.mockClear()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  it("ruft die Kennungs-Anlage nach dem Schema auf derselben Verbindung auf", async () => {
    const { runMigrations } = await import("@/lib/db/migrate")
    await runMigrations()
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    const iSchema = sqls.findIndex((s) => s.includes("-- stub schema"))
    const iSeed = sqls.findIndex((s) => s.includes("app_settings") && s.includes("DO NOTHING"))
    expect(iSchema).toBeGreaterThanOrEqual(0)
    expect(iSeed).toBeGreaterThan(iSchema)
    expect(client.release).toHaveBeenCalled()
  })
})
