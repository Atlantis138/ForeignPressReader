import type {
  KeyStatus,
  SpeechLocale,
  SpeechPreferences,
  SpeechProviderId,
  RemoteSpeechProviderId,
  SpeechProviderOption,
  SpeechProviderSetting,
} from '../shared/types'

export interface SpeechVoiceDefinition {
  id: string
  name: string
  locales: readonly SpeechLocale[]
}

export interface SpeechModelDefinition {
  id: string
  name: string
  description: string
}

export interface SpeechProviderDefinition {
  id: SpeechProviderId
  name: string
  description: string
  requiresApiKey: boolean
  credentialId: string | null
  models: readonly SpeechModelDefinition[]
  voices: readonly SpeechVoiceDefinition[]
  defaultModelId: string | null
  defaultVoiceByLocale: Partial<Record<SpeechLocale, string>>
}

export const DEFAULT_GOOGLE_VOICE_BY_LOCALE: Record<SpeechLocale, string> = {
  'en-US': 'en-US-Standard-C',
  'en-GB': 'en-GB-Standard-A',
}

const ENGLISH_LOCALES = ['en-US', 'en-GB'] as const

const BUILT_IN_PROVIDERS: readonly SpeechProviderDefinition[] = [
  {
    id: 'system', name: '系统语音', description: '使用设备内置语音，本地合成，不上传文本。',
    requiresApiKey: false, credentialId: null, models: [], voices: [], defaultModelId: null,
    defaultVoiceByLocale: {},
  },
  {
    id: 'google', name: 'Google Cloud Text-to-Speech',
    description: '使用 Google Standard 基础声音，朗读文本会发送至 Google Cloud。',
    requiresApiKey: true, credentialId: 'google-tts',
    models: [{ id: 'standard', name: 'Standard', description: 'Google 基础标准语音' }],
    defaultModelId: 'standard', defaultVoiceByLocale: DEFAULT_GOOGLE_VOICE_BY_LOCALE,
    voices: [
      { id: 'en-US-Standard-A', name: 'Standard A · 男声', locales: ['en-US'] },
      { id: 'en-US-Standard-C', name: 'Standard C · 女声', locales: ['en-US'] },
      { id: 'en-US-Standard-D', name: 'Standard D · 男声', locales: ['en-US'] },
      { id: 'en-US-Standard-E', name: 'Standard E · 女声', locales: ['en-US'] },
      { id: 'en-GB-Standard-A', name: 'Standard A · 女声', locales: ['en-GB'] },
      { id: 'en-GB-Standard-B', name: 'Standard B · 男声', locales: ['en-GB'] },
      { id: 'en-GB-Standard-C', name: 'Standard C · 女声', locales: ['en-GB'] },
      { id: 'en-GB-Standard-D', name: 'Standard D · 男声', locales: ['en-GB'] },
    ],
  },
  {
    id: 'minimax', name: 'MiniMax Text-to-Speech',
    description: '使用 MiniMax 中国站同步语音合成，支持自然英文叙述音色。',
    requiresApiKey: true, credentialId: 'minimax-tts',
    models: [
      { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', description: '低延迟、自然流畅，当前默认' },
      { id: 'speech-2.8-hd', name: 'Speech 2.8 HD', description: '更高音质和更丰富的韵律' },
    ],
    defaultModelId: 'speech-2.8-turbo',
    defaultVoiceByLocale: { 'en-US': 'English_expressive_narrator', 'en-GB': 'English_expressive_narrator' },
    voices: [
      ['English_expressive_narrator', 'Expressive Narrator'],
      ['English_CaptivatingStoryteller', 'Captivating Storyteller'],
      ['English_Trustworth_Man', 'Trustworthy Man'],
      ['English_CalmWoman', 'Calm Woman'],
      ['English_magnetic_voiced_man', 'Magnetic-voiced Male'],
      ['English_compelling_lady1', 'Compelling Lady'],
      ['English_WiseScholar', 'Wise Scholar'],
      ['English_Steadymentor', 'Reliable Man'],
      ['English_Deep-VoicedGentleman', 'Deep-voiced Gentleman'],
      ['English_SereneWoman', 'Serene Woman'],
      ['English_radiant_girl', 'Radiant Girl'],
      ['English_Aussie_Bloke', 'Aussie Bloke'],
    ].map(([id, name]) => ({ id, name, locales: ENGLISH_LOCALES })),
  },
]

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  locale: 'en-US', voiceId: null, rate: 0.9, autoPlayStudy: false,
  wordProviderId: 'system', articleProviderId: 'google',
  providerSettings: {
    google: { modelId: 'standard', voiceId: DEFAULT_GOOGLE_VOICE_BY_LOCALE['en-US'] },
    minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
  },
}

export class SpeechProviderRegistry {
  private readonly providers = new Map<SpeechProviderId, SpeechProviderDefinition>()

  constructor(definitions: readonly SpeechProviderDefinition[] = BUILT_IN_PROVIDERS) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: SpeechProviderDefinition): void {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(definition.id)) throw new Error('语音供应商 ID 无效')
    if (this.providers.has(definition.id)) throw new Error(`语音供应商 ${definition.id} 已注册`)
    if (definition.requiresApiKey && (!definition.credentialId || !definition.defaultModelId
      || definition.models.length === 0 || definition.voices.length === 0)) {
      throw new Error(`${definition.name} 的远程服务配置不完整`)
    }
    this.providers.set(definition.id, definition)
  }

  list(): SpeechProviderDefinition[] { return [...this.providers.values()] }
  listRemote(): SpeechProviderDefinition[] { return this.list().filter((item) => item.id !== 'system') }

  get(providerId: SpeechProviderId): SpeechProviderDefinition {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error('不支持的语音供应商')
    return provider
  }

  getRemote(providerId: string): SpeechProviderDefinition {
    if (providerId === 'system') throw new Error('系统语音无需远程合成')
    return this.get(providerId as SpeechProviderId)
  }

  normalize(value: Partial<SpeechPreferences> | null | undefined): SpeechPreferences {
    const locale: SpeechLocale = value?.locale === 'en-GB' ? 'en-GB' : 'en-US'
    const voiceId = typeof value?.voiceId === 'string' ? value.voiceId.trim().slice(0, 500) : ''
    const rawSettings = value?.providerSettings && typeof value.providerSettings === 'object'
      ? value.providerSettings as Partial<Record<RemoteSpeechProviderId, Partial<SpeechProviderSetting>>>
      : {}
    const providerSettings = {} as SpeechPreferences['providerSettings']
    for (const provider of this.listRemote()) {
      const raw = rawSettings[provider.id]
      const requestedModel = typeof raw?.modelId === 'string' ? raw.modelId : ''
      const requestedVoice = typeof raw?.voiceId === 'string' ? raw.voiceId : ''
      providerSettings[provider.id] = {
        modelId: provider.models.some((model) => model.id === requestedModel)
          ? requestedModel : provider.defaultModelId!,
        voiceId: provider.voices.some((voice) => voice.id === requestedVoice && voice.locales.includes(locale))
          ? requestedVoice : provider.defaultVoiceByLocale[locale]!,
      }
    }
    const validProviders = new Set(this.list().map((provider) => provider.id))
    return {
      locale, voiceId: voiceId || null, providerSettings,
      rate: clamp(Number(value?.rate) || DEFAULT_SPEECH_PREFERENCES.rate, 0.5, 2),
      autoPlayStudy: value?.autoPlayStudy === true,
      wordProviderId: validProviders.has(value?.wordProviderId as SpeechProviderId)
        ? value!.wordProviderId! : 'system',
      articleProviderId: validProviders.has(value?.articleProviderId as SpeechProviderId)
        ? value!.articleProviderId! : 'google',
    }
  }

  toOptions(keyStatuses: Map<string, KeyStatus>): SpeechProviderOption[] {
    return this.list().map((provider) => ({
      id: provider.id, name: provider.name, description: provider.description,
      requiresApiKey: provider.requiresApiKey,
      keyStatus: provider.requiresApiKey
        ? keyStatuses.get(provider.id) ?? { configured: false, masked: null }
        : { configured: true, masked: null },
      models: provider.models.map((model) => ({ ...model })),
      voices: provider.voices.map((voice) => ({ ...voice, locales: [...voice.locales] })),
    }))
  }
}

export function createDefaultSpeechProviderRegistry(): SpeechProviderRegistry {
  return new SpeechProviderRegistry(BUILT_IN_PROVIDERS)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || min))
}
