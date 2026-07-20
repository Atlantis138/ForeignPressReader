import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SpeechAudio, SpeechSynthesisRequest } from '../shared/types'
import { appCachePath } from './app-cache'

const MAX_CACHE_BYTES = 256 * 1024 * 1024
const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export class SpeechAudioCache {
  private readonly root: string
  private readonly inFlight = new Map<string, Promise<SpeechAudio>>()
  private generation = 0

  constructor(userDataPath: string, private readonly maximumBytes = MAX_CACHE_BYTES) {
    this.root = appCachePath(userDataPath, 'speech')
  }

  async getOrCreate(request: SpeechSynthesisRequest, producer: () => Promise<SpeechAudio>): Promise<SpeechAudio> {
    const key = cacheKey(request)
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const task = this.resolve(key, request.providerId, producer, this.generation)
    this.inFlight.set(key, task)
    try { return await task } finally { this.inFlight.delete(key) }
  }

  async clear(): Promise<number> {
    const bytes = await this.size()
    this.generation += 1
    await fs.promises.rm(this.root, { recursive: true, force: true })
    return bytes
  }

  async size(): Promise<number> { return directoryBytes(this.root) }
  get directory(): string { return this.root }

  private async resolve(
    key: string,
    providerId: SpeechSynthesisRequest['providerId'],
    producer: () => Promise<SpeechAudio>,
    generation: number,
  ): Promise<SpeechAudio> {
    const directory = path.join(this.root, providerId)
    const filePath = path.join(directory, `${key}.mp3`)
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.size > 0 && stat.size <= MAX_AUDIO_BYTES) {
        const bytes = await fs.promises.readFile(filePath)
        if (isLikelyMp3(bytes)) {
          const now = new Date()
          await fs.promises.utimes(filePath, now, now).catch(() => undefined)
          return { bytes: new Uint8Array(bytes), mimeType: 'audio/mpeg' }
        }
      }
      await fs.promises.rm(filePath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await fs.promises.rm(filePath, { force: true })
    }
    const result = await producer()
    if (result.bytes.length === 0 || result.bytes.length > MAX_AUDIO_BYTES || !isLikelyMp3(result.bytes)) return result
    if (generation !== this.generation) return result
    await fs.promises.mkdir(directory, { recursive: true })
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(temporary, result.bytes, { mode: 0o600 })
      await fs.promises.rename(temporary, filePath)
      await this.prune()
    } finally { await fs.promises.rm(temporary, { force: true }) }
    return result
  }

  private async prune(): Promise<void> {
    const files = await listFiles(this.root)
    let total = files.reduce((sum, item) => sum + item.size, 0)
    for (const item of files.sort((a, b) => a.time - b.time)) {
      if (total <= this.maximumBytes) break
      await fs.promises.rm(item.path, { force: true })
      total -= item.size
    }
  }
}

function cacheKey(request: SpeechSynthesisRequest): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1, providerId: request.providerId, modelId: request.modelId,
    voiceId: request.voiceId, locale: request.locale, rate: Number(request.rate.toFixed(2)),
    textHash: crypto.createHash('sha256').update(request.text).digest('hex'),
  })).digest('hex')
}

function isLikelyMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
}

async function directoryBytes(root: string): Promise<number> {
  return (await listFiles(root)).reduce((sum, item) => sum + item.size, 0)
}

async function listFiles(root: string): Promise<Array<{ path: string; size: number; time: number }>> {
  const result: Array<{ path: string; size: number; time: number }> = []
  const visit = async (directory: string) => {
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(target)
        result.push({ path: target, size: stat.size, time: stat.mtimeMs })
      }
    }
  }
  await visit(root)
  return result
}
