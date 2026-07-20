import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekTranslationService, TranslationService } from '../src/main/translation-service'
import { createDefaultTranslationProviderRegistry } from '../src/core/translation-providers'
import type { ArticleDetail, TranslationProgress } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeekTranslationService', () => {
  it('stores aligned translations and reuses the cache', async () => {
    const repository = fakeRepository()
    const events: TranslationProgress[] = []
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        segments: [
          { blockId: 'block_title', translation: '测试文章' },
          { blockId: 'block_body', translation: '这是一段正文。' },
        ],
      }) } }],
    }), { status: 200 }))
    const service = new DeepSeekTranslationService(
      repository as never,
      { getApiKey: async () => 'test-key-only-not-real' },
      (event) => events.push(event),
      { fetch: fetchMock },
    )

    const first = await service.translateArticle('article_12345678')
    const second = await service.translateArticle('article_12345678')

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(repository.saved.get('block_title')).toBe('测试文章')
    expect(repository.saved.get('block_body')).toBe('这是一段正文。')
    expect(events.at(-1)?.status).toBe('completed')
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.model).toBe('deepseek-v4-flash')
    expect(request.thinking).toEqual({ type: 'disabled' })
  })

  it('retries only segments missing from a partial model response', async () => {
    const repository = fakeRepository()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        segments: [{ blockId: 'block_title', translation: '测试文章' }],
      }) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        segments: [{ blockId: 'block_body', translation: '补齐的正文。' }],
      }) } }] }), { status: 200 }))
    const service = new DeepSeekTranslationService(
      repository as never,
      { getApiKey: async () => 'test-key-only-not-real' },
      () => undefined,
      { fetch: fetchMock },
    )

    await service.translateArticle('article_12345678')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    const userPayload = JSON.parse(secondRequest.messages[1].content)
    expect(userPayload.segments.map((segment: { blockId: string }) => segment.blockId)).toEqual(['block_body'])
  })

  it('reports invalid credentials without retrying or exposing the key', async () => {
    const repository = fakeRepository()
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    const service = new DeepSeekTranslationService(
      repository as never,
      { getApiKey: async () => 'test-key-sensitive-placeholder' },
      () => undefined,
      { fetch: fetchMock },
    )

    await expect(service.translateArticle('article_12345678')).rejects.toThrow('API Key 无效')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the manually selected OpenAI low-cost model and provider endpoint', async () => {
    const repository = fakeRepository()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        segments: [
          { blockId: 'block_title', translation: '测试文章' },
          { blockId: 'block_body', translation: '这是一段正文。' },
        ],
      }) } }],
    }), { status: 200 }))
    const requestedProviders: string[] = []
    const service = new TranslationService(
      repository as never,
      { getApiKey: async (providerId) => { requestedProviders.push(providerId ?? ''); return 'test-key-only-not-real' } },
      () => ({ providerId: 'openai', modelId: 'gpt-5.4-nano' }),
      () => undefined,
      { fetch: fetchMock },
      createDefaultTranslationProviderRegistry(),
    )

    await service.translateArticle('article_12345678')

    expect(requestedProviders).toEqual(['openai'])
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.model).toBe('gpt-5.4-nano')
    expect(request.response_format).toEqual({ type: 'json_object' })
    expect(request.thinking).toBeUndefined()
    expect(repository.savedModels).toEqual(['openai:gpt-5.4-nano', 'openai:gpt-5.4-nano'])
  })

  it('tests the selected Kimi model with a tiny structured completion', async () => {
    const repository = fakeRepository()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200 }))
    const service = new TranslationService(
      repository as never,
      { getApiKey: async () => 'test-key-only-not-real' },
      () => ({ providerId: 'moonshot', modelId: 'moonshot-v1-8k' }),
      () => undefined,
      { fetch: fetchMock },
    )

    await expect(service.testConnection()).resolves.toEqual({
      ok: true,
      message: '连接成功，Moonshot V1 8K 可用（本次测试会产生极少量用量）',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.max_tokens).toBe(32)
  })

  it('splits a Kimi batch after a length-truncated completion', async () => {
    const repository = fakeRepository()
    const response = (blockId: string, translation: string) => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        segments: [{ blockId, translation }],
      }) } }],
    }), { status: 200 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '{"segments":[' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(response('block_title', '测试文章'))
      .mockResolvedValueOnce(response('block_body', '正文'))
    const service = new TranslationService(
      repository as never,
      { getApiKey: async () => 'test-key-only-not-real' },
      () => ({ providerId: 'moonshot', modelId: 'moonshot-v1-8k' }),
      () => undefined,
      { fetch: fetchMock },
    )

    await expect(service.translateArticle('article_12345678')).resolves.toMatchObject({ translated: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(firstRequest.max_tokens).toBe(4_096)
  })
})

function fakeRepository() {
  const saved = new Map<string, string>()
  const savedModels: string[] = []
  const source = [
    { id: 'block_title', type: 'title', text: 'A test article', sourceHash: 'hash-title' },
    { id: 'block_body', type: 'paragraph', text: 'This is a body paragraph.', sourceHash: 'hash-body' },
  ]
  const article: Partial<ArticleDetail> = {
    id: 'article_12345678',
    title: 'A test article',
    sectionTitle: 'Tests',
  }
  return {
    saved,
    savedModels,
    getArticle: () => article,
    getTranslatableBlocks: () => source,
    hasTranslation: (id: string) => saved.has(id),
    saveTranslation: (id: string, _hash: string, text: string, model: string) => {
      saved.set(id, text)
      savedModels.push(model)
    },
  }
}
