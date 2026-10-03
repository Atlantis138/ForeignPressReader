import type { DatabaseSync } from 'node:sqlite'
import { TranslationProviderRegistry } from '../core/translation-providers'
import type { TranslationPreferences, TranslationProviderOption } from '../shared/types'

export function requireModelId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(value.trim())) {
    throw new Error('模型名称须为 1–100 个字母、数字或 . _ : / -')
  }
  return value.trim()
}

/** Desktop connection configuration; never exported as portable user content. */
export class DesktopTranslationProviderRegistry extends TranslationProviderRegistry {
  override normalize(preferences: Partial<TranslationPreferences> | null | undefined): TranslationPreferences {
    const value = super.normalize(preferences)
    return { ...value, modelId: this.resolve(value).model.id }
  }

  override resolve(preferences: TranslationPreferences) {
    const provider = this.get(preferences.providerId)
    const id = requireModelId(preferences.modelId)
    const model = provider.models.find(item => item.id === id) ?? {
      id, name: id, description: '自定义模型',
      maxBlocksPerBatch: 6, maxCharactersPerBatch: 4_000, maxCompletionTokens: 4_096,
      completionTokenField: provider.id === 'openai' ? 'max_completion_tokens' as const : 'max_tokens' as const,
    }
    return { provider, model }
  }
}

const CONFIG_KEY = 'local.translation.models'
interface ModelConfig { models: TranslationPreferences[]; selected: TranslationPreferences | null }

export class DesktopTranslationModels {
  private readonly providers = new DesktopTranslationProviderRegistry()
  constructor(private readonly db: DatabaseSync, private readonly deviceId: string) {}

  read(): ModelConfig {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(CONFIG_KEY)
      ?? this.db.prepare('SELECT value FROM settings WHERE key = ?').get('desktop.translation.models')
    if (!row) return { models: [], selected: null }
    return JSON.parse(String(row.value)) as ModelConfig
  }

  save(selection: TranslationPreferences): boolean {
    const { provider, model } = this.providers.resolve(selection)
    const config = this.read()
    const custom = !provider.models.some(item => item.id === model.id)
    const value = { providerId: provider.id, modelId: model.id }
    if (custom && !config.models.some(item => same(item, value))) {
      if (config.models.length >= 100) throw new Error('最多保存 100 个自定义模型，请先删除不用的模型')
      config.models.push(value)
    }
    config.selected = custom ? value : null
    this.write(config)
    return custom
  }

  delete(selection: TranslationPreferences): void {
    selection = this.providers.normalize(selection)
    const config = this.read()
    config.models = config.models.filter(item => !same(item, selection))
    if (config.selected && same(config.selected, selection)) config.selected = null
    this.write(config)
  }

  options(options: TranslationProviderOption[]): TranslationProviderOption[] {
    const { models } = this.read()
    return options.map(provider => ({ ...provider, models: [
      ...provider.models,
      ...models.filter(item => item.providerId === provider.id && !provider.models.some(model => model.id === item.modelId)).map(item => ({
        id: item.modelId, name: item.modelId, description: '自定义模型 · 仅本机', custom: true,
      })),
    ] }))
  }

  private write(config: ModelConfig): void {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at, device_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, device_id=excluded.device_id`)
      .run(CONFIG_KEY, JSON.stringify(config), new Date().toISOString(), this.deviceId)
  }
}

function same(a: TranslationPreferences, b: TranslationPreferences): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}
