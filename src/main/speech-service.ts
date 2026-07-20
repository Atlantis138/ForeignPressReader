import type { ConnectionTestResult, SpeechAudio, SpeechSynthesisRequest } from '../shared/types'
import type { ApiKeyStore } from '../core/ports'
import type { SpeechProviderRegistry } from '../core/speech-providers'
import type { NetworkClient } from '../core/network-client'
import type { SpeechProviderAdapterRegistry } from './speech-provider-adapters'
import type { SpeechAudioCache } from './speech-audio-cache'

const MAX_INPUT_LENGTH = 4_000

export class SpeechSynthesisService {
  constructor(
    private readonly secrets: ApiKeyStore,
    private readonly providers: SpeechProviderRegistry,
    private readonly adapters: SpeechProviderAdapterRegistry,
    private readonly network: NetworkClient,
    private readonly cache: SpeechAudioCache,
  ) {}

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechAudio> {
    const provider = this.providers.getRemote(request.providerId)
    if (!provider.models.some((model) => model.id === request.modelId)) throw new Error(`${provider.name} 不支持所选模型`)
    if (!provider.voices.some((voice) => voice.id === request.voiceId && voice.locales.includes(request.locale))) {
      throw new Error(`${provider.name} 不支持所选声音`)
    }
    const text = request.text.replace(/\s+/g, ' ').trim()
    if (!text || text.length > MAX_INPUT_LENGTH) throw new Error('朗读文本长度无效')
    const normalized = { ...request, text, rate: clamp(request.rate, 0.5, 2) }
    const apiKey = await this.secrets.getApiKey(provider.credentialId!)
    if (!apiKey) throw new Error(`请先在设置中填写 ${provider.name} API Key`)
    return this.cache.getOrCreate(normalized, () => (
      this.adapters.get(normalized.providerId).synthesize(normalized, apiKey, this.network)
    ))
  }

  async testConnection(providerId: SpeechSynthesisRequest['providerId']): Promise<ConnectionTestResult> {
    const provider = this.providers.getRemote(providerId)
    const voice = provider.voices.find((item) => item.locales.includes('en-US'))
    if (!voice) return { ok: false, message: `${provider.name} 没有可用的英语声音` }
    try {
      await this.synthesize({
        providerId, modelId: provider.defaultModelId!, text: 'Speech service connected.',
        locale: 'en-US', voiceId: voice.id, rate: 1,
      })
      return { ok: true, message: `${provider.name} 连接成功；本次测试可能消耗少量额度` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : `${provider.name} 连接失败` }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || min))
}
