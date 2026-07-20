import { describe, expect, it, vi } from 'vitest'
import { readMobileStartupValue } from '../src/renderer/tauri/mobile-startup-read'

describe('mobile startup reads', () => {
  it('retries a transient native command failure', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('native command failed'))
      .mockResolvedValueOnce({ publications: 14 })

    await expect(readMobileStartupValue(read, { timeoutMs: 20, retryDelayMs: 0 }))
      .resolves.toEqual({ publications: 14 })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('abandons a lost callback and retries after the deadline', async () => {
    const read = vi.fn()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce('ready')

    await expect(readMobileStartupValue(read, { timeoutMs: 5, retryDelayMs: 0 }))
      .resolves.toBe('ready')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('surfaces the final failure instead of leaving startup pending forever', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))

    await expect(readMobileStartupValue(read, { timeoutMs: 20, retryDelayMs: 0 }))
      .rejects.toThrow('second')
  })
})
