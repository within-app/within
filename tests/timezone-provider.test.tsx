/**
 * Zeitzone (Fundament, Auslieferung): das Root-Layout reicht APP_TIMEZONE an den
 * LocaleProvider; Komponenten lesen sie per useI18n().timeZone, die reinen
 * Helfer (dateKey …) sehen sie ohne Hook — beides muss im Server-Render
 * (SSR) schon stimmen, sonst blitzen UTC-Tage vor der Hydration auf.
 *
 * Außerdem: ein ungültiger APP_TIMEZONE-Wert wird von env.ts als klarer
 * Konfigurationsfehler gemeldet statt still zu UTC zu werden.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocaleProvider, useI18n } from "@/components/locale-provider"
import { DEFAULT_TIME_ZONE, dateKey, getAppTimeZone, setAppTimeZone, timeHHmm } from "@/lib/timezone"

// 4. September 20:00 in UTC−5 = 5. September 01:00 UTC (Rechenbeispiel)
const EVENING = "2026-09-05T01:00:00.000Z"

function Probe() {
  const { timeZone } = useI18n()
  const d = new Date(EVENING)
  return (
    <p>
      tz={timeZone} key={dateKey(d)} time={timeHHmm(d)}
    </p>
  )
}

afterEach(() => {
  setAppTimeZone(DEFAULT_TIME_ZONE)
  delete process.env.APP_TIMEZONE
  vi.restoreAllMocks()
})

describe("LocaleProvider — timeZone reaches components and helpers in SSR", () => {
  it("UTC−5: Abendeintrag bleibt beim 4. September, 20:00", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="de" timeZone="Etc/GMT+5">
        <Probe />
      </LocaleProvider>
    )
    expect(html).toContain("tz=Etc/GMT+5")
    expect(html).toContain("key=2026-09-04")
    expect(html).toContain("time=20:00")
  })

  it("ohne timeZone-Prop gilt UTC (Standard), auch außerhalb des Providers", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <Probe />
      </LocaleProvider>
    )
    expect(html).toContain("tz=UTC")
    expect(html).toContain("key=2026-09-05")
    expect(renderToStaticMarkup(<Probe />)).toContain("tz=UTC")
  })
})

describe("getAppTimeZone — Server liest APP_TIMEZONE aus der Umgebung", () => {
  it("gültiger Wert wird übernommen, ungültiger fällt auf UTC", () => {
    process.env.APP_TIMEZONE = "Europe/Berlin"
    expect(getAppTimeZone()).toBe("Europe/Berlin")
    process.env.APP_TIMEZONE = "Mars/Olympus"
    expect(getAppTimeZone()).toBe("UTC")
  })
})

describe("env.ts — ungültige APP_TIMEZONE ist ein Konfigurationsfehler", () => {
  it("meldet den Namen der Variable im Fehlertext", async () => {
    process.env.APP_TIMEZONE = "Mars/Olympus"
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.resetModules()
    await import("@/lib/env")
    const output = err.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(output).toContain("APP_TIMEZONE")
    expect(output).toContain("IANA")
  })

  it("gültige APP_TIMEZONE löst keinen Zeitzonen-Fehler aus", async () => {
    process.env.APP_TIMEZONE = "America/New_York"
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.resetModules()
    await import("@/lib/env")
    const output = err.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(output).not.toContain("APP_TIMEZONE")
  })
})
