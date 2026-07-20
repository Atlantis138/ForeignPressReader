import type {
  TranslationModelOption,
  TranslationPreferences,
  TranslationProviderOption,
} from '../shared/types'

export interface TranslationModelDefinition extends TranslationModelOption {
  requestOptions?: Record<string, unknown>
  cacheKey?: string
  maxBlocksPerBatch?: number
  maxCharactersPerBatch?: number
  maxCompletionTokens?: number
  completionTokenField?: 'max_tokens' | 'max_completion_tokens'
}

export interface TranslationProviderDefinition {
  id: string
  name: string
  chatCompletionsUrl: string
  modelsUrl: string
  models: readonly TranslationModelDefinition[]
}

export const DEFAULT_TRANSLATION_PREFERENCES: TranslationPreferences = {
  providerId: 'deepseek',
  modelId: 'deepseek-v4-flash',
}

const BUILT_IN_PROVIDERS: readonly TranslationProviderDefinition[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    chatCompletionsUrl: 'https://api.deepseek.com/chat/completions',
    modelsUrl: 'https://api.deepseek.com/models',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        description: '低成本、快速，当前默认',
        requestOptions: { thinking: { type: 'disabled' } },
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_tokens',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        description: '质量优先，费用更高',
        requestOptions: { thinking: { type: 'disabled' } },
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_tokens',
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    models: [
      {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        description: '低成本、适合批量翻译',
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_completion_tokens',
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        description: '质量与成本平衡',
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_completion_tokens',
      },
    ],
  },
  {
    id: 'moonshot',
    name: 'Kimi（Moonshot）',
    chatCompletionsUrl: 'https://api.moonshot.cn/v1/chat/completions',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot V1 8K',
        description: '低成本、适合短批次翻译',
        maxBlocksPerBatch: 6,
        maxCharactersPerBatch: 4_000,
        maxCompletionTokens: 4_096,
        completionTokenField: 'max_tokens',
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot V1 32K',
        description: '更长上下文',
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_tokens',
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot V1 128K',
        description: '超长上下文',
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_tokens',
      },
      {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        description: '新一代通用模型，费用更高',
        requestOptions: { thinking: { type: 'disabled' } },
        maxCompletionTokens: 8_192,
        completionTokenField: 'max_tokens',
      },
    ],
  },
]

export class TranslationProviderRegistry {
  private readonly providers = new Map<string, TranslationProviderDefinition>()

  constructor(definitions: readonly TranslationProviderDefinition[] = BUILT_IN_PROVIDERS) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: TranslationProviderDefinition): void {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(definition.id)) throw new Error('翻译供应商 ID 无效')
    if (definition.models.length === 0) throw new Error(`${definition.name} 未配置模型`)
    if (this.providers.has(definition.id)) throw new Error(`翻译供应商 ${definition.id} 已注册`)
    this.providers.set(definition.id, definition)
  }

  list(): TranslationProviderDefinition[] {
    return [...this.providers.values()]
  }

  get(providerId: string): TranslationProviderDefinition {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error('不支持的翻译供应商')
    return provider
  }

  resolve(preferences: TranslationPreferences): {
    provider: TranslationProviderDefinition
    model: TranslationModelDefinition
  } {
    const provider = this.get(preferences.providerId)
    const model = provider.models.find((item) => item.id === preferences.modelId)
    if (!model) throw new Error(`${provider.name} 不支持所选模型`)
    return { provider, model }
  }

  normalize(preferences: Partial<TranslationPreferences> | null | undefined): TranslationPreferences {
    try {
      const candidate = {
        providerId: String(preferences?.providerId ?? ''),
        modelId: String(preferences?.modelId ?? ''),
      }
      this.resolve(candidate)
      return candidate
    } catch {
      return { ...DEFAULT_TRANSLATION_PREFERENCES }
    }
  }

  toOptions(keyStatuses: Map<string, TranslationProviderOption['keyStatus']>): TranslationProviderOption[] {
    return this.list().map((provider) => ({
      id: provider.id,
      name: provider.name,
      keyStatus: keyStatuses.get(provider.id) ?? { configured: false, masked: null },
      models: provider.models.map(({ id, name, description }) => ({ id, name, description })),
    }))
  }
}

export function createDefaultTranslationProviderRegistry(): TranslationProviderRegistry {
  return new TranslationProviderRegistry(BUILT_IN_PROVIDERS)
}

export function translationCacheModel(
  provider: TranslationProviderDefinition,
  model: TranslationModelDefinition,
): string {
  return model.cacheKey ?? (provider.id === 'deepseek' ? model.id : `${provider.id}:${model.id}`)
}
