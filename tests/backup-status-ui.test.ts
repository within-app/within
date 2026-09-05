/**
 * Backup-Status in den Settings.
 *
 * /api/backup/status existierte ohne UI-Consumer: Der Status war nur per curl
 * sichtbar — still sterbende Backups sind exakt die Fehlerklasse, die dieser
 * Befund produzierte (Endpoint blieb wochenlang auf einem alten "ok").
 *
 * Die Karte konsumiert eine reine Klassifikations-Funktion (Node-testbar,
 * Route Handler / UI bleiben dünn — Repo-Architekturregel):
 *   ok          → letzter Lauf ok und jünger als 26 h (gleiche Schwelle wie
 *                 backup-verify.sh: ein alter restorebarer Dump ist KEIN
 *                 gesundes Backup)
 *   stale       → letzter Lauf ok, aber älter als 26 h
 *   error       → letzter Lauf fehlgeschlagen
 *   none        → noch nie gelaufen (no_runs_yet)
 *   unavailable → Endpoint 503 / kein DATABASE_URL / nicht erreichbar
 */
import { describe, it, expect } from "vitest"
import {
  BACKUP_STALE_HOURS,
  classifyBackupStatus,
  type BackupStatusRow,
} from "../src/lib/backup-status"

const NOW = new Date("2026-08-22T20:00:00.000Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

const okRow = (h: number): BackupStatusRow => ({
  status: "ok",
  run_at: hoursAgo(h),
  backup_file: "within_20260822_020000.dump",
  error_msg: null,
})

describe("classifyBackupStatus (Punkt 3)", () => {
  it("frischer ok-Lauf → ok", () => {
    expect(classifyBackupStatus(okRow(5), 200, NOW)).toBe("ok")
  })

  it("ok-Lauf älter als die Stale-Schwelle → stale (Backup-full läuft nicht mehr)", () => {
    expect(BACKUP_STALE_HOURS).toBe(26)
    expect(classifyBackupStatus(okRow(27), 200, NOW)).toBe("stale")
    expect(classifyBackupStatus(okRow(25), 200, NOW)).toBe("ok")
  })

  it("error-Row → error (z. B. 'backup destination not mounted')", () => {
    expect(
      classifyBackupStatus(
        { status: "error", run_at: hoursAgo(1), error_msg: "backup destination not mounted: /mnt/nas/within-backups" },
        200,
        NOW
      )
    ).toBe("error")
  })

  it("no_runs_yet → none", () => {
    expect(classifyBackupStatus({ status: "no_runs_yet" }, 200, NOW)).toBe("none")
  })

  it("HTTP 503 oder fehlende Antwort → unavailable (nie ein stilles ok)", () => {
    expect(classifyBackupStatus(null, 503, NOW)).toBe("unavailable")
    expect(classifyBackupStatus(null, 200, NOW)).toBe("unavailable")
  })

  it("ok ohne run_at (kaputte Row) → error, nicht ok", () => {
    expect(classifyBackupStatus({ status: "ok" }, 200, NOW)).toBe("error")
  })
})

describe("Settings-Seite konsumiert den Status (Source-Contract)", () => {
  it("die Settings-Seite rendert eine Backup-Sektion mit classifyBackupStatus", async () => {
    const { readFileSync } = await import("fs")
    const { resolve } = await import("path")
    const page = readFileSync(resolve(__dirname, "../src/app/settings/page.tsx"), "utf8")
    expect(page).toContain("classifyBackupStatus")
    expect(page).toContain("/api/backup/status")
  })
})
