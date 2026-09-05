/**
 * LRU eviction logic — pure unit tests.
 * Browser-API modules (IDB, Cache Storage, SW) require e2e testing.
 */
import { describe, it, expect } from "vitest"
import { selectEvictionTargets, DEFAULT_MEDIA_BUDGET_BYTES } from "@/lib/offline/lru-logic"
import type { MediaLRUEntry } from "@/lib/offline/lru-logic"

function makeEntry(overrides: Partial<MediaLRUEntry> & { url: string; entryId: string }): MediaLRUEntry {
  return {
    url: overrides.url,
    entryId: overrides.entryId,
    cachedAt: overrides.cachedAt ?? "2026-07-01T10:00:00.000Z",
    lastAccessedAt: overrides.lastAccessedAt ?? "2026-07-01T10:00:00.000Z",
    sizeBytes: overrides.sizeBytes ?? 1024 * 1024,
  }
}

describe("selectEvictionTargets", () => {
  it("returns empty when total is within budget", () => {
    const entries = [
      makeEntry({ url: "u1", entryId: "e1", sizeBytes: 10 }),
      makeEntry({ url: "u2", entryId: "e2", sizeBytes: 20 }),
    ]
    expect(selectEvictionTargets(entries, new Set(), 100)).toEqual([])
  })

  it("returns empty for an empty entry list", () => {
    expect(selectEvictionTargets([], new Set(), 100)).toEqual([])
  })

  it("evicts oldest-first by lastAccessedAt when over budget", () => {
    const entries = [
      makeEntry({ url: "old", entryId: "e1", lastAccessedAt: "2026-07-01T00:00:00.000Z", sizeBytes: 60 }),
      makeEntry({ url: "new", entryId: "e2", lastAccessedAt: "2026-07-02T00:00:00.000Z", sizeBytes: 60 }),
    ]
    // Total = 120, budget = 100 → need to evict 20+ bytes → evict old (60 bytes brings total to 60)
    const targets = selectEvictionTargets(entries, new Set(), 100)
    expect(targets).toContain("old")
    expect(targets).not.toContain("new")
  })

  it("never evicts pinned entry media", () => {
    const entries = [
      makeEntry({ url: "pinned-old", entryId: "pinned", lastAccessedAt: "2026-07-01T00:00:00.000Z", sizeBytes: 60 }),
      makeEntry({ url: "unpinned-new", entryId: "normal", lastAccessedAt: "2026-07-02T00:00:00.000Z", sizeBytes: 60 }),
    ]
    const pinned = new Set<string>(["pinned"])
    const targets = selectEvictionTargets(entries, pinned, 100)
    expect(targets).not.toContain("pinned-old")
    expect(targets).toContain("unpinned-new")
  })

  it("evicts multiple entries to reach budget", () => {
    const entries = [
      makeEntry({ url: "u1", entryId: "e1", lastAccessedAt: "2026-07-01T00:00:00.000Z", sizeBytes: 40 }),
      makeEntry({ url: "u2", entryId: "e2", lastAccessedAt: "2026-07-02T00:00:00.000Z", sizeBytes: 40 }),
      makeEntry({ url: "u3", entryId: "e3", lastAccessedAt: "2026-07-03T00:00:00.000Z", sizeBytes: 40 }),
    ]
    // Total = 120, budget = 60 → evict u1+u2 (80 bytes) to reach 40 ≤ 60
    const targets = selectEvictionTargets(entries, new Set(), 60)
    expect(targets).toContain("u1")
    expect(targets).toContain("u2")
    expect(targets).not.toContain("u3")
  })

  it("returns empty when all over-budget entries are pinned", () => {
    const entries = [
      makeEntry({ url: "u1", entryId: "e1", sizeBytes: 200 }),
    ]
    const pinned = new Set<string>(["e1"])
    expect(selectEvictionTargets(entries, pinned, 100)).toEqual([])
  })

  it("evicts unpinned when both pinned and unpinned exceed budget", () => {
    const entries = [
      makeEntry({ url: "pinned-url", entryId: "pinned", sizeBytes: 80 }),
      makeEntry({ url: "unpinned-url", entryId: "normal", lastAccessedAt: "2026-07-01T00:00:00.000Z", sizeBytes: 80 }),
    ]
    const pinned = new Set<string>(["pinned"])
    // Total = 160, budget = 100 → can only evict unpinned
    const targets = selectEvictionTargets(entries, pinned, 100)
    expect(targets).toContain("unpinned-url")
    expect(targets).not.toContain("pinned-url")
  })

  it("stops evicting once under budget even if more entries exist", () => {
    const entries = [
      makeEntry({ url: "u1", entryId: "e1", lastAccessedAt: "2026-07-01T00:00:00.000Z", sizeBytes: 50 }),
      makeEntry({ url: "u2", entryId: "e2", lastAccessedAt: "2026-07-02T00:00:00.000Z", sizeBytes: 50 }),
      makeEntry({ url: "u3", entryId: "e3", lastAccessedAt: "2026-07-03T00:00:00.000Z", sizeBytes: 50 }),
    ]
    // Total = 150, budget = 110 → need to evict 40+ bytes → evict u1 (50) enough
    const targets = selectEvictionTargets(entries, new Set(), 110)
    expect(targets).toHaveLength(1)
    expect(targets).toContain("u1")
  })
})

describe("DEFAULT_MEDIA_BUDGET_BYTES", () => {
  it("is 200 MiB", () => {
    expect(DEFAULT_MEDIA_BUDGET_BYTES).toBe(200 * 1024 * 1024)
  })
})
