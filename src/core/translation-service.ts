import type {
  ConnectionTestResult,
  TranslationPreferences,
  TranslationProgress,
  TranslationResult,
} from '../shared/types'
import type { ApiKeyStore, TranslationRepository } from './ports'
import type { NetworkClient } from './network-client'
import {
  DEFAULT_TRANSLATION_PREFERENCES,
  TranslationProviderRegistry,
  createDefaultTranslationProviderRegistry,
  translationCacheModel,
  type TranslationModelDefinition,
  type TranslationProviderDefinition,
} from './translation-providers'

export interface TranslationProvider {
  translateArticle(articleId: string, force?: boolean): Promise<TranslationResult>
  cancel(articleId: string): void
}

export interface ModelSelectionIdentity {
  providerId: string
  modelId: string
  cacheModel: string
}

interface SourceSegment {
  id: string
  type: string
  text: string
  sourceHash: string
}

interface ApiSegment {
  blockId: string
  translation: string
}

export const TRANSLATION_PROMPT_VERSION = 'editorial-zh-v1'
const MAX_BLOCKS_PER_BATCH = 12
const MAX_CHARACTERS_PER_BATCH = 12_000
const COMPLETION_TIMEOUT_MS = 60_000

export class TranslationService implements TranslationProvider {
  private readonly jobs = new Map<string, AbortController>()

  constructor(
    private readonly database: TranslationRepository,
    private readonly secrets: ApiKeyStore,
    private readonly getPreferences: () => TranslationPreferences,
    private readonly emitProgress: (progress: TranslationProgress) => void,
    private readonly network: NetworkClient,
    private readonly providers: TranslationProviderRegistry = createDefaultTranslationProviderRegistry(),
  ) {}

  async translateArticle(articleId: string, force = false): Promise<TranslationResult> {
    if (this.jobs.has(articleId)) throw new Error('该文章正在翻译')
    const controller = new AbortController()
    this.jobs.set(articleId, controller)
    try {
      return await this.runTranslation(articleId, controller, force)
    } finally {
      if (this.jobs.get(articleId) === controller) this.jobs.delete(articleId)
    }
  }

  private async runTranslation(articleId: string, controller: AbortController, force: boolean): Promise<TranslationResult> {
    const { provider, model } = this.providers.resolve(this.getPreferences())
    const apiKey = await this.secrets.getApiKey(provider.id)
    if (controller.signal.aborted) throw new Error('翻译已取消')
    if (!apiKey) throw new Error(`请先在设置中填写 ${provider.name} API Key`)

    const cacheModel = translationCacheModel(provider, model)
    this.database.preserveTranslations?.(articleId)
    const article = this.database.getArticle(articleId)
    const allBlocks = this.database.getTranslatableBlocks(articleId)
    const missing = allBlocks.filter((block) =>
      force || !this.database.hasTranslation(
        block.id,
        block.sourceHash,
        cacheModel,
        TRANSLATION_PROMPT_VERSION,
      ),
    )
    if (missing.length === 0) {
      this.emitProgress({ articleId, completed: allBlocks.length, total: allBlocks.length, status: 'completed' })
      return { articleId, translated: allBlocks.length, total: allBlocks.length, cached: true }
    }

    let completed = allBlocks.length - missing.length
    this.emitProgress({ articleId, completed, total: allBlocks.length, status: 'started' })

    try {
      const batches = makeBatches(missing, model)
      while (batches.length > 0) {
        let remaining = batches.shift()!
        for (let partialRound = 0; partialRound < 3 && remaining.length > 0; partialRound++) {
          let translated: ApiSegment[]
          try {
            translated = await this.requestBatch(
              provider,
              model,
              apiKey,
              article.title,
              article.sectionTitle,
              remaining,
              controller.signal,
            )
          } catch (error) {
            if (error instanceof TruncatedCompletionError && remaining.length > 1) {
              const middle = Math.ceil(remaining.length / 2)
              batches.unshift(remaining.slice(middle))
              remaining = remaining.slice(0, middle)
              partialRound = -1
              continue
            }
            throw error
          }
          const translatedIds = new Set<string>()
          for (const segment of translated) {
            const source = remaining.find((item) => item.id === segment.blockId)
            if (!source || translatedIds.has(source.id)) continue
            const translation = segment.translation.trim()
            if (!translation) continue
            this.database.saveTranslation(
              source.id,
              source.sourceHash,
              translation,
              cacheModel,
              TRANSLATION_PROMPT_VERSION,
            )
            translatedIds.add(source.id)
            completed += 1
            this.emitProgress({ articleId, completed, total: allBlocks.length, status: 'progress' })
          }
          remaining = remaining.filter((source) => !translatedIds.has(source.id))
        }
        if (remaining.length > 0) {
          throw new Error(`模型未返回 ${remaining.length} 个段落的译文，可稍后重试`)
        }
      }

      this.database.preserveTranslations?.(articleId)
      this.emitProgress({ articleId, completed, total: allBlocks.length, status: 'completed' })
      return { articleId, translated: completed, total: allBlocks.length, cached: false }
    } catch (error) {
      if (controller.signal.aborted) {
        this.emitProgress({ articleId, completed, total: allBlocks.length, status: 'cancelled' })
        throw new Error('翻译已取消')
      }
      const message = safeErrorMessage(error, provider.name)
      this.emitProgress({ articleId, completed, total: allBlocks.length, status: 'error', message })
      throw new Error(message)
    }
  }

  cancel(articleId: string): void {
    this.jobs.get(articleId)?.abort()
  }

  getSelectionIdentity(): ModelSelectionIdentity {
    const { provider, model } = this.providers.resolve(this.getPreferences())
    return {
      providerId: provider.id,
      modelId: model.id,
      cacheModel: translationCacheModel(provider, model),
    }
  }

  async completeJson(
    systemPrompt: string,
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const { provider, model } = this.providers.resolve(this.getPreferences())
    const apiKey = await this.secrets.getApiKey(provider.id)
    if (!apiKey) throw new Error(`请先在设置中填写 ${provider.name} API Key`)
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.network.fetch(provider.chatCompletionsUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model.id,
            response_format: { type: 'json_object' },
            ...model.requestOptions,
            ...completionBudget(model, 2_048),
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(payload) },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.status === 401 || response.status === 403) {
          throw new NonRetryableError('API Key 无效或账户无权访问该模型')
        }
        const body = await response.text()
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            throw new RetryableError(`${provider.name} 暂时不可用（HTTP ${response.status}）`)
          }
          throw new NonRetryableError(`${provider.name} 请求失败（HTTP ${response.status}）`)
        }
        const outer = JSON.parse(body) as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
        }
        const choice = outer.choices?.[0]
        if (choice?.finish_reason === 'length') throw new RetryableError(`${provider.name} 返回内容被截断`)
        if (!choice?.message?.content) throw new RetryableError(`${provider.name} 返回了空内容`)
        return JSON.parse(stripCodeFence(choice.message.content)) as Record<string, unknown>
      } catch (error) {
        if (error instanceof NonRetryableError) throw error
        lastError = error instanceof Error ? error : new Error('模型请求失败')
        if (attempt < 2) await delay(attempt === 0 ? 500 : 1_500, new AbortController().signal)
      }
    }
    throw new Error(safeErrorMessage(lastError, provider.name))
  }

  async translateTexts(texts:string[]):Promise<string[]> {
    if(!texts.length)return[]
    const {provider,model}=this.providers.resolve(this.getPreferences())
    const apiKey=await this.secrets.getApiKey(provider.id)
    if(!apiKey)throw new Error(`请先在设置中填写 ${provider.name} API Key`)
    const segments=texts.map((text,index)=>({id:`example_${index}`,type:'example',text,sourceHash:''}))
    const translated=await this.requestBatch(provider,model,apiKey,'Dictionary examples',null,segments,new AbortController().signal)
    const byId=new Map(translated.map(item=>[item.blockId,item.translation]))
    return texts.map((_,index)=>byId.get(`example_${index}`)??'')
  }

  async testConnection(preferences: TranslationPreferences = this.getPreferences()): Promise<ConnectionTestResult> {
    let resolved: ReturnType<TranslationProviderRegistry['resolve']>
    try {
      resolved = this.providers.resolve(preferences)
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error) }
    }
    const { provider, model } = resolved
    const apiKey = await this.secrets.getApiKey(provider.id)
    if (!apiKey) return { ok: false, message: `尚未保存 ${provider.name} API Key` }
    try {
      const response = await this.network.fetch(provider.chatCompletionsUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.id,
          response_format: { type: 'json_object' },
          ...model.requestOptions,
          ...completionBudget(model, 32),
          messages: [
            { role: 'system', content: '只返回 JSON：{"ok":true}。' },
            { role: 'user', content: '连接测试' },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'API Key 无效或无权访问' }
      }
      if (!response.ok) return { ok: false, message: `连接失败（HTTP ${response.status}）` }
      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      if (!json.choices?.[0]?.message?.content) {
        return { ok: false, message: `${provider.name} 返回了空内容` }
      }
      return { ok: true, message: `连接成功，${model.name} 可用（本次测试会产生极少量用量）` }
    } catch (error) {
      return { ok: false, message: safeErrorMessage(error, provider.name) }
    }
  }

  private async requestBatch(
    provider: TranslationProviderDefinition,
    model: TranslationModelDefinition,
    apiKey: string,
    articleTitle: string,
    sectionTitle: string | null,
    segments: SourceSegment[],
    signal: AbortSignal,
  ): Promise<ApiSegment[]> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new Error('翻译已取消')
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(COMPLETION_TIMEOUT_MS)])
        const response = await this.network.fetch(provider.chatCompletionsUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model.id,
            response_format: { type: 'json_object' },
            ...model.requestOptions,
            ...completionBudget(model),
            messages: [
              {
                role: 'system',
                content: [
                  '你是严谨的英中杂志翻译。将英文翻译为自然、准确、适合阅读的简体中文。',
                  '保持作者语气、专名、数字、限定语和逻辑关系，不添加解释，不遗漏信息。',
                  '只返回 JSON 对象，格式为 {"segments":[{"blockId":"原ID","translation":"译文"}]}。',
                  '每个输入 blockId 必须且只能出现一次。',
                ].join('\n'),
              },
              {
                role: 'user',
                content: JSON.stringify({
                  articleTitle,
                  sectionTitle,
                  segments: segments.map(({ id, type, text }) => ({ blockId: id, type, text })),
                }),
              },
            ],
          }),
          signal: requestSignal,
        })

        if (response.status === 401 || response.status === 403) {
          throw new NonRetryableError('API Key 无效或账户无权访问该模型')
        }
        const body = await response.text()
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            throw new RetryableError(`${provider.name} 暂时不可用（HTTP ${response.status}）`)
          }
          throw new NonRetryableError(`${provider.name} 请求失败（HTTP ${response.status}）`)
        }
        const outer = JSON.parse(body) as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
        }
        const choice = outer.choices?.[0]
        if (choice?.finish_reason === 'length') {
          throw new TruncatedCompletionError(`${provider.name} 返回内容被截断，正在缩小批次`)
        }
        const content = choice?.message?.content
        if (!content) throw new RetryableError(`${provider.name} 返回了空内容`)
        const parsed = JSON.parse(stripCodeFence(content)) as { segments?: unknown }
        if (!Array.isArray(parsed.segments)) throw new RetryableError(`${provider.name} 返回格式不正确`)
        return parsed.segments
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
          .map((item) => ({
            blockId: String(item.blockId ?? ''),
            translation: String(item.translation ?? ''),
          }))
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof NonRetryableError || error instanceof TruncatedCompletionError) throw error
        lastError = error instanceof Error ? error : new Error('翻译请求失败')
        if (attempt < 2) await delay(attempt === 0 ? 1_000 : 3_000, signal)
      }
    }
    throw lastError ?? new Error('翻译请求失败')
  }
}

export class DeepSeekTranslationService extends TranslationService {
  constructor(
    database: TranslationRepository,
    secrets: ApiKeyStore,
    emitProgress: (progress: TranslationProgress) => void,
    network: NetworkClient,
  ) {
    super(database, secrets, () => DEFAULT_TRANSLATION_PREFERENCES, emitProgress, network)
  }
}

class RetryableError extends Error {}
class NonRetryableError extends Error {}
class TruncatedCompletionError extends Error {}

function makeBatches(blocks: SourceSegment[], model: TranslationModelDefinition): SourceSegment[][] {
  const batches: SourceSegment[][] = []
  let current: SourceSegment[] = []
  let characters = 0
  const maxBlocks = model.maxBlocksPerBatch ?? MAX_BLOCKS_PER_BATCH
  const maxCharacters = model.maxCharactersPerBatch ?? MAX_CHARACTERS_PER_BATCH
  for (const block of blocks) {
    if (current.length > 0 && (
      current.length >= maxBlocks
      || characters + block.text.length > maxCharacters
    )) {
      batches.push(current)
      current = []
      characters = 0
    }
    current.push(block)
    characters += block.text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function completionBudget(model: TranslationModelDefinition, limit?: number): Record<string, number> {
  const maximum = model.maxCompletionTokens ?? 8_192
  return { [model.completionTokenField ?? 'max_tokens']: Math.min(limit ?? maximum, maximum) }
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new Error('翻译已取消'))
    }, { once: true })
  })
}

function safeErrorMessage(error: unknown, providerName = '模型服务'): string {
  if (error instanceof SyntaxError) return '模型返回的数据无法解析，请重试'
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `连接 ${providerName} 超时`
    if (/fetch failed/i.test(error.message)) return `无法连接 ${providerName}，请检查网络`
    return error.message.replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏密钥]')
  }
  return '发生未知错误'
}
