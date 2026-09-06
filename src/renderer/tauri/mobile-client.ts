import { invoke } from '@tauri-apps/api/core'
import type {
  ArticleDetail,
  ImportProgress,
  ImportResult,
  LibraryApi,
  LibraryPreferences,
  LibraryState,
  ParsedPublicationPlan,
  PublicationDetail,
  PublicationSummary,
  ReaderPreferences,
  ReaderApi,
  ReadingPositionInput,
} from '../../shared/types'
import type {
  BeginEpubImportResult,
  MobileReadingClient,
  ParseWorkerMessage,
  ParseWorkerResponse,
} from '../../shared/mobile-reading'
import { normalizePlatformError } from './platform-error'
import { EMPTY_MOBILE_READER_SERVICES, type MobileReaderServiceSlots } from '../../shared/mobile-reader-services'

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface MobileEpubParseTask {
  worker: Worker
  promise: Promise<ParsedPublicationPlan>
  cancel(reason?: unknown): void
}

export function beginMobileEpubParse(
  begin: Extract<BeginEpubImportResult, { kind: 'ready' }>,
  invokeCommand: InvokeFn = invoke,
): MobileEpubParseTask {
  const worker = new Worker(new URL('./epub-parser-worker.ts', import.meta.url), { type: 'module' })
  let rejectTask: ((reason: unknown) => void) | undefined
  let settled = false
  const promise = new Promise<ParsedPublicationPlan>((resolve, reject) => {
    rejectTask = reject
    worker.onmessage = (event: MessageEvent<ParseWorkerMessage>) => {
      const message = event.data
      if (message.type === 'read') {
        void invokeCommand<string>('read_epub_text_entry', {
          sessionId: begin.sessionId,
          archivePath: message.archivePath,
        }).then(
          (text) => worker.postMessage({ type: 'entry', requestId: message.requestId, text } satisfies ParseWorkerResponse),
          (reason) => worker.postMessage({
            type: 'entry', requestId: message.requestId, error: normalizePlatformError(reason).message,
          } satisfies ParseWorkerResponse),
        )
      } else if (message.type === 'result') {
        settled = true
        resolve(message.plan)
      } else {
        settled = true
        reject({ code: 'epubInvalid', message: message.message, retryable: false })
      }
    }
    worker.onerror = (event) => {
      settled = true
      reject({ code: 'internalError', message: event.message || 'EPUB 解析 worker 异常退出', retryable: true })
    }
    worker.postMessage({
      type: 'parse',
      sessionId: begin.sessionId,
      contentHash: begin.contentHash,
      entries: begin.entries,
    } satisfies ParseWorkerResponse)
  }).finally(() => worker.terminate())
  return {
    worker,
    promise,
    cancel: (reason = { code: 'importCancelled', message: 'EPUB 导入已取消。', retryable: false }) => {
      if (settled) return
      settled = true
      worker.terminate()
      rejectTask?.(reason)
    },
  }
}

export class TauriMobileReadingClient implements MobileReadingClient {
  private listeners = new Set<(progress: ImportProgress) => void>()
  private active: {
    requestId: string
    sessionId?: string
    worker?: Worker
    rejectParse?: (reason: unknown) => void
  } | null = null

  constructor(
    private readonly invokeCommand: InvokeFn = invoke,
    readonly services: MobileReaderServiceSlots = EMPTY_MOBILE_READER_SERVICES,
  ) {}

  readonly library: LibraryApi = {
    importPublication: () => this.importPublication(),
    cancelImport: () => this.cancelImport(),
    onImportProgress: (callback) => this.onImportProgress(callback),
    listPublications: () => this.listPublications(),
    getState: () => this.getLibraryState(),
    savePreferences: (preferences) => this.saveLibraryPreferences(preferences),
    createCategory: (name) => this.createCategory(name),
    renameCategory: (categoryId, name) => this.renameCategory(categoryId, name),
    deleteCategory: (categoryId) => this.deleteCategory(categoryId),
    renamePublication: (publicationId, title) => this.renamePublication(publicationId, title),
    assignPublications: (publicationIds, categoryId) => this.assignPublications(publicationIds, categoryId),
    deletePublications: (publicationIds) => this.deletePublications(publicationIds),
    getPublication: (publicationId) => this.getPublication(publicationId),
  }

  readonly reader: ReaderApi = {
    searchArticles: (query) => this.invokeSafely('reader_search_articles', { query }),
    getReadingData: (articleId) => this.invokeSafely('reader_get_data', { articleId }),
    changeReadingData: async (articleId, change) => { const result = await this.invokeSafely<import('../../shared/reader-types').ArticleReadingData>('reader_change_data', { articleId, change }); return result },
    getArticle: (articleId) => this.getArticle(articleId),
    savePosition: (publicationId, articleId, position) => this.savePosition(publicationId, articleId, position),
    getPreferences: () => this.getPreferences(),
    savePreferences: (preferences) => this.savePreferences(preferences),
  }

  async importPublication(): Promise<ImportResult | null> {
    if (this.active) throw new Error('已有刊物正在导入')
    const requestId = crypto.randomUUID()
    this.active = { requestId }
    this.emit('reading', 0, 0, '请选择 EPUB 文件')
    try {
      const begin = await this.invokeSafely<BeginEpubImportResult>('begin_epub_import', { requestId })
      if (begin.kind === 'cancelled') {
        this.emit('cancelled', 0, 0, '已取消导入')
        return null
      }
      if (begin.kind === 'duplicate') {
        this.emit('completed', 1, 1, '出版物已存在')
        return begin.result
      }
      this.active.sessionId = begin.sessionId
      this.emit('parsing', 0, begin.entries.length, `正在解析 ${begin.displayName}`)
      const plan = await this.parseInWorker(begin)
      this.emit('writing', 0, plan.assetPaths.length + 1, '正在写入本地书库')
      const result = await this.invokeSafely<ImportResult>('commit_epub_import', {
        sessionId: begin.sessionId,
        parsedPlan: plan,
      })
      this.emit('completed', 1, 1, result.repaired ? '已重新解析并补全刊物' : result.duplicate ? '出版物已存在' : '导入完成')
      return result
    } catch (reason) {
      const error = normalizePlatformError(reason)
      const cancelled = error.code === 'importCancelled'
      const active = this.active
      if (active) {
        try {
          await this.invokeCommand<void>('cancel_epub_import', {
            requestOrSessionId: active.sessionId ?? active.requestId,
          })
        } catch {
          // Preserve the original import failure; cleanup is best-effort here.
        }
      }
      this.emit(cancelled ? 'cancelled' : 'error', 0, 0, cancelled ? '已取消导入' : error.message)
      if (cancelled) return null
      throw error
    } finally {
      this.active?.worker?.terminate()
      this.active = null
    }
  }

  async cancelImport(): Promise<void> {
    const active = this.active
    if (!active) return
    active.worker?.terminate()
    active.rejectParse?.({ code: 'importCancelled', message: 'EPUB 导入已取消。', retryable: false })
    await this.invokeSafely<void>('cancel_epub_import', {
      requestOrSessionId: active.sessionId ?? active.requestId,
    })
  }

  onImportProgress(callback: (progress: ImportProgress) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  listPublications(): Promise<PublicationSummary[]> {
    return this.invokeSafely('list_mobile_publications')
  }

  getLibraryState(): Promise<LibraryState> {
    return this.invokeSafely('get_mobile_library_state')
  }

  saveLibraryPreferences(preferences: LibraryPreferences): Promise<LibraryState> {
    return this.invokeSafely('save_mobile_library_preferences', { preferences })
  }

  createCategory(name: string): Promise<LibraryState> {
    return this.invokeSafely('create_mobile_library_category', { name })
  }

  renameCategory(categoryId: string, name: string): Promise<LibraryState> {
    return this.invokeSafely('rename_mobile_library_category', { categoryId, name })
  }

  deleteCategory(categoryId: string): Promise<LibraryState> {
    return this.invokeSafely('delete_mobile_library_category', { categoryId })
  }

  renamePublication(publicationId: string, title: string): Promise<LibraryState> {
    return this.invokeSafely('rename_mobile_publication', { publicationId, title })
  }

  assignPublications(publicationIds: string[], categoryId: string | null): Promise<LibraryState> {
    return this.invokeSafely('assign_mobile_publications', { publicationIds, categoryId })
  }

  deletePublications(publicationIds: string[]): Promise<LibraryState> {
    return this.invokeSafely('delete_mobile_publications', { publicationIds })
  }

  getPublication(publicationId: string): Promise<PublicationDetail> {
    return this.invokeSafely('get_mobile_publication', { publicationId })
  }

  getArticle(articleId: string): Promise<ArticleDetail> {
    return this.invokeSafely('get_mobile_article', { articleId })
  }

  savePosition(publicationId: string, articleId: string, position: ReadingPositionInput): Promise<void> {
    return this.invokeSafely('save_mobile_reading_position', { publicationId, articleId, position })
  }

  getPreferences(): Promise<ReaderPreferences> {
    return this.invokeSafely('get_mobile_reader_preferences')
  }

  savePreferences(preferences: ReaderPreferences): Promise<ReaderPreferences> {
    return this.invokeSafely('save_mobile_reader_preferences', { preferences })
  }

  private parseInWorker(begin: Extract<BeginEpubImportResult, { kind: 'ready' }>): Promise<ParsedPublicationPlan> {
    const task = beginMobileEpubParse(begin, this.invokeCommand)
    if (this.active) {
      this.active.worker = task.worker
      this.active.rejectParse = (reason) => task.cancel(reason)
    }
    return task.promise.finally(() => {
      if (this.active) this.active.rejectParse = undefined
    })
  }

  private emit(stage: ImportProgress['stage'], completed: number, total: number, message: string): void {
    for (const listener of this.listeners) listener({ stage, completed, total, message })
  }

  private async invokeSafely<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.invokeCommand<T>(command, args)
    } catch (reason) {
      throw normalizePlatformError(reason)
    }
  }
}
