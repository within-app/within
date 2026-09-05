/**
 * requestStoragePersistence() — unit tests
 *
 * Verifies that navigator.storage.persist() is called on sync engine init
 * and that the helper is a no-op when the API is absent.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { requestStoragePersistence } from "@/hooks/useSync"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("requestStoragePersistence", () => {
  it("calls navigator.storage.persist() and returns without throwing", async () => {
    const mockPersist = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("navigator", {
      storage: { persist: mockPersist },
    })

    await expect(requestStoragePersistence()).resolves.toBeUndefined()
    expect(mockPersist).toHaveBeenCalledOnce()
  })

  it("logs the granted=true result", async () => {
    const mockPersist = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("navigator", { storage: { persist: mockPersist } })
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    await requestStoragePersistence()

    expect(consoleSpy).toHaveBeenCalledWith(
      "[within/sync] storage.persist granted:",
      true,
    )
  })

  it("logs granted=false (PWA not installed / quota low)", async () => {
    const mockPersist = vi.fn().mockResolvedValue(false)
    vi.stubGlobal("navigator", { storage: { persist: mockPersist } })
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    await requestStoragePersistence()

    expect(consoleSpy).toHaveBeenCalledWith(
      "[within/sync] storage.persist granted:",
      false,
    )
  })

  it("does not throw when navigator.storage is absent (older browser / non-secure context)", async () => {
    vi.stubGlobal("navigator", {})

    await expect(requestStoragePersistence()).resolves.toBeUndefined()
  })

  it("does not throw when navigator.storage.persist is absent", async () => {
    vi.stubGlobal("navigator", { storage: {} })

    await expect(requestStoragePersistence()).resolves.toBeUndefined()
  })

  it("does not log when persist returns undefined (API absent path)", async () => {
    vi.stubGlobal("navigator", { storage: { persist: vi.fn().mockResolvedValue(undefined) } })
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    await requestStoragePersistence()

    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
