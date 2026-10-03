import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { DesktopTranslationProviderRegistry, requireModelId } from '../src/main/desktop-translation-models'
import { createDefaultTranslationProviderRegistry } from '../src/core/translation-providers'
import { FileContentsCache } from '../src/main/contents-cache'
import { contentsCacheKey } from '../src/core/contents-cache'
import { ContentsTranslationService } from '../src/main/contents-translation-service'
import { TranslationService } from '../src/core/translation-service'
import type { PublicationDetail, TranslationPreferences, TranslationProgress } from '../src/shared/types'

describe('desktop translation configuration', () => {
  it('persists provider-scoped custom models without exporting desktop connection settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-models-'))
    let db = await SqliteApplicationRepository.open(root, 'test')
    try {
      const custom = { providerId: 'openai', modelId: 'custom/model:1' }
      db.saveTranslationPreferences({ providerId: 'moonshot', modelId: 'kimi-k2.6' })
      db.saveTranslationPreferences(custom)
      db.saveTranslationPreferences(custom)
      db.saveTranslationPreferences({ ...custom, providerId: 'deepseek' })
      expect(db.desktopTranslationModels().read().models).toHaveLength(2)
      db.close()
      db = await SqliteApplicationRepository.open(root, 'test')
      expect(db.getTranslationPreferences()).toEqual({ ...custom, providerId: 'deepseek' })
      const exported = db.exportPortableUserData().settings
      expect(exported.some(row => /^(desktop|local)\./.test(row.key))).toBe(false)
      expect(JSON.parse(exported.find(row => row.key === 'translation.preferences')!.value))
        .toEqual({ providerId: 'moonshot', modelId: 'kimi-k2.6' })
      db.desktopTranslationModels().delete({ ...custom, providerId: 'deepseek' })
      expect(db.getTranslationPreferences()).toEqual({ providerId: 'moonshot', modelId: 'kimi-k2.6' })
      expect(db.desktopTranslationModels().read().models).toEqual([custom])
      db.saveTranslationPreferences(custom)
      db.saveTranslationPreferences({ providerId: 'openai', modelId: 'gpt-5.4-mini' })
      expect(db.getTranslationPreferences().modelId).toBe('gpt-5.4-mini')
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('validates names and keeps the shared built-in registry unchanged', () => {
    expect(requireModelId(' custom/model:1 ')).toBe('custom/model:1')
    for (const value of ['', 'x'.repeat(101), 'a\nb', 'a b', null]) expect(() => requireModelId(value)).toThrow()
    const selection = { providerId: 'openai', modelId: 'custom-model' }
    expect(new DesktopTranslationProviderRegistry().resolve(selection).model.id).toBe('custom-model')
    expect(() => createDefaultTranslationProviderRegistry().resolve(selection)).toThrow()
  })
})

describe('publication contents translation', () => {
  const roots: string[] = []
  const cache = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contents-cache-'))
    roots.push(root)
    return new FileContentsCache(root)
  }
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
  it('matches the Android cache identity vector', () => {
    const vector = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test-vectors/contents-cache-v1.json'), 'utf8'))
    expect(contentsCacheKey(vector.publication, vector.preferences)).toBe(vector.key)
  })

  it('batches only contents, retries omissions, caches by source/model and supports forced translation', async () => {
    let preferences: TranslationPreferences = { providerId: 'openai', modelId: 'custom-model' }
    const publication = fixture()
    let omit = true
    const requests: Array<{ model: string; texts: string[] }> = []
    const network = { fetch: vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const segments = JSON.parse(body.messages[1].content).segments as Array<{ blockId: string; text: string }>
      requests.push({ model: body.model, texts: segments.map(segment => segment.text) })
      const selected = omit ? segments.slice(0, 1) : segments
      omit = false
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        segments: selected.map(segment => ({ blockId: segment.blockId, translation: `译文 ${segment.text}` })),
      }) } }] }))
    }) }
    const repository = { getArticle: vi.fn(), saveTranslation: vi.fn() }
    const translator = new TranslationService(repository as never, { getApiKey: async () => 'test-only' },
      () => preferences, () => undefined, network, new DesktopTranslationProviderRegistry())
    const events: TranslationProgress[] = []
    const service = new ContentsTranslationService(translator, () => publication, () => preferences, event => events.push(event), cache())
    const result = await service.translate(publication.id)
    expect(Object.keys(result)).toHaveLength(22)
    expect(requests[0].model).toBe('custom-model')
    expect(requests.every(request => request.texts.length <= 6)).toBe(true)
    expect(requests.flatMap(request => request.texts)).not.toContain('Private article body')
    expect(repository.getArticle).not.toHaveBeenCalled()
    expect(repository.saveTranslation).not.toHaveBeenCalled()
    const count = requests.length
    expect(await service.translate(publication.id)).toEqual(result)
    expect(requests).toHaveLength(count)
    await service.translate(publication.id, true)
    expect(requests.length).toBeGreaterThan(count)
    preferences = { ...preferences, modelId: 'second-model' }
    expect(service.get(publication.id)).toEqual({})
    await service.translate(publication.id)
    publication.sections[0].title = 'Changed section'
    expect(service.get(publication.id)).toEqual({})
    expect(events.at(-1)).toMatchObject({ status: 'completed', completed: 22, total: 22 })
  })

  it('restores complete and partial cache after a new service instance and discards damaged files', async () => {
    const publication = fixture()
    const preferences = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    const disk = cache()
    let fail = true
    const translator = { translateSegments: vi.fn(async (_title, segments, _preferences, _signal, save) => {
      for (const segment of segments) {
        save(segment.id, `译文 ${segment.text}`)
        if (fail) throw new Error('网络中断')
      }
    }) }
    const create = () => new ContentsTranslationService(translator as never, () => publication, () => preferences, () => undefined, new FileContentsCache(roots.at(-1)!))
    await expect(create().translate(publication.id)).rejects.toThrow('网络中断')
    expect(Object.keys(create().get(publication.id))).toHaveLength(1)
    fail = false
    const resumed = await create().translate(publication.id)
    expect(translator.translateSegments.mock.calls[1][1]).toHaveLength(21)
    expect(create().get(publication.id)).toEqual(resumed)
    await create().translate(publication.id)
    expect(translator.translateSegments).toHaveBeenCalledTimes(2)
    // Other issues must not evict this entry after eight translations.
    for (let index = 0; index < 12; index++) disk.write(String(index).padStart(64, '0'), { title: '另一刊物' })
    expect(create().get(publication.id)).toEqual(resumed)
    const file = path.join(roots.at(-1)!, `${contentsCacheKey(publication, preferences)}.json`)
    fs.writeFileSync(file, '{broken')
    expect(create().get(publication.id)).toEqual({})
    await create().translate(publication.id)
    expect(create().get(publication.id)).toEqual(resumed)
  })

  it('does not resurrect cleared cache when an old response arrives', async () => {
    const publication = fixture()
    const disk = cache()
    let finish!: () => void
    const translator = { translateSegments: async (_title: string, segments: Array<{id:string}>, _preferences: unknown, _signal: AbortSignal, save: (id: string, text: string) => void) => {
      await new Promise<void>(resolve => { finish = resolve })
      save(segments[0].id, '过期结果')
    } }
    const service = new ContentsTranslationService(translator as never, () => publication,
      () => ({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' }), () => undefined, disk)
    const pending = service.translate(publication.id)
    service.cancelAll()
    fs.rmSync(roots.at(-1)!, { recursive: true, force: true })
    finish()
    await expect(pending).rejects.toThrow('取消')
    expect(service.get(publication.id)).toEqual({})
    expect(fs.existsSync(roots.at(-1)!)).toBe(false)
  })

  it('reserves a job before key retrieval and cancels without losing completed entries', async () => {
    const publication = fixture()
    const preferences = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    const translator = { translateSegments: vi.fn(async (_title, segments, _preferences, signal, save) => {
      save(segments[0].id, '已完成')
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('翻译已取消')), { once: true }))
    }) }
    const events: TranslationProgress[] = []
    const service = new ContentsTranslationService(translator as never, () => publication, () => preferences, event => events.push(event), cache())
    const pending = service.translate(publication.id)
    await expect(service.translate(publication.id)).rejects.toThrow('正在翻译')
    service.cancel(publication.id)
    await expect(pending).rejects.toThrow('取消')
    expect(service.get(publication.id)).toEqual({ section_12345: '已完成' })
    expect(events.at(-1)?.status).toBe('cancelled')
  })
})

function fixture(): PublicationDetail {
  return { id: 'publication_12345', title: 'Test issue', sections: [{ id: 'section_12345', title: 'World', position: 0,
    articles: Array.from({ length: 10 }, (_, index) => ({ id: `article_${index}`, title: `Headline ${index}`, rubric: `Summary ${index}` })),
  }], unsectionedArticles: [{ id: 'opening_12345', title: 'Opening', rubric: null }] } as PublicationDetail
}
