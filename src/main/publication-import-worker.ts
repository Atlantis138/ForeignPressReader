import crypto from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import { EPUB_SAFETY_POLICY, type ContentHasher } from '../core/epub-importer'
import { parseEpubBuffer, parseEpubFile } from './epub-archive'

const hasher: ContentHasher = {
  sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') },
}

const input = workerData as { data?: Uint8Array; sourceFile?: string }
const port = parentPort

if (!port) throw new Error('EPUB 解析进程缺少主进程通信端口')

void parseInput(input)
  .then((result) => {
    const transferList = [...new Set([...result.assets.values()].map((asset) => asset.buffer))]
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
    port.postMessage({ result }, transferList)
  })
  .catch((error) => port.postMessage({ error: error instanceof Error ? error.message : 'EPUB 解析失败' }))

async function parseInput(value: { data?: Uint8Array; sourceFile?: string }) {
  if (value.sourceFile) return parseEpubFile(value.sourceFile, hasher)
  if (value.data) {
    if (value.data.byteLength === 0 || value.data.byteLength > EPUB_SAFETY_POLICY.sourceBytes) {
      throw new Error('EPUB 文件为空或超过 500 MiB 限制')
    }
    return parseEpubBuffer(value.data, hasher)
  }
  throw new Error('EPUB 解析任务缺少输入')
}
