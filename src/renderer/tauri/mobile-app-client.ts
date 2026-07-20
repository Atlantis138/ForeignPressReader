import { invoke } from '@tauri-apps/api/core'
import { onBackButtonPress } from '@tauri-apps/api/app'
import type { AppClient } from '../../core/app-client'
import type { TranslationApi } from '../../shared/types'
import type { MobileTranslationClient } from '../../shared/mobile-online-services'
import { TauriMobileReadingClient } from './mobile-client'
import { TauriMobileDictionaryClient, TauriMobileStudyClient } from './mobile-learning-client'
import { TauriMobileSpeechClient, TauriMobileTranslationClient } from './mobile-online-client'
import {
  TauriMobileAppInfoClient,
  TauriMobileDataClient,
  TauriMobileDeveloperClient,
  TauriMobileStorageClient,
  TauriMobileSyncClient,
} from './mobile-platform-client'

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface TauriMobileSettingsClient {
  readonly translation: MobileTranslationClient
}

export interface TauriMobilePlatformClient {
  readonly appInfo: TauriMobileAppInfoClient
  readonly data: Pick<TauriMobileDataClient, 'discardPortableImport'>
  readonly storage: Pick<TauriMobileStorageClient, 'openAppStorageSettings'>
  readonly lifecycle: {
    onBackButtonPress(callback: () => void): Promise<() => Promise<void>>
  }
}

export type MobileAppClient = AppClient<
  TauriMobileSpeechClient,
  TauriMobileSettingsClient,
  TauriMobileDeveloperClient,
  TauriMobilePlatformClient
> & {
  readonly library: TauriMobileReadingClient['library']
  readonly reader: TauriMobileReadingClient['reader']
  readonly translation: TauriMobileTranslationClient
  readonly dictionary: TauriMobileDictionaryClient
  readonly vocabulary: TauriMobileDictionaryClient
  readonly study: TauriMobileStudyClient
  readonly sync: TauriMobileSyncClient
}

export class TauriMobileAppClient implements MobileAppClient {
  readonly library: MobileAppClient['library']
  readonly reader: MobileAppClient['reader']
  readonly translation: TauriMobileTranslationClient
  readonly speech: TauriMobileSpeechClient
  readonly dictionary: TauriMobileDictionaryClient
  readonly vocabulary: TauriMobileDictionaryClient
  readonly study: TauriMobileStudyClient
  readonly settings: TauriMobileSettingsClient
  readonly data: MobileAppClient['data']
  readonly storage: MobileAppClient['storage']
  readonly sync: TauriMobileSyncClient
  readonly developer: TauriMobileDeveloperClient
  readonly platform: TauriMobilePlatformClient

  constructor(invokeCommand: InvokeFn = invoke) {
    this.translation = new TauriMobileTranslationClient(invokeCommand)
    this.speech = new TauriMobileSpeechClient(invokeCommand)
    const reading = new TauriMobileReadingClient(invokeCommand, {
      translation: this.translation satisfies TranslationApi,
      speech: null,
    })
    this.library = reading.library
    this.reader = reading.reader
    this.dictionary = new TauriMobileDictionaryClient(invokeCommand)
    this.vocabulary = this.dictionary
    this.study = new TauriMobileStudyClient(invokeCommand)
    this.settings = { translation: this.translation }
    const appInfo = new TauriMobileAppInfoClient(invokeCommand)
    const data = new TauriMobileDataClient(invokeCommand)
    const storage = new TauriMobileStorageClient(invokeCommand)
    this.data = {
      getStatus: () => data.getStatus(),
      exportPortable: () => data.exportPortable(),
      selectPortableImport: () => data.selectPortableImport(),
      confirmPortableImport: (token) => data.confirmPortableImport(token),
      cancelTransfer: () => data.cancelTransfer(),
      onProgress: (callback) => data.onProgress(callback),
    }
    this.storage = {
      scan: () => storage.scan(),
      clearSafeCache: () => storage.clearSafeCache(),
      clearAiTextCache: (confirmationToken) => storage.clearAiTextCache(confirmationToken),
    }
    this.sync = new TauriMobileSyncClient(invokeCommand)
    this.developer = new TauriMobileDeveloperClient(invokeCommand)
    this.platform = {
      appInfo,
      data: {
        discardPortableImport: (token) => data.discardPortableImport(token),
      },
      storage: {
        openAppStorageSettings: () => storage.openAppStorageSettings(),
      },
      lifecycle: {
        onBackButtonPress: async (callback) => {
          const listener = await onBackButtonPress(callback)
          return () => listener.unregister()
        },
      },
    }
  }
}
