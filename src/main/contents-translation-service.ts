import { contentsSegments } from '../core/contents-segments'
import { contentsCacheKey, type ContentsCache } from '../core/contents-cache'
import type { TranslationService } from '../core/translation-service'
import type { PublicationDetail, TranslationPreferences, TranslationProgress } from '../shared/types'

/** Persist partial results so a cancelled request or application restart can resume. */
export class ContentsTranslationService {
  private readonly jobs = new Map<string, AbortController>()
  private clearing = false
  constructor(
    private readonly translator: TranslationService,
    private readonly getPublication: (id: string) => PublicationDetail,
    private readonly getPreferences: () => TranslationPreferences,
    private readonly emit: (progress: TranslationProgress) => void,
    private readonly cache: ContentsCache,
  ) {}

  private source(id: string) {
    const publication = this.getPublication(id)
    const segments = contentsSegments(publication)
    const preferences = this.getPreferences()
    const key = contentsCacheKey(publication, preferences)
    return { publication, segments, preferences, key }
  }

  get(id: string): Record<string, string> {
    return this.cache.read(this.source(id).key)
  }

  cancel(id: string): void { this.jobs.get(id)?.abort() }

  cancelAll(): void { for (const job of this.jobs.values()) job.abort() }

  async clearCache<T>(clear: () => Promise<T>): Promise<T> {
    this.clearing = true
    this.cancelAll()
    try { return await clear() }
    finally { this.clearing = false }
  }

  async translate(id: string, force = false): Promise<Record<string, string>> {
    if (this.clearing) throw new Error('正在清理缓存，请稍后重试')
    if (this.jobs.has(id)) throw new Error('该目录正在翻译')
    const { publication, segments, preferences, key } = this.source(id)
    const controller = new AbortController()
    this.jobs.set(id, controller)
    const result = this.cache.read(key)
    const missing = segments.filter(segment => force || !result[segment.id])
    let completed = segments.length - missing.length
    const progress = (status: TranslationProgress['status'], message?: string) =>
      this.emit({ articleId: id, completed, total: segments.length, status, message })
    const save = () => {
      if (controller.signal.aborted) throw new Error('翻译已取消')
      this.cache.write(key, result)
    }
    try {
      progress('started')
      if (missing.length) await this.translator.translateSegments(publication.title, missing, preferences, controller.signal, (segmentId, text) => {
        result[segmentId] = text
        completed++
        save()
        progress('progress')
      })
      save()
      progress('completed')
      return result
    } catch (error) {
      progress(controller.signal.aborted ? 'cancelled' : 'error', error instanceof Error ? error.message : '目录翻译失败')
      throw error
    } finally {
      this.jobs.delete(id)
    }
  }
}
