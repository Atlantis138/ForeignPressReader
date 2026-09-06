import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  ConnectionTestResult,
  SpeechPreferences,
  SpeechSettings,
  SpeechSynthesisRequest,
  SpeechUsage,
  TranslationPreferences,
  TranslationProgress,
  TranslationResult,
  TranslationSettings,
} from '../../shared/types'
import type { MobileSpeechClient, MobileTranslationClient } from '../../shared/mobile-online-services'
import { normalizePlatformError } from './platform-error'

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export class TauriMobileTranslationClient implements MobileTranslationClient {
  constructor(private readonly invokeCommand: InvokeFn = invoke) {}

  getSettings(): Promise<TranslationSettings> {
    return this.call('get_mobile_translation_settings')
  }

  async savePreferences(preferences: TranslationPreferences): Promise<TranslationSettings> {
    await this.call('save_mobile_translation_preferences', { preferences })
    return this.getSettings()
  }

  saveApiKey(providerId: string, modelId: string, value: string): Promise<ConnectionTestResult> {
    return this.call('save_mobile_translation_api_key', { providerId, modelId, value })
  }

  async deleteApiKey(providerId: string): Promise<TranslationSettings> {
    await this.call('delete_mobile_translation_api_key', { providerId })
    return this.getSettings()
  }

  testConnection(): Promise<ConnectionTestResult> {
    return this.call('test_mobile_translation_connection')
  }

  translateArticle(articleId: string, force = false): Promise<TranslationResult> {
    return this.call('translate_mobile_article', { articleId, force })
  }

  cancel(articleId: string): Promise<void> {
    return this.call('cancel_mobile_translation', { articleId })
  }

  onProgress(callback: (progress: TranslationProgress) => void): () => void {
    let active = true
    let dispose: (() => void) | undefined
    void listen<TranslationProgress>('mobile-translation-progress', (event) => {
      if (active) callback(event.payload)
    }).then((unlisten) => {
      if (active) dispose = unlisten
      else unlisten()
    })
    return () => { active = false; dispose?.() }
  }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await this.invokeCommand<T>(command, args) }
    catch (reason) { throw normalizePlatformError(reason) }
  }
}

export class TauriMobileSpeechClient implements MobileSpeechClient {
  constructor(private readonly invokeCommand: InvokeFn = invoke) {}

  getSettings(): Promise<SpeechSettings> {
    return this.call('get_mobile_speech_settings')
  }

  savePreferences(preferences: SpeechPreferences): Promise<SpeechPreferences> {
    return this.call('save_mobile_speech_preferences', { preferences })
  }

  saveApiKey(providerId: 'google' | 'minimax', value: string): Promise<ConnectionTestResult> {
    return this.call('save_mobile_speech_api_key', { providerId, value })
  }

  async deleteApiKey(providerId: 'google' | 'minimax'): Promise<SpeechSettings> {
    await this.call('delete_mobile_speech_api_key', { providerId })
    return this.getSettings()
  }

  testConnection(providerId: 'google' | 'minimax'): Promise<ConnectionTestResult> {
    return this.call('test_mobile_speech_connection', { providerId })
  }

  play(request: SpeechSynthesisRequest & { sourceId: string; itemId: string; usage: SpeechUsage }): Promise<void> {
    return this.call('play_mobile_speech', { request })
  }

  playQueue(request: Parameters<MobileSpeechClient['playQueue']>[0]): Promise<void> { return this.call('start_mobile_speech_queue',{request}) }
  getQueueState(): ReturnType<MobileSpeechClient['getQueueState']> { return this.call('get_mobile_speech_queue_state') }
  seekQueue(index:number): Promise<void> { return this.call('seek_mobile_speech_queue',{index}) }
  pause(): Promise<void> { return this.call('pause_mobile_speech') }
  resume(): Promise<void> { return this.call('resume_mobile_speech') }
  stop(): Promise<void> { return this.call('stop_mobile_speech') }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await this.invokeCommand<T>(command, args) }
    catch (reason) { throw normalizePlatformError(reason) }
  }
}
