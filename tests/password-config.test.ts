/**
 * App-Passwort: Klartext APP_PASSWORD → bcrypt-Hash in app_settings.
 * Vorhersagbar in allen drei Fällen: neu, unverändert, in der Datei geändert.
 * Rückfall APP_PASSWORD_HASH bleibt für bestehende Installationen.
 * Synthetische Daten, gemockter Query-Layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import bcrypt from "bcryptjs"

vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }))
import { db } from "@/lib/db"
import { getPasswordHash, syncPasswordFromEnv, PASSWORD_HASH_KEY } from "@/lib/password"

const query = vi.mocked(db.query)

function storedHash(value: string | null) {
  query.mockImplementation(async (sql: unknown) => {
    if (String(sql).startsWith("SELECT")) return { rows: value ? [{ value }] : [] } as never
    return { rows: [] } as never
  })
}

function upsertCalls() {
  return query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT"))
}

beforeEach(() => query.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe("syncPasswordFromEnv", () => {
  it("ohne APP_PASSWORD passiert nichts", async () => {
    vi.stubEnv("APP_PASSWORD", "")
    expect(await syncPasswordFromEnv()).toBe("unset")
    expect(query).not.toHaveBeenCalled()
  })

  it("erster Start: Hash wird erzeugt und abgelegt, der Hash verifiziert das Passwort", async () => {
    vi.stubEnv("APP_PASSWORD", "korrekt batterie pferd")
    storedHash(null)
    expect(await syncPasswordFromEnv()).toBe("stored")
    const calls = upsertCalls()
    expect(calls).toHaveLength(1)
    const [, params] = calls[0] as unknown as [string, [string, string]]
    expect(params[0]).toBe(PASSWORD_HASH_KEY)
    expect(params[1]).toMatch(/^\$2[aby]\$12\$/)
    expect(await bcrypt.compare("korrekt batterie pferd", params[1])).toBe(true)
  })

  it("unverändertes Passwort wird nicht erneut verarbeitet", async () => {
    vi.stubEnv("APP_PASSWORD", "gleich")
    storedHash(await bcrypt.hash("gleich", 4))
    expect(await syncPasswordFromEnv()).toBe("unchanged")
    expect(upsertCalls()).toHaveLength(0)
  })

  it("in der Datei geändertes Passwort ersetzt den Hash — die Datei gewinnt", async () => {
    vi.stubEnv("APP_PASSWORD", "neu")
    storedHash(await bcrypt.hash("alt", 4))
    expect(await syncPasswordFromEnv()).toBe("stored")
    const [, params] = upsertCalls()[0] as unknown as [string, [string, string]]
    expect(await bcrypt.compare("neu", params[1])).toBe(true)
    expect(await bcrypt.compare("alt", params[1])).toBe(false)
  })
})

describe("getPasswordHash", () => {
  it("Datenbank-Hash geht vor APP_PASSWORD_HASH", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2a$12$envhash")
    storedHash("$2a$12$dbhash")
    expect(await getPasswordHash()).toBe("$2a$12$dbhash")
  })
  it("Rückfall auf APP_PASSWORD_HASH, wenn nichts gespeichert ist (Klartext entfernt oder Alt-Installation)", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "$2a$12$envhash")
    storedHash(null)
    expect(await getPasswordHash()).toBe("$2a$12$envhash")
  })
  it("null, wenn weder Datenbank noch Umgebung einen Hash haben", async () => {
    vi.stubEnv("APP_PASSWORD_HASH", "")
    storedHash(null)
    expect(await getPasswordHash()).toBeNull()
  })
})
