import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * pg Pool must register an 'error' listener before the singleton is
 * cached. Without it, idle-connection drops emit an unhandled 'error' event
 * which crashes the Node process.
 */
describe("db pool error handler", () => {
  beforeEach(() => {
    delete (global as { __pgPool?: unknown }).__pgPool
    vi.resetModules()
  })

  it("registers an error listener on the pool before caching the singleton", async () => {
    const mockOn = vi.fn()
    vi.doMock("pg", () => {
      function Pool() {
        return { on: mockOn, connect: vi.fn(), query: vi.fn(), end: vi.fn() }
      }
      return { Pool }
    })

    await import("../src/lib/db")

    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function))
  })

  it("does not create a second Pool on hot-reload (singleton reuse)", async () => {
    const PoolCtor = vi.fn(function Pool(this: unknown) {
      return { on: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn() }
    })
    vi.doMock("pg", () => ({ Pool: PoolCtor }))

    const { db: db1 } = await import("../src/lib/db")

    vi.resetModules()
    ;(global as { __pgPool?: unknown }).__pgPool = db1

    vi.doMock("pg", () => ({ Pool: PoolCtor }))
    await import("../src/lib/db")

    // Pool constructor should only be called once (singleton reuse on hot-reload)
    expect(PoolCtor).toHaveBeenCalledTimes(1)
  })
})
