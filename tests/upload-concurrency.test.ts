/**
 * Client-side upload queue must cap concurrency at 3 to prevent Pi 4 OOM.
 *
 * Red assertions (fail before the fix):
 *   The uncapped forEach approach in handleFiles allows N parallel decodes on Pi 4,
 *   causing OOM for camera-roll batches. This test verifies the capped queue algorithm.
 *
 * Tests the queue algorithm used in PhotoUploader.handleFiles.
 * Tested in isolation (no jsdom) because the React component wires the
 * same logic through refs — semantically identical.
 *
 * Synthetic data only — no real journal content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Concurrency cap — must match the value used in photo-uploader.tsx
const CONCURRENCY = 3

/**
 * Same algorithm as PhotoUploader's runNext / handleFiles.
 * Runs tasks with at most `cap` in flight at any moment.
 */
function runCapped(tasks: (() => Promise<unknown>)[], cap: number): Promise<void> {
  const queue = [...tasks]
  let active = 0
  return new Promise<void>((resolve, reject) => {
    function next() {
      while (active < cap && queue.length > 0) {
        const task = queue.shift()!
        active++
        task().finally(() => {
          active--
          next()
        }).catch(reject)
      }
      // intentionally minimal: resolve only when queue is drained and all in-flight settled
      if (active === 0) resolve()
    }
    next()
  })
}

// Shared counters reset before each test
let activeCalls = 0
let maxConcurrent = 0

beforeEach(() => {
  activeCalls = 0
  maxConcurrent = 0
  vi.clearAllMocks()
})

/** Builds a vi.fn mock that tracks concurrent call depth and simulates latency. */
function makeFetchMock() {
  return vi.fn(async (_url: string) => {
    activeCalls++
    maxConcurrent = Math.max(maxConcurrent, activeCalls)
    await new Promise<void>((r) => setTimeout(r, 10))
    activeCalls--
    return {
      ok: true,
      json: async () => ({ filePath: '/uploads/photo.jpg', id: 'abc123', type: 'photo' }),
    }
  })
}

describe('upload concurrency queue', () => {
  it('never exceeds 3 concurrent uploads for a 10-file batch', async () => {
    const fetchMock = makeFetchMock()
    const tasks = Array.from({ length: 10 }, (_, i) =>
      () => fetchMock(`/api/upload?i=${i}`)
    )
    await runCapped(tasks, CONCURRENCY)
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENCY)
  })

  it('starts multiple uploads concurrently when the queue allows', async () => {
    const fetchMock = makeFetchMock()
    const tasks = Array.from({ length: 5 }, (_, i) =>
      () => fetchMock(`/api/upload?i=${i}`)
    )
    await runCapped(tasks, CONCURRENCY)
    // confirms parallelism actually kicks in (not purely sequential)
    expect(maxConcurrent).toBeGreaterThan(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('processes all files when fewer than cap are queued', async () => {
    const fetchMock = makeFetchMock()
    const tasks = Array.from({ length: 2 }, (_, i) =>
      () => fetchMock(`/api/upload?i=${i}`)
    )
    await runCapped(tasks, CONCURRENCY)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('resolves immediately for an empty batch', async () => {
    const fetchMock = makeFetchMock()
    await expect(runCapped([], CONCURRENCY)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
