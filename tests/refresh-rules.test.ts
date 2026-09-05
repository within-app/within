/**
 * Sichtbarkeitsloch: Upload landet zwischen Server-Fetch und
 * Outbox-Lesen einer offenen Ansicht. Die Heilung ist ein Nonce-Refresh nach
 * jedem Sync-Lauf, der Medien hochgeladen hat (refresh-rules.ts); page.tsx
 * bumpt darauf timelineNonce und detailNonce.
 *
 * Synthetische Daten.
 */

import { describe, it, expect } from "vitest"
import { syncRequiresMediaRefresh } from "../src/lib/sync/refresh-rules"
import type { SyncResult } from "../src/lib/sync/types"

function makeResult(over: Partial<SyncResult> = {}): SyncResult {
  return {
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    errors: 0,
    mediaUploaded: 0,
    mediaFailed: 0,
    ...over,
  }
}

describe("syncRequiresMediaRefresh", () => {
  it("fordert den Refresh nach hochgeladenen Medien", () => {
    expect(syncRequiresMediaRefresh(makeResult({ mediaUploaded: 1 }))).toBe(true)
  })

  it("fordert keinen Refresh, wenn nichts hochgeladen wurde", () => {
    expect(syncRequiresMediaRefresh(makeResult())).toBe(false)
    expect(syncRequiresMediaRefresh(null)).toBe(false)
  })

  it("reagiert nicht auf reine Fehlläufe — die ändern serverseitig nichts", () => {
    expect(syncRequiresMediaRefresh(makeResult({ mediaFailed: 3, errors: 2 }))).toBe(false)
  })
})
