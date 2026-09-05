/**
 * Serialise async runs that mutate shared state.
 *
 * The timeline's load effect re-runs on every filter/journal/page change, and
 * each run reads IDB and mutates the shared preview-URL cache. Two overlapping
 * runs with differently old outbox snapshots revoke/create URLs against each
 * other — `AbortController` does not help because it only stops the fetch, not
 * the continuation. Chaining the runs makes interleaved cache mutation
 * structurally impossible.
 */

export interface RunChainRef {
  current: Promise<unknown>
}

/**
 * Run `task` after every previously chained task has settled. Rejections are
 * contained: a failing task rejects its own caller but never wedges the chain.
 */
export function chainSequential<T>(ref: RunChainRef, task: () => Promise<T>): Promise<T> {
  const next = ref.current.then(task)
  ref.current = next.then(
    () => undefined,
    () => undefined
  )
  return next
}
