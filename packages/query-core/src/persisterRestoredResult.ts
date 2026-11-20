import type { QueryState } from './query'
import type { DefaultError } from './types'

/**
 * The value a persister resolves with when it restored a query from storage,
 * instead of running the `queryFn`. It carries the full persisted state so the
 * query can be put back exactly as it was saved.
 */
export interface PersisterRestoredResult<
  TData = unknown,
  TError = DefaultError,
> {
  data: TData | undefined
  state: Partial<QueryState<TData, TError>>
}

const restoredResults = new WeakSet<object>()

/**
 * Wraps data and state restored from storage so the query knows it was
 * restored rather than freshly fetched. The query then takes the persisted
 * state as it is (errors, counters, timestamps, invalidation) with an idle
 * fetch status, and does not fire the cache's success callbacks.
 *
 * If the query already has newer data or a newer error in memory, the newer
 * side is kept; data and error are compared separately by their
 * `dataUpdatedAt` / `errorUpdatedAt` timestamps.
 */
export function createPersisterRestoredResult<
  TData = unknown,
  TError = DefaultError,
>({
  data,
  state,
}: PersisterRestoredResult<TData, TError>): PersisterRestoredResult<
  TData,
  TError
> {
  const result = { data, state }
  restoredResults.add(result)
  return result
}

export function isPersisterRestoredResult(
  value: unknown,
): value is PersisterRestoredResult<any, any> {
  return typeof value === 'object' && value !== null
    ? restoredResults.has(value)
    : false
}

/**
 * Merges a restored state into the state currently in memory.
 * Data fields and error fields are each taken from whichever side is newer.
 * Status, invalidation, failure info and fetch meta come from the side that was
 * updated most recently. Returns `current` unchanged if nothing restored is newer.
 * `fetchStatus` is left as in `current`; callers decide it.
 */
export function mergeRestoredQueryState<TData, TError>(
  current: QueryState<TData, TError>,
  restored: PersisterRestoredResult<TData, TError>,
): QueryState<TData, TError> {
  const persisted = restored.state
  const persistedDataUpdatedAt = persisted.dataUpdatedAt ?? 0
  const persistedErrorUpdatedAt = persisted.errorUpdatedAt ?? 0

  const takeData =
    persistedDataUpdatedAt > current.dataUpdatedAt ||
    (current.data === undefined && restored.data !== undefined)
  const takeError = persistedErrorUpdatedAt > current.errorUpdatedAt

  if (!takeData && !takeError) {
    return current
  }

  const data = takeData ? restored.data : current.data
  const dataUpdatedAt = takeData
    ? persistedDataUpdatedAt
    : current.dataUpdatedAt
  const dataUpdateCount = takeData
    ? (persisted.dataUpdateCount ?? current.dataUpdateCount)
    : current.dataUpdateCount

  const error = takeError ? (persisted.error ?? null) : current.error
  const errorUpdatedAt = takeError
    ? persistedErrorUpdatedAt
    : current.errorUpdatedAt
  const errorUpdateCount = takeError
    ? (persisted.errorUpdateCount ?? current.errorUpdateCount)
    : current.errorUpdateCount

  // Whichever side holds the most recent update decides the remaining fields
  const persistedLatest = Math.max(
    takeData ? persistedDataUpdatedAt : 0,
    takeError ? persistedErrorUpdatedAt : 0,
  )
  const currentLatest = Math.max(
    takeData ? 0 : current.dataUpdatedAt,
    takeError ? 0 : current.errorUpdatedAt,
  )
  const persistedIsLatest = persistedLatest >= currentLatest

  const pick = <TKey extends keyof QueryState<TData, TError>>(key: TKey) =>
    persistedIsLatest && persisted[key] !== undefined
      ? (persisted[key] as QueryState<TData, TError>[TKey])
      : current[key]

  let status = pick('status')
  // Keep status consistent with the data and error that ended up in the state
  if (status === 'error' && error == null) {
    status = data !== undefined ? 'success' : 'pending'
  } else if (status === 'success' && data === undefined) {
    status = error != null ? 'error' : 'pending'
  } else if (status === 'pending' && data !== undefined) {
    status = 'success'
  }

  return {
    ...current,
    data,
    dataUpdatedAt,
    dataUpdateCount,
    error,
    errorUpdatedAt,
    errorUpdateCount,
    status,
    isInvalidated: pick('isInvalidated'),
    fetchFailureCount: pick('fetchFailureCount'),
    fetchFailureReason: pick('fetchFailureReason'),
    fetchMeta: pick('fetchMeta'),
  }
}
