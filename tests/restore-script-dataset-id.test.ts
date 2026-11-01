/**
 * scripts/backup/restore.sh wechselt die Datenbestand-Kennung.
 *
 * Nach dem pg_restore trägt die Datenbank die Kennung aus dem Dump — dieselbe,
 * die andere Geräte vor dem Restore gesehen haben. Ohne Wechsel würden sie
 * ihren Delta-Cursor behalten und den wiederhergestellten Stand nie vollständig
 * ziehen. Der Wechsel muss nach pg_restore und vor der restore-Zeile in
 * backup_runs stehen (die Zeile ist das „fertig"-Signal für die App).
 *
 * Reiner Textvertrag über das Skript — ausgeführt wird es nur im Container.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const script = readFileSync(join(__dirname, "../scripts/backup/restore.sh"), "utf-8")

describe("restore.sh — dataset_id", () => {
  it("setzt dataset_id per Upsert mit gen_random_uuid() neu", () => {
    expect(script).toMatch(/dataset_id/)
    const rotate = script.split("\n").find((l) => l.includes("dataset_id") && l.includes("gen_random_uuid()"))
    expect(rotate, "Upsert-Zeile fehlt").toBeDefined()
    expect(rotate).toMatch(/ON CONFLICT \(key\) DO UPDATE/)
    expect(rotate).toMatch(/ON_ERROR_STOP=1/)
  })

  it("steht nach pg_restore und vor der restore-Zeile in backup_runs", () => {
    const iRestore = script.indexOf("pg_restore --dbname=")
    const iRotate = script.search(/dataset_id[^\n]*gen_random_uuid\(\)/)
    const iRunRow = script.indexOf("('restore', 'ok'")
    expect(iRestore).toBeGreaterThan(0)
    expect(iRotate).toBeGreaterThan(iRestore)
    expect(iRunRow).toBeGreaterThan(iRotate)
  })
})
