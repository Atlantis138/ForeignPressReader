import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type { NetworkClient } from '../core/network-client'
import type { DictionaryInstallProgress } from '../shared/types'
import {
  ECDICT_CSV_BLOB_SHA,
  ECDICT_CSV_SIZE,
  ECDICT_DOWNLOAD_BASES,
  ECDICT_LEMMA_BLOB_SHA,
  ECDICT_LEMMA_SIZE,
} from './dictionary-source'

type InstallInput =
  | { mode: 'download'; profile: 'standard' | 'full' }
  | { mode: 'local'; profile: 'standard' | 'full'; csvPath: string; lemmaPath?: string }

interface ActiveInstall {
  controller: AbortController
  worker: Worker | null
  stagingRoot: string
  cancelled: boolean
}

interface WorkerResult {
  basePath: string
  fullPath: string | null
  entryCount: number
  lexemeMapHash: string
}

export class DictionaryInstaller {
  private active: ActiveInstall | null = null

  constructor(
    private readonly dictionariesRoot: string,
    private readonly onProgress: (progress: DictionaryInstallProgress) => void,
    private readonly beforeSwap: () => void | Promise<void>,
    private readonly network: NetworkClient,
  ) {}

  get installing(): boolean {
    return this.active !== null
  }

  installFromDownload(profile: 'standard' | 'full' = 'standard'): Promise<void> {
    return this.start({ mode: 'download', profile })
  }

  installFromLocal(csvPath: string, lemmaPath?: string, profile: 'standard' | 'full' = 'standard'): Promise<void> {
    return this.start({ mode: 'local', profile, csvPath, lemmaPath })
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    active.cancelled = true
    active.controller.abort()
    if (active.worker) await active.worker.terminate()
    this.onProgress({ stage: 'cancelled', downloadedBytes: 0, totalBytes: 0, indexedEntries: 0 })
  }

  private start(input: InstallInput): Promise<void> {
    if (this.active) return Promise.reject(new Error('词典正在安装'))
    fs.mkdirSync(this.dictionariesRoot, { recursive: true })
    const active: ActiveInstall = {
      controller: new AbortController(),
      worker: null,
      stagingRoot: path.join(this.dictionariesRoot, `.staging-${Date.now()}`),
      cancelled: false,
    }
    fs.mkdirSync(active.stagingRoot, { recursive: true })
    this.active = active
    return this.execute(active, input)
  }

  private async execute(active: ActiveInstall, input: InstallInput): Promise<void> {
    try {
      let csvPath: string
      let lemmaPath: string | undefined
      if (input.mode === 'download') {
        csvPath = path.join(active.stagingRoot, 'ecdict.csv')
        lemmaPath = path.join(active.stagingRoot, 'lemma.en.txt')
        await this.downloadFile(
          active,
          'ecdict.csv',
          csvPath,
          ECDICT_CSV_SIZE,
          ECDICT_CSV_BLOB_SHA,
          'downloading-dictionary',
        )
        await this.downloadFile(
          active,
          'lemma.en.txt',
          lemmaPath,
          ECDICT_LEMMA_SIZE,
          ECDICT_LEMMA_BLOB_SHA,
          'downloading-lemma',
        )
      } else {
        csvPath = input.csvPath
        lemmaPath = input.lemmaPath
      }

      this.throwIfCancelled(active)
      const result = await this.runWorker(active, csvPath, lemmaPath, input.profile)
      this.throwIfCancelled(active)
      await this.beforeSwap()
      this.throwIfCancelled(active)
      this.swapDatabases(result, input.profile)
      this.onProgress({
        stage: 'completed',
        downloadedBytes: 0,
        totalBytes: 0,
        indexedEntries: result.entryCount,
      })
    } catch (error) {
      if (active.cancelled || active.controller.signal.aborted) throw new Error('词典安装已取消')
      const failure = error instanceof Error ? error : new Error('词典安装失败')
      this.onProgress({
        stage: 'error',
        downloadedBytes: 0,
        totalBytes: 0,
        indexedEntries: 0,
        message: failure.message,
      })
      throw failure
    } finally {
      if (this.active === active) this.active = null
      fs.rmSync(active.stagingRoot, { recursive: true, force: true })
    }
  }

  private async downloadFile(
    active: ActiveInstall,
    fileName: string,
    destination: string,
    expectedSize: number,
    expectedBlobSha: string,
    stage: DictionaryInstallProgress['stage'],
  ): Promise<void> {
    let lastError: Error | null = null
    for (const base of ECDICT_DOWNLOAD_BASES) {
      this.throwIfCancelled(active)
      try {
        await this.downloadOnce(
          active,
          `${base}/${fileName}`,
          destination,
          expectedSize,
          expectedBlobSha,
          stage,
        )
        return
      } catch (error) {
        if (active.cancelled || active.controller.signal.aborted) throw error
        lastError = error instanceof Error ? error : new Error('词典下载失败')
        fs.rmSync(destination, { force: true })
      }
    }
    throw lastError ?? new Error('所有词典下载地址均不可用')
  }

  private async downloadOnce(
    active: ActiveInstall,
    url: string,
    destination: string,
    expectedSize: number,
    expectedBlobSha: string,
    stage: DictionaryInstallProgress['stage'],
  ): Promise<void> {
    const response = await this.network.fetch(url, {
      redirect: 'follow',
      signal: active.controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`词典下载失败（HTTP ${response.status}）`)
    const file = fs.createWriteStream(destination)
    const hash = crypto.createHash('sha1')
    hash.update(`blob ${expectedSize}\0`)
    let downloaded = 0
    let lastReported = 0
    try {
      for await (const chunk of response.body) {
        this.throwIfCancelled(active)
        const buffer = Buffer.from(chunk)
        downloaded += buffer.length
        hash.update(buffer)
        if (!file.write(buffer)) await new Promise<void>((resolve) => file.once('drain', resolve))
        if (downloaded - lastReported >= 512 * 1024) {
          lastReported = downloaded
          this.onProgress({ stage, downloadedBytes: downloaded, totalBytes: expectedSize, indexedEntries: 0 })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        file.once('error', onError)
        file.end(() => {
          file.off('error', onError)
          resolve()
        })
      })
    }
    if (downloaded !== expectedSize || hash.digest('hex') !== expectedBlobSha) {
      throw new Error('词典文件完整性校验失败')
    }
  }

  private runWorker(active: ActiveInstall, csvPath: string, lemmaPath: string | undefined, profile: 'standard' | 'full'): Promise<WorkerResult> {
    const worker = new Worker(path.join(__dirname, 'dictionary-worker.js'), {
      workerData: { mode: 'local', profile, stagingRoot: active.stagingRoot, csvPath, lemmaPath },
    })
    active.worker = worker
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        active.worker = null
        reject(error)
      }
      worker.on('message', (message: Record<string, unknown>) => {
        if (message.type === 'progress') {
          this.onProgress(message as unknown as DictionaryInstallProgress)
          return
        }
        if (message.type === 'error') {
          void worker.terminate()
          fail(new Error(String(message.message ?? '词典安装失败')))
          return
        }
        if (message.type === 'done') {
          settled = true
          active.worker = null
          resolve({
            basePath: String(message.basePath),
            fullPath: message.fullPath == null ? null : String(message.fullPath),
            entryCount: Number(message.entryCount ?? 0),
            lexemeMapHash: String(message.lexemeMapHash ?? ''),
          })
        }
      })
      worker.on('error', fail)
      worker.on('exit', (code) => {
        if (!settled) {
          fail(active.cancelled
            ? new Error('词典安装已取消')
            : new Error(`词典安装进程异常结束（${code}）`))
        }
      })
    })
  }

  private swapDatabases(result: WorkerResult, profile: 'standard' | 'full'): void {
    const baseDestination = path.join(this.dictionariesRoot, 'ecdict-base.sqlite')
    const fullDestination = path.join(this.dictionariesRoot, 'ecdict-full.sqlite')
    const existingHash = metadataValue(baseDestination, 'lexemeMapHash')
    const replaceBase = !fs.existsSync(baseDestination) || existingHash !== result.lexemeMapHash
    if (replaceBase) this.swapOne(result.basePath, baseDestination)
    if (profile === 'full' && result.fullPath) this.swapOne(result.fullPath, fullDestination)
    if (profile === 'standard' && replaceBase && metadataValue(fullDestination, 'lexemeMapHash') !== result.lexemeMapHash) {
      fs.rmSync(fullDestination, { force: true })
    }
  }

  private swapOne(source: string, destination: string): void {
    const backup = `${destination}.backup`
    fs.rmSync(backup, { force: true })
    if (fs.existsSync(destination)) fs.renameSync(destination, backup)
    try {
      fs.renameSync(source, destination)
      fs.rmSync(backup, { force: true })
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination)
      throw error
    }
  }

  private throwIfCancelled(active: ActiveInstall): void {
    if (active.cancelled || active.controller.signal.aborted) throw new Error('词典安装已取消')
  }
}

function metadataValue(databasePath: string, key: string): string | null {
  if (!fs.existsSync(databasePath)) return null
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try { return String((db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value?:unknown}|undefined)?.value ?? '') || null }
    finally { db.close() }
  } catch { return null }
}
