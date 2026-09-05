/**
 * Erst-Sync vor dem PIN-Setup:
 *
 * isVaultBlockingSync blockte nur den Status "locked". Auf einem frischen
 * Gerät (Login erledigt, PIN-Setup-Screen offen, Status "none") lief der
 * Sync durch den Passthrough-Adapter und zog das KOMPLETTE Journal im
 * KLARTEXT in die IndexedDB — wer das Setup abbrach (Tab zu), hatte alle
 * Daten unverschlüsselt und ungesperrt auf dem Gerät liegen. Das bricht das
 * Verschlüsselungs-Versprechen genau im Onboarding-Moment.
 *
 * Regel: Sync läuft NUR im Status "unlocked" — nach dem Setup stößt der
 * Vault-Subscriber in useSync den aufgestauten Sync automatisch an.
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const vaultState: { dek: object | null; status: "none" | "locked" | "unlocked" } = {
  dek: null,
  status: "none",
}

vi.mock("@/lib/vault/vault", () => ({
  getSessionDek: () => vaultState.dek,
  getVaultStatus: async () => vaultState.status,
  subscribeVault: () => () => {},
  isVaultLockError: () => false,
}))

import { isVaultBlockingSync } from "@/hooks/useSync"

describe("Vault-Gate für den Sync (B07)", () => {
  beforeEach(() => {
    vaultState.dek = null
    vaultState.status = "none"
  })

  it("Status 'none' (vor dem PIN-Setup) blockiert den Sync — kein Klartext-Erstsync", async () => {
    expect(await isVaultBlockingSync()).toBe(true)
  })

  it("Status 'locked' blockiert weiterhin", async () => {
    vaultState.status = "locked"
    expect(await isVaultBlockingSync()).toBe(true)
  })

  it("entsperrt (Session-DEK vorhanden) blockiert nicht", async () => {
    vaultState.dek = {}
    vaultState.status = "unlocked"
    expect(await isVaultBlockingSync()).toBe(false)
  })
})
