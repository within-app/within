import type { Page } from "@playwright/test"

/**
 * Seit dem PIN-Zwang erzwingt der AppLockProvider
 * vor jedem Inhalt entweder den PinSetupScreen (frisches Browser-Profil, kein
 * Vault) oder den PinLockScreen (nach jedem Reload/Kaltstart — der DEK lebt
 * nur im RAM). Jeder interaktive E2E-Flow muss dieses Gate zuerst räumen,
 * sonst fängt das Overlay (z-9998, aria-modal) alle Pointer-Events ab.
 *
 * Locale-unabhängige Locators: der Setup-Screen hat #vault-pin +
 * #vault-pin-confirm (stabile IDs), der Lock-Screen genau ein Passwortfeld
 * im role=dialog. PIN-Unlock funktioniert offline (PBKDF2 + Unwrap lokal).
 */
export const E2E_PIN = "246810"

export async function ensureVaultUnlocked(page: Page, graceMs = 6_000): Promise<void> {
  const dialog = page.locator('div[role="dialog"][aria-modal="true"]')
  const pinField = dialog.locator('input[type="password"]').first()

  // Bis zu 3 Runden: Beim allerersten SW-Install feuert controllerchange →
  // sw-register lädt die Seite neu (Claim-Reload). Trifft das den laufenden
  // Setup/Unlock, detacht der Dialog (waitFor "hidden" löst aus, ohne dass
  // der Vault wirklich offen ist) und das Gate steht nach dem Reload wieder.
  for (let round = 0; round < 3; round++) {
    try {
      await pinField.waitFor({ state: "visible", timeout: round === 0 ? graceMs : 8_000 })
    } catch {
      return // kein Gate (z. B. /login oder bereits entsperrt)
    }

    const confirm = page.locator("#vault-pin-confirm")
    if (await confirm.isVisible().catch(() => false)) {
      // Setup-Screen (frisches Profil)
      await page.locator("#vault-pin").fill(E2E_PIN)
      await confirm.fill(E2E_PIN)
    } else {
      // Lock-Screen (nach Reload/Kaltstart)
      await pinField.fill(E2E_PIN)
    }
    try {
      await dialog.locator('button[type="submit"]').click()
      // Unlock läuft PBKDF2 mit 600k Iterationen — auf schwachen Runnern dauert das.
      await pinField.waitFor({ state: "hidden", timeout: 20_000 })
    } catch {
      continue // Reload mitten im Submit — nächste Runde räumt das Gate erneut
    }
    // Kurz nachhalten: kommt das Gate sofort zurück (Claim-Reload), nochmal.
    await page.waitForTimeout(750)
    if (!(await pinField.isVisible().catch(() => false))) return
  }
  throw new Error("ensureVaultUnlocked: Vault-Gate nach 3 Runden weiterhin sichtbar")
}
