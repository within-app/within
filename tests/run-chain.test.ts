/**
 * chainSequential: Serialisierung der Timeline-Ladeläufe.
 *
 * Zwei überlappende Läufe mutieren den geteilten Preview-URL-Cache
 * gegeneinander; AbortController stoppt nur den fetch, nicht die Continuation.
 * Die Kette macht verschachtelte Cache-Mutation strukturell unmöglich.
 */

import { describe, it, expect } from "vitest"
import { chainSequential, type RunChainRef } from "../src/lib/sync/run-chain"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("chainSequential", () => {
  it("startet den zweiten Lauf erst, wenn der erste fertig ist", async () => {
    const ref: RunChainRef = { current: Promise.resolve() }
    const events: string[] = []
    const gate = deferred<void>()

    const first = chainSequential(ref, async () => {
      events.push("first:start")
      await gate.promise
      events.push("first:end")
      return 1
    })
    const second = chainSequential(ref, async () => {
      events.push("second:start")
      return 2
    })

    // Mikrotasks laufen lassen: der zweite darf noch nicht gestartet sein.
    await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual(["first:start"])

    gate.resolve()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(events).toEqual(["first:start", "first:end", "second:start"])
  })

  it("reicht das Ergebnis des eigenen Tasks durch", async () => {
    const ref: RunChainRef = { current: Promise.resolve() }
    expect(await chainSequential(ref, async () => "ok")).toBe("ok")
  })

  it("verklemmt die Kette nicht, wenn ein Task wirft", async () => {
    const ref: RunChainRef = { current: Promise.resolve() }
    const failing = chainSequential(ref, async () => {
      throw new Error("synthetic failure")
    })
    await expect(failing).rejects.toThrow("synthetic failure")
    // Der nächste Lauf startet trotzdem.
    expect(await chainSequential(ref, async () => "after")).toBe("after")
  })
})
