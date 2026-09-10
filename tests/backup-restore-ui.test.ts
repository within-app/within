/**
 * Restore UI (Settings → Backup → Restore).
 *
 * The picker, confirm dialogs and progress dialog live inline in
 * settings/page.tsx (repo convention, see backup-status-ui.test.ts) — this
 * file checks the source wiring plus the one piece cheaply unit-testable in
 * isolation: resetSyncStore() must drop only the sync store, never the vault.
 */
import { describe, it, expect } from "vitest"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

describe("Settings-Seite verdrahtet die Restore-UI (Source-Contract)", () => {
  it("page.tsx nutzt die Restore-Endpunkte, das Bestätigungswort und den Sync-Reset", async () => {
    const { readFileSync } = await import("fs")
    const { resolve } = await import("path")
    const page = readFileSync(resolve(__dirname, "../src/app/settings/page.tsx"), "utf8")
    expect(page).toContain("/api/backup/restore/dumps")
    expect(page).toContain("/api/backup/restore")
    expect(page).toContain("RESTORE_CONFIRM_WORD")
    expect(page).toContain("resetSyncStore")
  })
})

/** Frische fake-IndexedDB, damit Tests sich nicht gegenseitig Datenbanken teilen. */
function seedDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore("meta") }
    req.onsuccess = () => { req.result.close(); resolve() }
    req.onerror = () => reject(req.error)
  })
}

function dbExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let existed = true
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => { existed = false }
    req.onsuccess = () => { req.result.close(); resolve(existed) }
    req.onerror = () => resolve(false)
  })
}

describe("resetSyncStore", () => {
  it("löscht within-sync, lässt die Vault-Datenbank unberührt", async () => {
    globalThis.indexedDB = new IDBFactory()
    await seedDB("within-sync")
    await seedDB("within-vault")

    const { resetSyncStore } = await import("../src/lib/offline/reset-sync-store")
    await resetSyncStore()

    expect(await dbExists("within-sync")).toBe(false)
    expect(await dbExists("within-vault")).toBe(true)
  })
})
