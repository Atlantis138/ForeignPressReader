import fs from 'node:fs'
import path from 'node:path'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES = 5

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export class DiagnosticLogger {
  private enabled = false
  private readonly root: string
  constructor(
    userDataPath: string,
    private readonly maximumFileBytes = MAX_FILE_BYTES,
    private readonly maximumFiles = MAX_FILES,
  ) { this.root = path.join(userDataPath, 'logs') }

  setEnabled(enabled: boolean): void { this.enabled = enabled }
  get isEnabled(): boolean { return this.enabled }
  get directory(): string { return this.root }

  async log(level: DiagnosticLevel, area: string, event: string, details?: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return
    try {
      await fs.promises.mkdir(this.root, { recursive: true })
      const filePath = await this.currentFile()
      const record = JSON.stringify({
        timestamp: new Date().toISOString(), level,
        area: safeToken(area), event: safeToken(event), details: sanitize(details ?? {}),
      })
      await fs.promises.appendFile(filePath, `${record}\n`, { encoding: 'utf8', mode: 0o600 })
      await this.prune()
    } catch { /* diagnostics must never break application behavior */ }
  }

  async stats(): Promise<{ bytes: number; files: number }> {
    const files = await this.files()
    return { bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length }
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.root, { recursive: true, force: true })
    if (this.enabled) await fs.promises.mkdir(this.root, { recursive: true })
  }

  private async currentFile(): Promise<string> {
    const day = new Date().toISOString().slice(0, 10)
    const base = path.join(this.root, `app-${day}.jsonl`)
    const size = await statSize(base)
    if (size < this.maximumFileBytes) return base
    for (let index = 1; index < 100; index += 1) {
      const candidate = path.join(this.root, `app-${day}-${index}.jsonl`)
      if (await statSize(candidate) < this.maximumFileBytes) return candidate
    }
    return path.join(this.root, `app-${day}-${Date.now()}.jsonl`)
  }

  private async prune(): Promise<void> {
    const files = (await this.files()).sort((a, b) => b.time - a.time)
    for (const file of files.slice(this.maximumFiles)) await fs.promises.rm(file.path, { force: true })
  }

  private async files(): Promise<Array<{ path: string; size: number; time: number }>> {
    let names: string[]
    try { names = await fs.promises.readdir(this.root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result = []
    for (const name of names.filter((value) => /^app-.*\.jsonl$/.test(value))) {
      const filePath = path.join(this.root, name)
      const stat = await fs.promises.stat(filePath)
      result.push({ path: filePath, size: stat.size, time: stat.mtimeMs })
    }
    return result
  }
}

function safeToken(value: string): string { return value.replace(/[^a-z0-9_.-]/gi, '-').slice(0, 80) }

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') {
    return value
      .replace(/(?:Bearer\s+|sk-(?:api|proj)?-?|AIza)[A-Za-z0-9_.-]{8,}/gi, '[redacted]')
      .replace(/https?:\/\/([^/?#]+)[^\s]*/gi, 'https://$1/[redacted]')
      .replace(/[A-Z]:\\[^\s]+/gi, '[local-path]')
      .slice(0, 500)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (/key|secret|token|authorization|header|body|text|audio|content|path|url/i.test(key)) result[key] = '[redacted]'
      else result[key] = sanitize(item, depth + 1)
    }
    return result
  }
  return String(value).slice(0, 100)
}

async function statSize(filePath: string): Promise<number> {
  try { return (await fs.promises.stat(filePath)).size }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}
