import type { NetworkClient } from '../core/network-client'
import type { SpeechAudio, SpeechSynthesisRequest } from '../shared/types'

const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export interface SpeechProviderAdapter {
  readonly providerId: SpeechSynthesisRequest['providerId']
  synthesize(request: SpeechSynthesisRequest, apiKey: string, network: NetworkClient): Promise<SpeechAudio>
}

export class SpeechProviderAdapterRegistry {
  private readonly adapters = new Map<SpeechSynthesisRequest['providerId'], SpeechProviderAdapter>()
  constructor(adapters: readonly SpeechProviderAdapter[]) { for (const adapter of adapters) this.register(adapter) }
  register(adapter: SpeechProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) throw new Error(`语音适配器 ${adapter.providerId} 已注册`)
    this.adapters.set(adapter.providerId, adapter)
  }
  get(providerId: SpeechSynthesisRequest['providerId']): SpeechProviderAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) throw new Error('所选语音供应商尚未实现合成适配器')
    return adapter
  }
}

export class GoogleSpeechAdapter implements SpeechProviderAdapter {
  readonly providerId = 'google' as const
  async synthesize(request: SpeechSynthesisRequest, apiKey: string, network: NetworkClient): Promise<SpeechAudio> {
    let response: Response
    try {
      response = await network.fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          input: { text: request.text },
          voice: { languageCode: request.locale, name: request.voiceId },
          audioConfig: { audioEncoding: 'MP3', speakingRate: request.rate },
        }),
      })
    } catch { throw new Error('Google Cloud Text-to-Speech 连接失败，请检查系统代理或网络') }
    requireHttpSuccess(response, 'Google Cloud Text-to-Speech')
    const payload = await response.json() as { audioContent?: unknown }
    if (typeof payload.audioContent !== 'string' || !isBase64(payload.audioContent)) {
      throw new Error('Google Cloud Text-to-Speech 返回了无效音频')
    }
    return audio(Buffer.from(payload.audioContent, 'base64'), 'Google Cloud Text-to-Speech')
  }
}

export class MiniMaxSpeechAdapter implements SpeechProviderAdapter {
  readonly providerId = 'minimax' as const
  async synthesize(request: SpeechSynthesisRequest, apiKey: string, network: NetworkClient): Promise<SpeechAudio> {
    let response: Response
    try {
      response = await network.fetch('https://api.minimaxi.com/v1/t2a_v2', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelId,
          text: request.text,
          stream: false,
          language_boost: 'English',
          output_format: 'hex',
          voice_setting: { voice_id: request.voiceId, speed: request.rate, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
          subtitle_enable: false,
        }),
      })
    } catch { throw new Error('MiniMax Text-to-Speech 连接失败，请检查系统代理或网络') }
    requireHttpSuccess(response, 'MiniMax Text-to-Speech')
    const payload = await response.json() as {
      data?: { audio?: unknown; status?: unknown }
      base_resp?: { status_code?: unknown }
    }
    const statusCode = Number(payload.base_resp?.status_code)
    if (statusCode !== 0) throw miniMaxBusinessError(statusCode)
    const value = payload.data?.audio
    if (payload.data?.status !== 2 || typeof value !== 'string' || value.length % 2 !== 0
      || value.length > MAX_AUDIO_BYTES * 2 || !/^[a-f0-9]+$/i.test(value)) {
      throw new Error('MiniMax Text-to-Speech 返回了无效音频')
    }
    return audio(Buffer.from(value, 'hex'), 'MiniMax Text-to-Speech')
  }
}

export function createDefaultSpeechAdapterRegistry(): SpeechProviderAdapterRegistry {
  return new SpeechProviderAdapterRegistry([new GoogleSpeechAdapter(), new MiniMaxSpeechAdapter()])
}

function requireHttpSuccess(response: Response, name: string): void {
  if (response.status === 401 || response.status === 403) throw new Error(`${name} API Key 无效或无调用权限`)
  if (response.status === 429) throw new Error(`${name} 请求过于频繁或配额不足`)
  if (!response.ok) throw new Error(`${name} 合成失败（HTTP ${response.status}）`)
}

function miniMaxBusinessError(statusCode: number): Error {
  if ([1004, 2049].includes(statusCode)) return new Error('MiniMax Text-to-Speech API Key 无效或无调用权限')
  if ([1002, 1008, 1041, 2045, 2056].includes(statusCode)) {
    return new Error('MiniMax Text-to-Speech 请求受限、余额不足或配额不足')
  }
  if ([2013, 20132, 2042].includes(statusCode)) return new Error('MiniMax Text-to-Speech 模型或声音参数无效')
  return new Error(`MiniMax Text-to-Speech 合成失败（状态 ${Number.isFinite(statusCode) ? statusCode : '未知'}）`)
}

function audio(bytes: Buffer, name: string): SpeechAudio {
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) throw new Error(`${name} 返回的音频大小无效`)
  return { bytes: new Uint8Array(bytes), mimeType: 'audio/mpeg' }
}

function isBase64(value: string): boolean {
  return value.length <= MAX_AUDIO_BYTES * 2 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}
