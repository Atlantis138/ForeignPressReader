import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictionaryInstallProgress } from '../src/shared/types'

const eventHarness = vi.hoisted(() => ({
  callback: undefined as undefined | ((event: { payload: DictionaryInstallProgress }) => void),
  unlisten: vi.fn(),
  listen: vi.fn(async (_event: string, callback: (event: { payload: DictionaryInstallProgress }) => void) => {
    eventHarness.callback = callback
    return eventHarness.unlisten
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: eventHarness.listen }))

import { TauriMobileDictionaryClient } from '../src/renderer/tauri/mobile-learning-client'

describe('Android dictionary install progress bridge', () => {
  beforeEach(() => {
    eventHarness.callback = undefined
    eventHarness.listen.mockClear()
    eventHarness.unlisten.mockClear()
  })

  it('forwards native byte progress and releases the Tauri listener', async () => {
    const received: DictionaryInstallProgress[] = []
    const client = new TauriMobileDictionaryClient(async () => undefined)
    const dispose = client.onInstallProgress((progress) => received.push(progress))
    await vi.waitFor(() => expect(eventHarness.callback).toBeTypeOf('function'))

    const progress: DictionaryInstallProgress = {
      stage: 'downloading-dictionary',
      downloadedBytes: 8 * 1024 * 1024,
      totalBytes: 65_933_428,
      indexedEntries: 0,
      message: 'downloading',
    }
    eventHarness.callback?.({ payload: progress })
    expect(received).toEqual([progress])
    expect(eventHarness.listen).toHaveBeenCalledWith(
      'mobile-dictionary-install-progress',
      expect.any(Function),
    )

    dispose()
    expect(eventHarness.unlisten).toHaveBeenCalledOnce()
  })
})
