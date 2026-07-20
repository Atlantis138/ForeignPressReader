import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AppClient, CommonAppCapabilities } from '../src/core/app-client'
import {
  TauriMobileAppClient,
  type MobileAppClient,
} from '../src/renderer/tauri/mobile-app-client'
import type { AppApi } from '../src/shared/types'

describe('renderer AppClient assembly', () => {
  it('keeps the Android renderer on the shared capability keys', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args })
      if (command === 'get_platform_info') {
        return { appVersion: '1.0.0' } as T
      }
      return undefined as T
    }
    const client = new TauriMobileAppClient(invoke)

    expectTypeOf<TauriMobileAppClient>().toMatchTypeOf<MobileAppClient>()
    expectTypeOf<MobileAppClient>().toMatchTypeOf<CommonAppCapabilities>()
    expect(client.settings.translation).toBe(client.translation)
    expect(client.vocabulary).toBe(client.dictionary)
    expect(Object.hasOwn(client, 'reading')).toBe(false)
    expect(Object.hasOwn(client, 'appInfo')).toBe(false)
    expect('discardPortableImport' in client.data).toBe(false)
    expect('openAppStorageSettings' in client.storage).toBe(false)

    await client.platform.appInfo.getInfo()
    await client.platform.data.discardPortableImport('portable-token')
    await client.platform.storage.openAppStorageSettings()

    expect(calls).toEqual([
      { command: 'get_platform_info', args: undefined },
      { command: 'discard_mobile_portable_import', args: { token: 'portable-token' } },
      { command: 'open_mobile_app_storage_settings', args: undefined },
    ])
  })

  it('assembles Electron from the preload capability table without changing IPC shapes', async () => {
    const capability = () => Object.freeze({})
    const readerApi = {
      library: capability(),
      reader: capability(),
      translation: capability(),
      dictionary: capability(),
      vocabulary: capability(),
      study: capability(),
      data: capability(),
      storage: capability(),
      sync: capability(),
      speech: { synthesize: vi.fn() },
      settings: capability(),
      developer: capability(),
    } as unknown as AppApi

    vi.resetModules()
    vi.stubGlobal('window', { readerApi, speechSynthesis: undefined })
    try {
      const { getAppClient } = await import('../src/renderer/app-client')
      const client = getAppClient()

      expectTypeOf(client).toMatchTypeOf<AppClient>()
      for (const key of [
        'library',
        'reader',
        'translation',
        'dictionary',
        'vocabulary',
        'study',
        'data',
        'storage',
        'sync',
        'settings',
        'developer',
      ] as const) {
        expect(client[key]).toBe(readerApi[key])
      }
      expect(client.platform).toEqual({ runtime: 'electron' })
      expect(Object.hasOwn(readerApi, 'platform')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
