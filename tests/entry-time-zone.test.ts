/**
 * Zeitzone je Eintrag: Helfer und Client-Ansichten (ohne Datenbank).
 * Ein Eintrag gehört zum Kalendertag seiner eigenen Zone, ohne Zone zur App-Zone.
 * Synthetic data only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { deviceTodayDate, setAppTimeZone, streakLength, zoneOf, DEFAULT_TIME_ZONE } from "@/lib/timezone"
import { formatEntryDate, formatEntryTime } from "@/lib/format"
import { todayAnchor } from "@/components/on-this-day/on-this-day-view"
import { withEntryDay, withEntryTime, entryTimeString } from "@/lib/editor/entry-date"
import { idbToStats, idbToCalendarData } from "@/lib/sync/idb-to-views"
import { syncEntriesToDateGroups } from "@/lib/sync/idb-to-timeline"
import { buildQueuedEdit } from "@/lib/sync/queue-edit"
import { acceptedTimeZone, resetAcceptedTimeZones } from "@/lib/db/time-zone"
import type { SyncEntry } from "@/lib/sync/types"

function entry(over: Partial<SyncEntry>): SyncEntry {
  return {
    id: over.id ?? "e",
    journalId: "j",
    text: "synthetic",
    createdAt: "2026-07-10T08:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z",
    revisionId: "r",
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
    ...over,
  }
}

beforeEach(() => setAppTimeZone("Europe/Berlin"))
afterEach(() => {
  setAppTimeZone(DEFAULT_TIME_ZONE)
  vi.useRealTimers()
})

describe("zoneOf", () => {
  it("nimmt die Zone des Eintrags", () => {
    expect(zoneOf("Asia/Bangkok")).toBe("Asia/Bangkok")
  })
  it("fällt ohne Zone auf die App-Zone zurück", () => {
    expect(zoneOf(null)).toBe("Europe/Berlin")
    expect(zoneOf(undefined)).toBe("Europe/Berlin")
  })
  it("sprengt bei einem unbekannten Namen nicht die Ansicht", () => {
    expect(zoneOf("Mars/Olympus")).toBe("Europe/Berlin")
  })
})

describe("streakLength", () => {
  const days = (...d: string[]) => new Set(d)
  it("zählt ab heute", () => {
    expect(streakLength(days("2026-07-10", "2026-07-09"), "2026-07-10")).toBe(2)
  })
  it("lässt gestern als Start gelten, solange heute noch nichts steht", () => {
    expect(streakLength(days("2026-07-09", "2026-07-08"), "2026-07-10")).toBe(2)
  })
  it("ist 0, wenn auch gestern nichts steht", () => {
    expect(streakLength(days("2026-07-08"), "2026-07-10")).toBe(0)
  })
  it("zählt einen Tag, der östlich der App-Zone schon morgen ist", () => {
    expect(streakLength(days("2026-07-11", "2026-07-10"), "2026-07-10")).toBe(2)
  })
  it("heute ausgelassen, Eintrag für morgen: die Serie beginnt wieder bei 1", () => {
    expect(streakLength(days("2026-07-11", "2026-07-09", "2026-07-08"), "2026-07-10")).toBe(1)
  })
  it("heute ausgelassen, am nächsten Tag geschrieben: ebenfalls 1", () => {
    expect(streakLength(days("2026-07-11", "2026-07-09", "2026-07-08"), "2026-07-11")).toBe(1)
  })
  it("ein nachgetragener Tag schließt die Lücke", () => {
    expect(streakLength(days("2026-07-11", "2026-07-10", "2026-07-09"), "2026-07-11")).toBe(3)
  })
  it("was weiter als morgen in der Zukunft liegt, zählt nicht", () => {
    expect(streakLength(days("2026-07-12", "2026-07-09", "2026-07-08"), "2026-07-10")).toBe(2)
  })
})

describe("Anzeige", () => {
  it("Uhrzeit in der Zone des Eintrags, ohne Zone in der App-Zone", () => {
    expect(formatEntryTime("2026-01-15T20:00:00.000Z", "Asia/Bangkok")).toBe("03:00")
    expect(formatEntryTime("2026-01-15T20:00:00.000Z")).toBe("21:00")
  })
  describe("Heute und Gestern aus Sicht des Geräts, Tagesansicht und Eintrag sagen dasselbe", () => {
    const onDevice = (tz: string) => {
      vi.stubGlobal("window", {})
      vi.stubEnv("TZ", tz)
    }
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    })
    // Der Kopf der Tagesansicht formatiert den Mittag des Tages in der App-Zone.
    const kopf = (day: string) => formatEntryDate(`${day}T12:00:00.000Z`, "de")

    it("in Los Angeles, abends", () => {
      onDevice("America/Los_Angeles")
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-11-05T07:00:00.000Z")) // LA: 04.11. 23:00
      expect(formatEntryDate("2026-11-05T04:00:00.000Z", "de", "America/Los_Angeles")).toBe("Heute")
      expect(kopf("2026-11-04")).toBe("Heute")
    })
    it("in Tokio, nachts", () => {
      onDevice("Asia/Tokyo")
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z")) // Tokio: 05.11. 02:00
      expect(formatEntryDate("2026-11-04T17:00:00.000Z", "de", "Asia/Tokyo")).toBe("Heute")
      expect(kopf("2026-11-05")).toBe("Heute")
      expect(deviceTodayDate().getDate()).toBe(5)
    })
    it("zu Hause mit einem Eintrag aus Tokio", () => {
      onDevice("Europe/Berlin")
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-11-04T15:00:00.000Z")) // Berlin: 04.11. 16:00
      expect(formatEntryDate("2026-11-04T14:00:00.000Z", "de", "Asia/Tokyo")).toBe("Heute") // Tokio: 04.11. 23:00
      expect(kopf("2026-11-04")).toBe("Heute")
    })
  })
  it("Datum in der Zone des Eintrags", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"))
    expect(formatEntryDate("2026-01-15T20:00:00.000Z", "de", "Asia/Bangkok")).toContain("16")
    expect(formatEntryDate("2026-01-15T20:00:00.000Z", "de")).toContain("15")
  })
})

describe("Editor rechnet in der Zone des Eintrags", () => {
  const instant = new Date("2026-01-15T20:00:00.000Z") // Bangkok: 16.01. 03:00
  it("zeigt die Uhrzeit der Zone", () => {
    expect(entryTimeString(instant, "Asia/Bangkok")).toBe("03:00")
  })
  it("ändert die Uhrzeit in der Zone, der Tag bleibt", () => {
    expect(withEntryTime(instant, "04:30", "Asia/Bangkok")?.toISOString()).toBe("2026-01-15T21:30:00.000Z")
  })
  it("ändert den Tag in der Zone, die Uhrzeit bleibt", () => {
    expect(withEntryDay(instant, new Date(2026, 0, 20), "Asia/Bangkok").toISOString()).toBe("2026-01-19T20:00:00.000Z")
  })
})

describe("Offline-Ansichten rechnen je Eintrag", () => {
  // Abends in New York, in Berlin schon der nächste Tag
  const newYork = entry({ id: "ny", createdAt: "2026-01-15T23:30:00.000Z", timeZone: "America/New_York" })
  // Nachts in Bangkok, in Berlin noch der Vortag
  const bangkok = entry({ id: "bk", createdAt: "2026-01-20T20:00:00.000Z", timeZone: "Asia/Bangkok" })

  it("Zeitleiste gruppiert nach dem Tag des Eintrags", () => {
    const groups = syncEntriesToDateGroups([newYork, bangkok])
    expect(groups.map((g) => g.date)).toEqual(["2026-01-21", "2026-01-15"])
    expect(groups[0].entries[0].timeZone).toBe("Asia/Bangkok")
  })
  it("Kalender zählt am Tag des Eintrags", () => {
    const cal = idbToCalendarData([newYork, bangkok], null)
    expect(Object.keys(cal).sort()).toEqual(["2026-01-15", "2026-01-21"])
  })
  it("Serie läuft über Reisetage, die in Berlin-Zeit eine Lücke hätten", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-22T12:00:00.000Z"))
    // Lokal aufeinanderfolgende Tage 20. und 21.; in Berlin lägen beide am 20.
    const a = entry({ id: "a", createdAt: "2026-01-20T08:00:00.000Z", timeZone: "Europe/Berlin" })
    expect(idbToStats([a, bangkok], null).streak).toBe(2)
    const nurBerlin = { ...bangkok, timeZone: null }
    expect(idbToStats([a, nurBerlin], null).streak).toBe(0)
  })
})

describe("Serie rechnet ab dem Tag des Geräts", () => {
  const onDevice = (tz: string) => {
    vi.stubGlobal("window", {})
    vi.stubEnv("TZ", tz)
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("in Los Angeles nachmittags lebt sie noch, obwohl in Berlin schon der übernächste Tag ist", () => {
    onDevice("America/Los_Angeles")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z")) // LA: 05.11. 16:00, Berlin: 06.11. 01:00
    const gestern = entry({ id: "la", createdAt: "2026-11-04T20:00:00.000Z", timeZone: "America/Los_Angeles" })
    expect(idbToStats([gestern], null).streak).toBe(1)
  })
  it("in Sydney morgens ist sie gerissen, obwohl in Berlin noch gestern wäre", () => {
    onDevice("Australia/Sydney")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-05T21:00:00.000Z")) // Sydney: 06.11. 08:00, Berlin: 05.11. 22:00
    const vorgestern = entry({ id: "sy", createdAt: "2026-11-04T01:00:00.000Z", timeZone: "Australia/Sydney" }) // 04.11. 12:00
    expect(idbToStats([vorgestern], null).streak).toBe(0)
  })
  it("„An diesem Tag“ zählt offline ab dem Tag des Geräts", () => {
    onDevice("America/Los_Angeles")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z")) // LA: 05.11., Berlin: 06.11.
    const vorEinemJahr = entry({ id: "alt", createdAt: "2025-11-05T20:00:00.000Z", timeZone: "America/Los_Angeles" })
    expect(idbToStats([vorEinemJahr], null).onThisDayCount).toBe(1)
    expect(todayAnchor()).toBe("2026-11-05")
  })
  it("zu Hause mit einem Eintrag aus Australien, der schon morgen steht, und nichts von heute", () => {
    onDevice("Europe/Berlin")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-04T20:00:00.000Z")) // Berlin: 04.11. 21:00, Sydney: 05.11. 07:00
    const vorgestern = entry({ id: "b1", createdAt: "2026-11-02T12:00:00.000Z", timeZone: "Europe/Berlin" })
    const gestern = entry({ id: "b2", createdAt: "2026-11-03T12:00:00.000Z", timeZone: "Europe/Berlin" })
    expect(idbToStats([vorgestern, gestern], null).streak).toBe(2)
    const sydney = entry({ id: "sy", createdAt: "2026-11-04T20:00:00.000Z", timeZone: "Australia/Sydney" })
    expect(idbToStats([vorgestern, gestern, sydney], null).streak).toBe(1)
  })
})

describe("Neue Einträge merken sich die Zone", () => {
  it("die Warteschlange trägt die Zone mit", () => {
    const edit = buildQueuedEdit({
      queuedAt: "2026-01-01T00:00:00.000Z",
      payload: {
        text: "x", journalId: "j", createdAt: "2026-01-01T00:00:00.000Z", starred: false, tags: [], photos: [],
        locationName: null, locationLat: null, locationLng: null,
        weatherDescription: null, weatherTempCelsius: null, weatherIcon: null, timeZone: "Asia/Tokyo",
      },
    })
    expect(edit.payload?.timeZone).toBe("Asia/Tokyo")
  })
})

describe("acceptedTimeZone: nur was Browser UND Datenbank gleich verstehen", () => {
  const ok = { query: vi.fn(async () => ({ rows: [] })) }
  beforeEach(() => {
    resetAcceptedTimeZones()
    ok.query.mockClear()
  })
  it("lässt IANA-Namen durch und fragt die Datenbank nur einmal", async () => {
    expect(await acceptedTimeZone(ok, "Asia/Bangkok")).toBe("Asia/Bangkok")
    expect(await acceptedTimeZone(ok, "Asia/Bangkok")).toBe("Asia/Bangkok")
    expect(ok.query).toHaveBeenCalledTimes(1)
  })
  it("lehnt Versatz-Schreibweisen ab: Postgres liest deren Vorzeichen umgekehrt", async () => {
    for (const tz of ["+02:00", "GMT+2", "UTC+2", "-05:00"]) {
      expect(await acceptedTimeZone(ok, tz)).toBeNull()
    }
    expect(ok.query).not.toHaveBeenCalled()
  })
  it("lehnt Unsinn und Nicht-Texte ab", async () => {
    for (const tz of ["Mars/Olympus", "", null, undefined, 42, "x".repeat(200)]) {
      expect(await acceptedTimeZone(ok, tz)).toBeNull()
    }
  })
  it("lehnt ab, was die Datenbank nicht kennt, und fragt danach nicht mehr", async () => {
    const refusing = {
      query: vi.fn(async () => {
        throw Object.assign(new Error('time zone "Asia/Bangkok" not recognized'), { code: "22023" })
      }),
    }
    expect(await acceptedTimeZone(refusing, "Asia/Bangkok")).toBeNull()
    expect(await acceptedTimeZone(refusing, "Asia/Bangkok")).toBeNull()
    expect(refusing.query).toHaveBeenCalledTimes(1)
  })
  it("merkt sich einen kurzen Datenbankfehler nicht als unbekannte Zone", async () => {
    const flaky = {
      query: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("timeout exceeded when trying to connect"), { code: undefined }))
        .mockResolvedValue({ rows: [] }),
    }
    await expect(acceptedTimeZone(flaky, "Europe/Berlin")).rejects.toThrow("timeout")
    expect(await acceptedTimeZone(flaky, "Europe/Berlin")).toBe("Europe/Berlin")
  })
})

describe("Datenbank-Vertrag", () => {
  const root = join(__dirname, "..")
  it("das Schema prüft erst und nimmt nur dann eine Tabellensperre", () => {
    const schema = readFileSync(join(root, "src/lib/db/schema.sql"), "utf-8")
    expect(schema).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1 FROM information_schema\.columns\s*WHERE table_name = 'entries' AND column_name = 'time_zone'\s*\) THEN\s*ALTER TABLE entries ADD COLUMN time_zone TEXT;/
    )
    expect(schema).not.toMatch(/ADD COLUMN IF NOT EXISTS time_zone/)
  })
  it("eine Rücksicherung legt die Spalte direkt nach pg_restore an, sonst scheitert jede Abfrage", () => {
    const script = readFileSync(join(root, "scripts/backup/restore.sh"), "utf-8")
    const restore = script.indexOf('pg_restore --dbname=')
    const alter = script.indexOf("ALTER TABLE entries ADD COLUMN IF NOT EXISTS time_zone TEXT")
    const media = script.indexOf("rsync", restore)
    expect(restore).toBeGreaterThan(-1)
    expect(alter).toBeGreaterThan(restore)
    expect(alter).toBeLessThan(media)
  })
  it("der Service Worker wechselt die Version, weil sich API-Form und Offline-Daten ändern", () => {
    expect(readFileSync(join(root, "public/sw.js"), "utf-8")).toMatch(/const SHELL_VER = ["']v11["']/)
  })
})
