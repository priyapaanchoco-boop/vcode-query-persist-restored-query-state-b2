import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Mock } from 'vitest'
import { QueryClient } from '../queryClient'
import { QueryCache } from '../queryCache'
import { hydrate } from '../hydration'
import { createPersisterRestoredResult } from '..'
import type { QueryState } from '../query'

const NOW = 1_000_000

function persistedErrorState(
  overrides: Partial<QueryState<any, any>> = {},
): QueryState<any, any> {
  return {
    data: 'old-data',
    dataUpdateCount: 3,
    dataUpdatedAt: NOW - 5000,
    error: new Error('boom'),
    errorUpdateCount: 2,
    errorUpdatedAt: NOW - 1000,
    fetchFailureCount: 1,
    fetchFailureReason: new Error('boom'),
    fetchMeta: null,
    isInvalidated: true,
    status: 'error',
    fetchStatus: 'fetching',
    ...overrides,
  }
}

describe('createPersisterRestoredResult', () => {
  let onSuccess: Mock<(...args: Array<any>) => void>
  let onError: Mock<(...args: Array<any>) => void>
  let onSettled: Mock<(...args: Array<any>) => void>
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    onSuccess = vi.fn()
    onError = vi.fn()
    onSettled = vi.fn()
    queryClient = new QueryClient({
      queryCache: new QueryCache({ onSuccess, onError, onSettled }),
    })
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  test('restores the persisted state as it was saved, with an idle fetch status', async () => {
    const state = persistedErrorState()
    const queryFn = vi.fn(() => 'network')

    const data = await queryClient.fetchQuery({
      queryKey: ['restore'],
      queryFn,
      persister: () =>
        Promise.resolve(
          createPersisterRestoredResult({ data: state.data, state }),
        ),
    })

    expect(data).toBe('old-data')
    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryState(['restore'])).toEqual({
      ...state,
      fetchStatus: 'idle',
    })
  })

  test('does not call the cache success callbacks for a restored result', async () => {
    const state = persistedErrorState({ status: 'success', error: null })

    await queryClient.fetchQuery({
      queryKey: ['callbacks'],
      queryFn: () => 'network',
      persister: () =>
        createPersisterRestoredResult({ data: state.data, state }),
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  test('uses `data` from the helper over `state.data`', async () => {
    const state = persistedErrorState({ data: 'raw' })

    await queryClient.fetchQuery({
      queryKey: ['data-override'],
      queryFn: () => 'network',
      persister: () =>
        createPersisterRestoredResult({ data: 'deserialized', state }),
    })

    expect(queryClient.getQueryData(['data-override'])).toBe('deserialized')
  })

  test('does not treat a plain object with data and state as restored', async () => {
    const plain = { data: 'x', state: persistedErrorState() }

    await queryClient.fetchQuery({
      queryKey: ['plain'],
      queryFn: () => plain,
    })

    const queryState = queryClient.getQueryState(['plain'])
    expect(queryState?.data).toBe(plain)
    expect(queryState?.status).toBe('success')
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  test('restores infinite query pages and pageParams with their state', async () => {
    const pages = { pages: ['p0', 'p1'], pageParams: [0, 1] }
    const state = persistedErrorState({ data: pages })
    const queryFn = vi.fn(
      ({ pageParam }: { pageParam: number }) => `n${pageParam}`,
    )

    const data = await queryClient.fetchInfiniteQuery({
      queryKey: ['infinite'],
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (_last: unknown, all: Array<unknown>) => all.length,
      persister: () => createPersisterRestoredResult({ data: pages, state }),
    })

    expect(queryFn).not.toHaveBeenCalled()
    expect(data).toEqual(pages)
    expect(queryClient.getQueryState(['infinite'])).toEqual({
      ...state,
      fetchStatus: 'idle',
    })
  })

  test('keeps newer data from memory but takes the newer persisted error', async () => {
    queryClient.setQueryData(['mixed'], 'memory-data', {
      updatedAt: NOW - 500,
    })
    const query = queryClient.getQueryCache().find({ queryKey: ['mixed'] })!
    // a persister is only consulted when there is no data, but a restored
    // result must still respect newer data in memory
    const state = persistedErrorState()

    await query.fetch({
      queryKey: ['mixed'],
      queryFn: () => 'network',
      persister: () =>
        createPersisterRestoredResult({ data: state.data, state }),
    })

    const restored = query.state
    expect(restored.data).toBe('memory-data')
    expect(restored.dataUpdatedAt).toBe(NOW - 500)
    expect(restored.dataUpdateCount).toBe(1)
    expect(restored.error).toBe(state.error)
    expect(restored.errorUpdatedAt).toBe(state.errorUpdatedAt)
    expect(restored.errorUpdateCount).toBe(2)
    // data in memory is the most recent update, so it decides the status
    expect(restored.status).toBe('success')
    expect(restored.fetchStatus).toBe('idle')
  })

  test('keeps a newer error from memory but takes the newer persisted data', async () => {
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['mixed-error'],
    })
    query.setState({
      error: new Error('memory'),
      errorUpdatedAt: NOW - 100,
      errorUpdateCount: 7,
      status: 'error',
    })
    const memoryError = query.state.error
    const state = persistedErrorState()

    await query
      .fetch({
        queryKey: ['mixed-error'],
        queryFn: () => 'network',
        persister: () =>
          createPersisterRestoredResult({ data: state.data, state }),
      })
      .catch(() => undefined)

    expect(query.state.data).toBe('old-data')
    expect(query.state.dataUpdatedAt).toBe(state.dataUpdatedAt)
    expect(query.state.dataUpdateCount).toBe(3)
    expect(query.state.error).toBe(memoryError)
    expect(query.state.errorUpdatedAt).toBe(NOW - 100)
    expect(query.state.errorUpdateCount).toBe(7)
    expect(query.state.status).toBe('error')
    expect(query.state.fetchStatus).toBe('idle')
  })
})

describe('hydrate keeps the saved query state', () => {
  test('a saved error status with data is not turned into success', () => {
    const queryClient = new QueryClient()
    const state = persistedErrorState()

    hydrate(queryClient, {
      mutations: [],
      queries: [{ queryKey: ['h'], queryHash: '["h"]', state }],
    })

    expect(queryClient.getQueryState(['h'])).toEqual({
      ...state,
      fetchStatus: 'idle',
    })
  })

  test('an existing query takes the newer error but keeps its newer data', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['h2'], 'memory-data', { updatedAt: NOW })
    const state = persistedErrorState({ errorUpdatedAt: NOW + 10 })

    hydrate(queryClient, {
      mutations: [],
      queries: [{ queryKey: ['h2'], queryHash: '["h2"]', state }],
    })

    const restored = queryClient.getQueryState(['h2'])!
    expect(restored.data).toBe('memory-data')
    expect(restored.dataUpdatedAt).toBe(NOW)
    expect(restored.error).toBe(state.error)
    expect(restored.errorUpdatedAt).toBe(NOW + 10)
    expect(restored.errorUpdateCount).toBe(2)
    expect(restored.status).toBe('error')
    expect(restored.fetchStatus).toBe('idle')
  })
})
