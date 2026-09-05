/**
 * SW-Update-Fluss-Härtung (Feldbefund): Ein dauerhaft offener Tab
 * erfährt vom Deploy nichts — navigator.serviceWorker.register() prüft nur
 * beim Seitenladen auf neue SW-Bytes, App-Router-Navigationen sind
 * Soft-Navigationen ohne Update-Check. Wer den Tab offen ließ, arbeitete nach
 * dem Deploy unbemerkt mit den alten Page-Chunks weiter (Pin blieb geräte-lokal).
 *
 * wireSwUpdateTriggers ergänzt drei Check-Anlässe, ohne die
 * SKIP_WAITING-Semantik anzufassen (Update aktiviert weiterhin NUR nach
 * Nutzer-Bestätigung — Stolperdraht 5):
 *   1. Intervall (Deploy während der Tab offen ist),
 *   2. Tab wird sichtbar (Deploy in Nachbar-Tab → zurückwechseln),
 *   3. online-Event (Handy kommt aus dem Flugmodus).
 *
 * Synthetic data only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  wireSwUpdateTriggers,
  SW_UPDATE_CHECK_INTERVAL_MS,
} from "@/lib/sw-update-triggers"

class FakeTarget {
  listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, cb: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(cb)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb)
  }
  dispatch(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb()
  }
}

function makeDoc(state: string) {
  const doc = new FakeTarget() as FakeTarget & { visibilityState: string }
  doc.visibilityState = state
  return doc
}

describe("wireSwUpdateTriggers", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("checks on every interval tick", () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const win = new FakeTarget()
    const doc = makeDoc("visible")
    wireSwUpdateTriggers(check, { win, doc })

    expect(check).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS)
    expect(check).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS * 2)
    expect(check).toHaveBeenCalledTimes(3)
  })

  it("checks when the tab becomes visible — not when it hides", () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const win = new FakeTarget()
    const doc = makeDoc("hidden")
    wireSwUpdateTriggers(check, { win, doc })

    doc.dispatch("visibilitychange") // hidden → kein Check
    expect(check).not.toHaveBeenCalled()

    doc.visibilityState = "visible"
    doc.dispatch("visibilitychange")
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("checks on the online event (Flugmodus-Ende)", () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const win = new FakeTarget()
    const doc = makeDoc("visible")
    wireSwUpdateTriggers(check, { win, doc })

    win.dispatch("online")
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("swallows check() rejections (reg.update() wirft offline)", async () => {
    const check = vi.fn().mockRejectedValue(new Error("offline"))
    const win = new FakeTarget()
    const doc = makeDoc("visible")
    wireSwUpdateTriggers(check, { win, doc })

    win.dispatch("online")
    // Ein unbehandeltes Rejection würde den Test-Runner scharf machen —
    // hier reicht: Microtasks abarbeiten, ohne dass etwas hochschlägt.
    // (runAllTimersAsync liefe mit dem Interval endlos.)
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("cleanup stops interval and removes both listeners", () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const win = new FakeTarget()
    const doc = makeDoc("visible")
    const cleanup = wireSwUpdateTriggers(check, { win, doc })

    cleanup()
    vi.advanceTimersByTime(SW_UPDATE_CHECK_INTERVAL_MS * 3)
    win.dispatch("online")
    doc.dispatch("visibilitychange")
    expect(check).not.toHaveBeenCalled()
  })
})
