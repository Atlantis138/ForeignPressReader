import fs from 'node:fs'
import path from 'node:path'
import type { NetworkClient } from '../core/network-client'
import type { LibraryRepository } from '../core/ports'
import { CATALOG_API, CATALOG_TTL_MS, MAX_CATALOG_BYTES, isGitSha, isOnlineCatalog, localEconomistIssue, onlineIssueUrl, parseIssueTree } from '../core/online-catalog'
import type { OnlineCatalog } from '../shared/online-catalog'
import type { ImportProgress, ImportResult } from '../shared/types'
import type { LibraryService } from './library-service'
import { appCachePath } from './app-cache'

export class OnlineCatalogService {
  private pending: Promise<OnlineCatalog> | null = null
  private active: AbortController | null = null
  private readonly cacheFile: string
  private readonly downloads: string

  constructor(private readonly network: NetworkClient, private readonly library: LibraryService,
    private readonly database: LibraryRepository, userDataPath: string,
    private readonly progress: (value: ImportProgress) => void = () => undefined) {
    this.cacheFile = appCachePath(userDataPath, 'online-catalog', 'economist-v1.json')
    this.downloads = appCachePath(userDataPath, 'online-downloads')
    // Only disposable files owned by this service; never external EPUBs.
    try { fs.rmSync(this.downloads, { recursive: true, force: true }) }
    catch { /* A locked disposable file must not prevent the app from starting. */ }
  }

  getCatalog(refresh = false): Promise<OnlineCatalog> {
    if (this.pending) return this.pending
    this.pending = this.loadCatalog(refresh).finally(() => { this.pending = null })
    return this.pending
  }

  private readCache(): OnlineCatalog | null {
    try {
      if (fs.statSync(this.cacheFile).size > MAX_CATALOG_BYTES) return null
      const value: unknown = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      return isOnlineCatalog(value) ? value : null
    } catch { return null }
  }

  private async json(endpoint: string): Promise<unknown> {
    const response = await this.network.fetch(`${CATALOG_API}${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ForeignPressReader' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求较频繁，请稍后再刷新')
      throw new Error('无法读取 GitHub 期刊目录，请检查网络后重试')
    }
    return JSON.parse(new TextDecoder().decode(await limitedBody(response, MAX_CATALOG_BYTES)))
  }

  private async loadCatalog(refresh: boolean): Promise<OnlineCatalog> {
    const cached = this.readCache()
    const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity
    if (!refresh && cached && age >= 0 && age < CATALOG_TTL_MS) return cached
    try {
      const branch = await this.json('/branches/master') as { commit?: { sha?: string; commit?: { tree?: { sha?: string } } } }
      const revision = branch?.commit?.sha
      const treeSha = branch?.commit?.commit?.tree?.sha
      if (!isGitSha(revision) || !isGitSha(treeSha)) throw new Error('期刊来源结构已变化，请稍后重试')
      const root = await this.json(`/git/trees/${treeSha}`) as { truncated?: boolean; tree?: Array<{path:string;type:string;sha:string}> }
      const folder = root?.truncated === false && root.tree?.find(entry => entry.path === '01_economist' && entry.type === 'tree')
      if (!folder || !isGitSha(folder.sha)) throw new Error('来源未找到经济学人目录')
      const catalog: OnlineCatalog = { revision, fetchedAt: new Date().toISOString(), issues: parseIssueTree(await this.json(`/git/trees/${folder.sha}?recursive=1`)) }
      try {
        await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true })
        await fs.promises.writeFile(`${this.cacheFile}.partial`, JSON.stringify(catalog))
        await fs.promises.rename(`${this.cacheFile}.partial`, this.cacheFile)
      } catch { /* A cache write failure must not block browsing. */ }
      return catalog
    } catch (reason) {
      const notice = reason instanceof Error && /GitHub|期刊|来源/.test(reason.message) ? reason.message : '连接期刊来源失败，请检查网络后重试'
      if (cached) return { ...cached, stale: true, notice: `${notice}。当前显示上次保存的列表。` }
      throw new Error(notice)
    }
  }

  async importIssue(issueId: string): Promise<ImportResult | null> {
    if (!isGitSha(issueId)) throw new Error('期刊编号无效，请刷新列表')
    if (this.active) throw new Error('已有刊物正在下载')
    const controller = new AbortController()
    this.active = controller
    let temporary: string | null = null
    let cancelled = false
    try {
      const catalog = await this.getCatalog()
      controller.signal.throwIfAborted()
      const issue = catalog.issues.find(value => value.id === issueId)
      if (!issue) throw new Error('该期刊已不在当前列表，请刷新后重试')
      const local = localEconomistIssue(this.database.listPublications(), issue.date)
      if (local) return { publication: this.database.getPublication(local.id), duplicate: true }
      return await this.library.importPreparedFile(async signal => {
        controller.signal.throwIfAborted()
        signal.addEventListener('abort', () => { cancelled = true }, { once: true })
        await fs.promises.mkdir(this.downloads, { recursive: true })
        temporary = await fs.promises.mkdtemp(path.join(this.downloads, 'issue-'))
        const destination = path.join(temporary, 'source.epub')
        const space = await fs.promises.statfs(this.downloads)
        if (space.bavail * space.bsize < issue.bytes + 64 * 1024 * 1024) throw new Error('本机空间不足，无法下载期刊')
        this.progress({ stage: 'downloading', completed: 0, total: issue.bytes, message: `正在下载 ${issue.date}` })
        const response = await this.network.fetch(onlineIssueUrl(catalog.revision, issue), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'error',
        })
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new Error('期刊下载失败，请检查网络或刷新列表后重试')
        }
        const length = response.headers.get('content-length')
        if (length && Number(length) !== issue.bytes) { await response.body.cancel(); throw new Error('下载文件大小与目录不符，请刷新列表') }
        const file = await fs.promises.open(destination, 'wx')
        const reader = response.body.getReader()
        let completed = 0
        let reported = 0
        try {
          while (true) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            completed += value.byteLength
            if (completed > issue.bytes) throw new Error('下载文件超过预期大小')
            await file.writeFile(value)
            if (Date.now() - reported > 150 || completed === issue.bytes) {
              this.progress({ stage: 'downloading', completed, total: issue.bytes, message: `正在下载 ${issue.date}` })
              reported = Date.now()
            }
          }
          if (completed !== issue.bytes) throw new Error('下载未完成，请重试')
        } finally { await reader.cancel().catch(() => undefined); await file.close() }
        return destination
      })
    } catch (reason) {
      if (cancelled || controller.signal.aborted) return null
      if (reason instanceof Error && /下载|期刊|导入|EPUB|已有|空间/.test(reason.message)) throw reason
      throw new Error('下载失败或连接超时，请检查网络后重试')
    } finally {
      this.active = null
      if (temporary) await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  cancelImport(): void {
    this.active?.abort()
    this.library.cancelImport()
  }
}

async function limitedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('期刊来源返回了空响应')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) throw new Error('期刊目录超过大小限制')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  const data = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  return data
}
