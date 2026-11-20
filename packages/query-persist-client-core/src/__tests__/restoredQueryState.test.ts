import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Mock } from 'vitest'
import { QueryCache, QueryClient } from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import { persistQueryClientRestore } from '../persist'
import type { QueryState } from '@tanstack/query-core'

const NOW = 1_000_000

function persistedErrorState(
  overrides: Partial<QueryState<any, any>> = {},
): QueryState<any, any> {
  return {
    data: 'old-data',
    dataUpdateCount: 3,
    dataUpdatedAt: NOW - 5000,
    error: { message: 'boom' },
    errorUpdateCount: 2,
    errorUpdatedAt: NOW - 1000,
    fetchFailureCount: 1,
    fetchFailureReason: { message: 'boom' },
    fetchMeta: null,
    isInvalidated: true,
    status: 'error',
    fetchStatus: 'idle',
    ...overrides,
  }
}

function createStorage(entries: Record<string, unknown> = {}) {
  const storage = new Map<string, string>()
  for (const [queryHash, state] of Object.entries(entries)) {
    storage.set(
      `${PERSISTER_KEY_PREFIX}-${queryHash}`,
      JSON.stringify({
        buster: '',
        queryHash,
        queryKey: JSON.parse(queryHash),
        state,
      }),
    )
  }
  return {
    getItem: (key: string) => Promise.resolve(storage.get(key)),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      storage.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(storage.entries())),
  }
}

describe('restoring the full persisted query state', () => {
  let onSuccess: Mock<(...args: Array<any>) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    onSuccess = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('persisterFn restores errors, counters, timestamps and invalidation', async () => {
    const state = persistedErrorState()
    const persister = experimental_createQueryPersister({
      storage: createStorage({ '["a"]': state }),
      refetchOnRestore: false,
    })
    const queryClient = new QueryClient({
      queryCache: new QueryCache({ onSuccess }),
    })
    const queryFn = vi.fn(() => 'network')

    await queryClient.fetchQuery({
      queryKey: ['a'],
      queryFn,
      persister: persister.persisterFn,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(queryClient.getQueryState(['a'])).toEqual(state)
  })

  test('persisterFn restores infinite query pages with their state', async () => {
    const pages = { pages: ['p0', 'p1'], pageParams: [0, 1] }
    const state = persistedErrorState({ data: pages })
    const persister = experimental_createQueryPersister({
      storage: createStorage({ '["inf"]': state }),
      refetchOnRestore: false,
    })
    const queryClient = new QueryClient()
    const queryFn = vi.fn(({ pageParam }: { pageParam: number }) => pageParam)

    await queryClient.fetchInfiniteQuery({
      queryKey: ['inf'],
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_last: unknown, all: Array<unknown>) => all.length,
      // persisterFn is not typed for infinite queries (same as before this change)
      persister: persister.persisterFn as any,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryState(['inf'])).toEqual(state)
  })

  test('persisterFn still refetches a restored query that is stale', async () => {
    const state = persistedErrorState()
    const persister = experimental_createQueryPersister({
      storage: createStorage({ '["stale"]': state }),
    })
    const queryClient = new QueryClient()
    const queryFn = vi.fn(() => 'network')

    await queryClient.fetchQuery({
      queryKey: ['stale'],
      queryFn,
      persister: persister.persisterFn,
    })
    expect(queryClient.getQueryState(['stale'])?.status).toBe('error')

    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(['stale'])).toMatchObject({
      data: 'network',
      status: 'success',
    })
  })

  test('restoreQueries restores the full state of every query', async () => {
    const errorState = persistedErrorState()
    const successState = persistedErrorState({
      data: 'other',
      status: 'success',
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      isInvalidated: false,
    })
    const persister = experimental_createQueryPersister({
      storage: createStorage({ '["a"]': errorState, '["b"]': successState }),
    })
    const queryClient = new QueryClient({
      queryCache: new QueryCache({ onSuccess }),
    })

    await persister.restoreQueries(queryClient)

    expect(queryClient.getQueryState(['a'])).toEqual(errorState)
    expect(queryClient.getQueryState(['b'])).toEqual(successState)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('restoreQueries keeps whichever data and error is newer in memory', async () => {
    const state = persistedErrorState()
    const persister = experimental_createQueryPersister({
      storage: createStorage({ '["a"]': state }),
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(['a'], 'memory-data', { updatedAt: NOW - 100 })

    await persister.restoreQueries(queryClient)

    const restored = queryClient.getQueryState(['a'])!
    expect(restored.data).toBe('memory-data')
    expect(restored.dataUpdatedAt).toBe(NOW - 100)
    expect(restored.dataUpdateCount).toBe(1)
    expect(restored.error).toEqual(state.error)
    expect(restored.errorUpdatedAt).toBe(state.errorUpdatedAt)
    expect(restored.errorUpdateCount).toBe(2)
    expect(restored.status).toBe('success')
    expect(restored.fetchStatus).toBe('idle')
  })

  test('persistQueryClientRestore keeps a saved error status', async () => {
    const state = persistedErrorState()
    const queryClient = new QueryClient()

    await persistQueryClientRestore({
      queryClient,
      persister: {
        persistClient: vi.fn(),
        removeClient: vi.fn(),
        restoreClient: () => ({
          timestamp: NOW,
          buster: '',
          clientState: {
            mutations: [],
            queries: [{ queryKey: ['a'], queryHash: '["a"]', state }],
          },
        }),
      },
    })

    expect(queryClient.getQueryState(['a'])).toEqual(state)
  })
})
