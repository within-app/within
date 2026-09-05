import { describe, it, expect } from "vitest"
import { parse } from "pg-connection-string"

/**
 * Verify that pg's native connection-string parser handles
 * percent-encoded passwords and query params (e.g. ?sslmode=require).
 * No live database is needed — we only assert on the parsed config shape.
 */
describe("pg-connection-string native parser", () => {
  it("parses a URL with a percent-encoded password correctly", () => {
    // password contains special chars encoded: p%40ss%2Fw0rd == p@ss/w0rd
    const url =
      "postgresql://admin:p%40ss%2Fw0rd@localhost:5432/mydb"
    const config = parse(url)
    expect(config.user).toBe("admin")
    expect(config.password).toBe("p@ss/w0rd")
    expect(config.host).toBe("localhost")
    expect(config.port).toBe("5432")
    expect(config.database).toBe("mydb")
  })

  it("parses a URL with query params (sslmode=require)", () => {
    const url =
      "postgresql://admin:secret@localhost:5432/mydb?sslmode=require"
    const config = parse(url)
    expect(config.user).toBe("admin")
    expect(config.password).toBe("secret")
    expect(config.database).toBe("mydb")
    expect(config.ssl).toBeTruthy()
  })

  it("parses a URL combining encoded password and query param", () => {
    const url =
      "postgresql://user:p%40ss%3D1@db.host:5432/journal?sslmode=require"
    const config = parse(url)
    expect(config.user).toBe("user")
    expect(config.password).toBe("p@ss=1")
    expect(config.database).toBe("journal")
    expect(config.ssl).toBeTruthy()
  })
})
