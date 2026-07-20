import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ParsedPublication } from '../shared/types'
import type { PublicationImporter } from '../core/ports'

export class EpubImporter implements PublicationImporter {
  private worker: Worker | null = null
  parse(data: Uint8Array): Promise<ParsedPublication> {
    const transferable = Uint8Array.from(data)
    return this.runWorker({ data: transferable }, [transferable.buffer])
  }

  parseFile(sourceFile: string): Promise<ParsedPublication> {
    return this.runWorker({ sourceFile })
  }

  private runWorker(
    input: { data?: Uint8Array; sourceFile?: string },
    transferList: ArrayBuffer[] = [],
  ): Promise<ParsedPublication> {
    if (this.worker) return Promise.reject(new Error('已有 EPUB 正在解析'))
    const colocated = path.join(__dirname, 'publication-import-worker.js')
    const workerPath = fs.existsSync(colocated)
      ? colocated
      : path.join(process.cwd(), 'dist-electron', 'main', 'publication-import-worker.js')
    return new Promise<ParsedPublication>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: input, transferList })
      this.worker = worker
      let settled = false
      worker.on('message', (message: { result?: ParsedPublication; error?: string }) => {
        if (settled) return
        settled = true
        this.worker = null
        void worker.terminate()
        if (message.error) reject(new Error(message.error))
        else if (message.result) resolve(message.result)
        else reject(new Error('EPUB 解析进程返回空结果'))
      })
      worker.on('error', (error) => { if (!settled) { settled = true; this.worker = null; reject(error) } })
      worker.on('exit', (code) => {
        if (!settled) {
          settled = true
          this.worker = null
          reject(new Error(code === 0 ? 'EPUB 解析进程未返回结果' : `EPUB 解析进程异常退出（${code}）`))
        }
      })
    })
  }

  cancel(): void {
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
  }
}

export type { PublicationImporter }
export { CONTENT_ID_VERSION } from '../core/epub-importer'
