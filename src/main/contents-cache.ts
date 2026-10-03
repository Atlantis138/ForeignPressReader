import fs from 'node:fs'
import path from 'node:path'
import type { ContentsCache } from '../core/contents-cache'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_ENTRY_BYTES = 8 * 1024 * 1024

export class FileContentsCache implements ContentsCache {
  constructor(private readonly directory: string) {}

  read(key: string): Record<string, string> {
    const file = this.file(key)
    try {
      if (fs.statSync(file).size > MAX_ENTRY_BYTES) return {}
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && Boolean(entry[1].trim())))
    } catch { return {} } // A missing or damaged cache can always be regenerated.
  }

  write(key: string, translations: Record<string, string>): void {
    const file = this.file(key)
    const bytes = JSON.stringify(translations)
    if (Buffer.byteLength(bytes) > MAX_ENTRY_BYTES) throw new Error('目录译文超过缓存大小限制')
    fs.mkdirSync(this.directory, { recursive: true })
    const temporary = `${file}.partial`
    try {
      fs.writeFileSync(temporary, bytes, { flush: true })
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(temporary, { force: true }) }
    const entries = fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => { const target = path.join(this.directory, name); return { target, ...fs.statSync(target) } })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) {
      if (total <= MAX_BYTES) break
      if (entry.target === file) continue
      fs.rmSync(entry.target, { force: true })
      total -= entry.size
    }
  }

  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('目录缓存标识无效')
    return path.join(this.directory, `${key}.json`)
  }
}
