/// <reference lib="webworker" />
import { EpubImporter } from '../../core/epub-importer'
import { portableContentHasher } from '../../core/sha256'
import type {
  ParseWorkerMessage,
  ParseWorkerRequest,
  ParseWorkerResponse,
} from '../../shared/mobile-reading'

const scope = self as unknown as DedicatedWorkerGlobalScope
let nextRequestId = 1
const pending = new Map<number, { resolve(value: string): void; reject(reason: Error): void }>()

scope.onmessage = (event: MessageEvent<ParseWorkerResponse>) => {
  const message = event.data
  if (message.type === 'entry') {
    const request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.text ?? '')
    return
  }
  if (message.type === 'parse') void parse(message)
}

async function parse(request: ParseWorkerRequest): Promise<void> {
  try {
    const importer = new EpubImporter(portableContentHasher)
    const plan = await importer.parseArchive({
      listEntries: () => request.entries.map((entry) => ({
        path: entry.path,
        directory: entry.directory,
        compressedBytes: entry.compressedBytes,
        uncompressedBytes: entry.uncompressedBytes,
      })),
      readText: (archivePath) => readEntry(archivePath),
    }, request.contentHash)
    post({ type: 'result', plan })
  } catch (reason) {
    post({ type: 'error', message: reason instanceof Error ? reason.message : 'EPUB 解析失败' })
  }
}

function readEntry(archivePath: string): Promise<string> {
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    post({ type: 'read', requestId, archivePath })
  })
}

function post(message: ParseWorkerMessage): void {
  scope.postMessage(message)
}
