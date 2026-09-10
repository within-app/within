/**
 * Server-Log darf die Ursache nie maskieren — auch nicht in Produktion.
 *
 * Bisher schrieb der Logger bei NODE_ENV=production nur "Interner Fehler" /
 * "Fallback aktiv": Migration, Upload und 40 weitere Aufrufer ließen im
 * Pi-Log keine Diagnose zu. Maskiert wird in HTTP-Antworten, nicht im Log.
 * Der Logger kennt keinen Prod-Zweig mehr, deshalb reicht ein statischer
 * Import. Synthetisch, keine DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { logError, logWarn } from "../src/lib/logger"

describe("logger — Meldung, Stack und Fehlercode landen im Log", () => {
  let error: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {})
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("logError: Kontext, Fehlermeldung und Stack", () => {
    logError("[ctx]", new Error("synthetic boom"))
    const line = String(error.mock.calls[0][0])
    expect(line).toContain("[ctx]")
    expect(line).toContain("synthetic boom")
    expect(line).toContain("at ") // Stack-Frame
    expect(line).not.toContain("Interner Fehler")
  })

  it("logWarn: Fehlermeldung, kein 'Fallback aktiv'", () => {
    logWarn("[ctx]", new Error("synthetic warn"))
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain("synthetic warn")
    expect(line).not.toContain("Fallback aktiv")
  })

  it("logWarn mit String-Argument: der String selbst steht im Log", () => {
    logWarn("[export]", "file missing on disk: /synthetic/path.jpg")
    expect(String(warn.mock.calls[0][0])).toContain("/synthetic/path.jpg")
  })

  it("Fehlercode (SQLSTATE) steht zentral im Kontext: '[ctx] (40P01): msg'", () => {
    logError("[ctx]", Object.assign(new Error("deadlock detected"), { code: "40P01" }))
    expect(String(error.mock.calls[0][0])).toContain("[ctx] (40P01): deadlock detected")
  })
})
