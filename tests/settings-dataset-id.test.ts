/**
 * GET /api/settings liefert die Datenbestand-Kennung (datasetId) mit.
 *
 * Die Sync-Engine ruft diesen Endpunkt vor jedem Sync als Probe — über das
 * Feld erkennt ein Gerät, dass der Server einen anderen Datenbestand trägt
 * (Restore, Neuaufsetzen, Journal-Löschung) und zieht alles neu.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))

import { db } from "@/lib/db"

describe("GET /api/settings — datasetId", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/testdb")
    vi.mocked(db.query).mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("liefert locale und datasetId aus app_settings", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { key: "locale", value: "de" },
        { key: "dataset_id", value: "11111111-1111-4111-8111-111111111111" },
      ],
    } as never)
    const { GET } = await import("@/app/api/settings/route")
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { locale: string | null; datasetId: string | null }
    expect(body.locale).toBe("de")
    expect(body.datasetId).toBe("11111111-1111-4111-8111-111111111111")
    // Eine Abfrage, parametrisiert, beide Schlüssel
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toMatch(/app_settings/)
    expect(sql).not.toMatch(/'dataset_id'/)
    expect(JSON.stringify(params)).toContain("dataset_id")
    expect(JSON.stringify(params)).toContain("locale")
  })

  it("Datenbankfehler → 503 wie bisher, kein halbes Ergebnis", async () => {
    vi.mocked(db.query).mockRejectedValue(new Error("relation app_settings does not exist"))
    const { GET } = await import("@/app/api/settings/route")
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("db_unavailable")
  })

  it("fehlende Schlüssel → null, nie erfunden", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never)
    const { GET } = await import("@/app/api/settings/route")
    const body = (await (await GET()).json()) as { locale: string | null; datasetId: string | null }
    expect(body.locale).toBeNull()
    expect(body.datasetId).toBeNull()
  })
})
