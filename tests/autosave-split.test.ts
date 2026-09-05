import { describe, it, expect, vi } from "vitest"
import {
  saveSilently,
  saveAndClose,
  type SavePayload,
  type SaveOptions,
} from "../src/lib/editor/save-logic"

const basePayload: SavePayload = {
  text: "Test journal entry",
  journalId: "j-1",
  createdAt: "2026-07-16T10:00:00.000Z",
  starred: false,
  tags: [],
  photos: [],
  locationName: null,
  locationLat: null,
  locationLng: null,
  weatherDescription: null,
  weatherTempCelsius: null,
  weatherIcon: null,
}

function makeOkFetch(id = "entry-abc"): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id }),
    text: async () => "",
  } as unknown as Response)
}

function makeFailFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({}),
    text: async () => "Server error",
  } as unknown as Response)
}

const baseOptions = (fetchFn: typeof fetch, navigate = vi.fn()): SaveOptions => ({
  entryId: null,
  savedEntryId: null,
  navigate,
  fetchFn,
  isOnline: () => true,
})

// ── saveSilently ──────────────────────────────────────────────────────────────

describe("saveSilently", () => {
  it("never calls navigate on success", async () => {
    const navigate = vi.fn()
    await saveSilently(basePayload, { ...baseOptions(makeOkFetch(), navigate) })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("never calls navigate on error", async () => {
    const navigate = vi.fn()
    await saveSilently(basePayload, { ...baseOptions(makeFailFetch(), navigate) })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("POSTs to /api/entries for a new entry", async () => {
    const fetchFn = makeOkFetch()
    await saveSilently(basePayload, baseOptions(fetchFn))
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/api/entries")
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("POST")
  })

  it("returns createdEntryId from the POST response", async () => {
    const result = await saveSilently(basePayload, {
      ...baseOptions(makeOkFetch("new-42")),
    })
    expect(result.ok).toBe(true)
    expect(result.createdEntryId).toBe("new-42")
  })

  it("PUTs to /api/entries/:id when savedEntryId is set (avoids duplicate POST)", async () => {
    const fetchFn = makeOkFetch()
    await saveSilently(basePayload, {
      ...baseOptions(fetchFn),
      savedEntryId: "prev-saved-id",
    })
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("/api/entries/prev-saved-id")
    expect(init.method).toBe("PUT")
  })

  it("PUTs to /api/entries/:id when entryId is set (edit mode)", async () => {
    const fetchFn = makeOkFetch()
    await saveSilently(basePayload, {
      ...baseOptions(fetchFn),
      entryId: "edit-id-99",
    })
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe("/api/entries/edit-id-99")
    expect(init.method).toBe("PUT")
  })

  it("returns error string on HTTP failure", async () => {
    const result = await saveSilently(basePayload, baseOptions(makeFailFetch()))
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// ── offline rescue — TypeError with onLine=true ──────────────────────────────
// navigator.onLine is true but the Pi is unreachable (wrong subnet, VPN, server
// down). fetch throws TypeError — the offline queue must be written regardless.

describe("offline rescue — TypeError with isOnline=true", () => {
  function makeNetworkErrorFetch(): typeof fetch {
    return vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
  }

  it("saveSilently writes to offline queue when fetch throws TypeError and isOnline=true", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate: vi.fn(),
      fetchFn: makeNetworkErrorFetch(),
      isOnline: () => true,
      saveOffline,
    })
    expect(saveOffline).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
  })

  it("saveAndClose rescues and navigates when fetch throws TypeError and isOnline=true", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const navigate = vi.fn()
    const result = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate,
      fetchFn: makeNetworkErrorFetch(),
      isOnline: () => true,
      saveOffline,
    })
    expect(saveOffline).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  it("returns error when TypeError thrown and no saveOffline provided", async () => {
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate: vi.fn(),
      fetchFn: makeNetworkErrorFetch(),
      isOnline: () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("pre-check path (isOnline=false) still calls saveOffline before fetch", async () => {
    const saveOffline = vi.fn().mockResolvedValue(undefined)
    const fetchFn = makeNetworkErrorFetch()
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate: vi.fn(),
      fetchFn,
      isOnline: () => false,
      saveOffline,
    })
    // fetch is never called — offline path triggers before the try block
    expect(fetchFn).not.toHaveBeenCalled()
    expect(saveOffline).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  // Regression: if saveOffline throws (e.g. dynamic import fails offline),
  // the German error message must surface — not a silent empty result.
  it("isOnline=false + saveOffline throws → returns Offline-Speicherung fehlgeschlagen", async () => {
    const saveOffline = vi.fn().mockRejectedValue(new Error("ChunkLoadError: chunk not found"))
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate: vi.fn(),
      fetchFn: makeNetworkErrorFetch(),
      isOnline: () => false,
      saveOffline,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Offline-Speicherung fehlgeschlagen/)
  })

  it("isOnline=true TypeError + saveOffline throws → returns error string", async () => {
    const saveOffline = vi.fn().mockRejectedValue(new Error("ChunkLoadError: chunk not found"))
    const result = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: null,
      navigate: vi.fn(),
      fetchFn: makeNetworkErrorFetch(),
      isOnline: () => true,
      saveOffline,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// ── saveAndClose ──────────────────────────────────────────────────────────────

describe("saveAndClose", () => {
  it("calls navigate exactly once on success", async () => {
    const navigate = vi.fn()
    await saveAndClose(basePayload, { ...baseOptions(makeOkFetch(), navigate) })
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it("does not call navigate on HTTP error", async () => {
    const navigate = vi.fn()
    await saveAndClose(basePayload, { ...baseOptions(makeFailFetch(), navigate) })
    expect(navigate).not.toHaveBeenCalled()
  })
})

// ── deduplication: new entry + 2 silent saves + saveAndClose ─────────────────

describe("deduplication", () => {
  it("sends exactly 1 POST and 2 PUTs for new entry + 2 silent saves + saveAndClose", async () => {
    const navigate = vi.fn()

    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "created-id" }),
        text: async () => "",
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response)

    // Simulate how the component manages savedEntryId via ref
    let capturedId: string | null = null

    const r1 = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: capturedId,
      navigate,
      fetchFn,
      isOnline: () => true,
    })
    expect(r1.ok).toBe(true)
    capturedId = r1.createdEntryId  // component updates the ref

    const r2 = await saveSilently(basePayload, {
      entryId: null,
      savedEntryId: capturedId,
      navigate,
      fetchFn,
      isOnline: () => true,
    })
    expect(r2.ok).toBe(true)

    const r3 = await saveAndClose(basePayload, {
      entryId: null,
      savedEntryId: capturedId,
      navigate,
      fetchFn,
      isOnline: () => true,
    })
    expect(r3.ok).toBe(true)

    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
    const methods = calls.map((c) => (c[1] as RequestInit).method)
    const urls = calls.map((c) => c[0] as string)

    expect(methods.filter((m) => m === "POST")).toHaveLength(1)
    expect(methods.filter((m) => m === "PUT")).toHaveLength(2)
    expect(urls[1]).toBe("/api/entries/created-id")
    expect(urls[2]).toBe("/api/entries/created-id")
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})
