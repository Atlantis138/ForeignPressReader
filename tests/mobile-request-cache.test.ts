import { describe, expect, it, vi } from 'vitest'
import { MobileRequestCache } from '../src/renderer/tauri/mobile-request-cache'

describe('MobileRequestCache', () => {
  it.each(['invalidate', 'clear'] as const)('discards in-flight responses after %s', async action => {
    const cache = new MobileRequestCache<number>()
    let finish!: (value: number) => void
    const old = cache.get(() => new Promise<number>(resolve => { finish = resolve }))
    cache[action]()
    await expect(cache.get(async () => 2)).resolves.toBe(2)
    finish(1)
    await old
    expect(cache.peek()).toBe(2)
    await expect(cache.get(async () => 3)).resolves.toBe(2)
  })
  it('deduplicates concurrent loads and reuses a fresh value', async () => {
    let resolveLoad!: (value: number) => void
    const load = vi.fn(() => new Promise<number>((resolve) => { resolveLoad = resolve }))
    const cache = new MobileRequestCache<number>()

    const first = cache.get(load)
    const concurrent = cache.get(load)
    expect(load).toHaveBeenCalledTimes(1)
    resolveLoad(7)

    await expect(first).resolves.toBe(7)
    await expect(concurrent).resolves.toBe(7)
    await expect(cache.get(load)).resolves.toBe(7)
    expect(cache.peek()).toBe(7)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refreshes after the time-to-live expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
    const load = vi.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')
    const cache = new MobileRequestCache<string>(1_000)

    await expect(cache.get(load)).resolves.toBe('first')
    vi.advanceTimersByTime(1_001)
    await expect(cache.get(load)).resolves.toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps a stale snapshot for immediate rendering while invalidating the next load', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 })
    const cache = new MobileRequestCache<{ count: number }>()

    await cache.get(load)
    cache.invalidate()
    expect(cache.peek()).toEqual({ count: 1 })
    await expect(cache.get(load)).resolves.toEqual({ count: 2 })

    cache.clear()
    expect(cache.peek()).toBeUndefined()
  })
})
