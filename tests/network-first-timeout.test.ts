/**
 * Timeout für network-first-Fetches (Timeline, Detail):
 *
 * Bei „WLAN da, Pi nicht" (navigator.onLine === true) hing die Ansicht bis
 * zum TCP-Timeout im Skeleton, obwohl alles in IndexedDB liegt — der Abort
 * kam nur im Effekt-Cleanup. Jetzt bricht abortAfter() den Fetch nach 6 s ab,
 * und der bestehende Offline-Fallback greift: ein Timeout-Abort darf dort
 * nicht mehr als „Cleanup" früh zurückkehren (Source-Guards unten, Muster
 * map-offline-guard).
 *
 * Nur synthetische Daten.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { abortAfter, NETWORK_FIRST_TIMEOUT_MS } from "@/lib/network-first-timeout"

afterEach(() => vi.useRealTimers())

/** Ein Fetch, der nie antwortet — nur der Abort beendet ihn. */
function neverResolvingFetch(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  })
}

describe("abortAfter()", () => {
  it("bricht den Fetch nach 6 s ab", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    abortAfter(controller)
    const outcome = neverResolvingFetch(controller.signal).catch((e: Error) => e.name)

    await vi.advanceTimersByTimeAsync(NETWORK_FIRST_TIMEOUT_MS - 1)
    expect(controller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.signal.aborted).toBe(true)
    expect(await outcome).toBe("AbortError")
    expect(NETWORK_FIRST_TIMEOUT_MS).toBe(6000)
  })

  it("der Cleanup räumt den Timer — kein Abort nach dem Unmount", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const clear = abortAfter(controller)
    clear()
    await vi.advanceTimersByTimeAsync(NETWORK_FIRST_TIMEOUT_MS + 1)
    expect(controller.signal.aborted).toBe(false)
  })
})

describe("Source-Guards: Timeline und Detail nutzen den Timeout und lassen den Timeout-Abort in den IDB-Fallback", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf-8")

  it.each([
    "src/components/timeline/timeline-view.tsx",
    "src/components/detail/entry-detail.tsx",
  ])("%s", (file) => {
    const src = read(file)
    expect(src).toContain("abortAfter(controller")
    // Ein Abort-Fehler ist nicht automatisch „Cleanup" — nur `cancelled` sagt das.
    expect(src).not.toContain('name === "AbortError") return')
    // Der Timer wird nach erfolgreichem Fetch geräumt, nicht erst im Teardown.
    expect(src.match(/clearAbortTimer\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it("Timeline: nur Seite 1 hat den Timeout — Seite N ohne IDB-Fallback würde sonst zurück nach oben gespult", () => {
    expect(read("src/components/timeline/timeline-view.tsx")).toContain("page === 1 ? abortAfter(controller)")
  })
})
