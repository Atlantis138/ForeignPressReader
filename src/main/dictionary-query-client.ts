import path from 'node:path'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type {
  DictionaryCollection,
  DictionaryLearningPage,
  DictionarySearchPage,
  DictionarySearchQuery,
  LexemeCandidate,
  LexemeDetail,
} from '../shared/types'

export class DictionaryQueryClient {
  private worker: Worker | null = null
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  private readonly pending = new Map<number, { worker: Worker; resolve(value: any): void; reject(error: Error): void }>()

  constructor(private readonly databasePath: string, private readonly idleTimeoutMs = 60_000, private readonly fullPath: string | null = null) {}

  search(query: DictionarySearchQuery): Promise<DictionarySearchPage> { return this.call('search', query) }
  getLexeme(key: string): Promise<LexemeDetail> { return this.call('getLexeme', key) }
  listCollections(): Promise<DictionaryCollection[]> { return this.call('listCollections') }
  listCollectionMembers(tag: string, offset: number, limit = 500): Promise<DictionaryLearningPage> {
    return this.call('listCollectionMembers', { tag, offset, limit })
  }
  resolve(surface: string): Promise<LexemeCandidate[]> { return this.call('resolve', surface) }
  version(): Promise<string> { return this.call('version') }
  profile(): Promise<'standard'|'full'> { return this.call('profile') }

  async close(): Promise<void> {
    this.cancelIdleTermination()
    const worker = this.worker
    this.worker = null
    if (!worker) return
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue
      pending.reject(new Error('词典查询进程已关闭'))
      this.pending.delete(id)
    }
    await worker.terminate()
  }

  isRunningForDiagnostics(): boolean { return this.worker !== null }

  private call<T>(operation: string, payload?: unknown): Promise<T> {
    this.cancelIdleTermination()
    if (!this.worker) this.start()
    return this.callOn(this.worker!, operation, payload)
  }

  private callOn<T>(worker: Worker, operation: string, payload: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { worker, resolve, reject })
      worker.postMessage({ id, operation, payload })
    })
  }

  private start(): void {
    const colocated = path.join(__dirname, 'dictionary-query-worker.js')
    const workerPath = fs.existsSync(colocated)
      ? colocated
      : path.join(process.cwd(), 'dist-electron', 'main', 'dictionary-query-worker.js')
    const worker = new Worker(workerPath, {
      workerData: { basePath: this.databasePath, fullPath: this.fullPath },
    })
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending || pending.worker !== worker) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
      this.scheduleIdleTermination(worker)
    })
    const fail = (error: Error) => {
      if (this.worker !== worker) return
      this.worker = null
      this.cancelIdleTermination()
      for (const [id, pending] of this.pending) {
        if (pending.worker !== worker) continue
        pending.reject(error)
        this.pending.delete(id)
      }
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      if (code !== 0) fail(new Error(`词典查询进程异常退出（${code}）`))
      else fail(new Error('词典查询进程已退出'))
    })
    this.worker = worker
  }

  private scheduleIdleTermination(worker: Worker): void {
    if (this.worker !== worker || this.hasPending(worker)) return
    this.cancelIdleTermination()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.worker !== worker || this.hasPending(worker)) return
      this.worker = null
      void worker.terminate()
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private hasPending(worker: Worker): boolean {
    return [...this.pending.values()].some((pending) => pending.worker === worker)
  }

  private cancelIdleTermination(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
