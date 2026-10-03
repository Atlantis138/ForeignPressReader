import fs from 'node:fs'
import path from 'node:path'
import { app, session } from 'electron'
import type { StorageDatabase } from './database-ports'
import type { SpeechAudioCache } from './speech-audio-cache'
import type { CacheClearResult, StorageCategoryReport, StorageEntry, StorageReport } from '../shared/types'
import { appCachePath } from './app-cache'

const RESOURCE_TABLES = new Set(['publications', 'sections', 'articles', 'blocks'])
const CACHE_TABLES = new Set(['translations', 'context_definitions'])
const USER_TABLES = new Set([
  'settings', 'reading_positions', 'publication_lifecycle', 'user_lexemes', 'lexeme_examples', 'vocabulary_sources',
  'saved_contexts', 'study_plans', 'study_plan_sources', 'study_plan_lexeme_origins',
  'study_plan_exclusions', 'scheduler_profiles', 'review_cards', 'study_sessions',
  'study_session_batches', 'study_session_items', 'review_events', 'reinforcement_events',
  'review_suspensions', 'study_progress_state', 'study_lexeme_resets', 'sync_clock',
  'sync_entity_revisions', 'sync_peer_state', 'sync_receipts',
])

export class StorageService {
  constructor(
    private readonly database: StorageDatabase,
    private readonly userDataPath: string,
    private readonly speechCache: SpeechAudioCache,
    private readonly canClearTemporaryFiles: () => boolean,
  ) {}

  async scan(): Promise<StorageReport> {
    const [userTotal, installTotal, libraryBytes, dictionaryBytes, dictionaryBaseBytes, dictionaryFullBytes,
      dictionaryCacheBytes, speechBytes, networkCacheBytes, codeCacheBytes, graphicsCacheBytes,
      browserTemporaryBytes, tempBytes, contentsBytes] = await Promise.all([
      directoryBytes(this.userDataPath),
      app.isPackaged ? directoryBytes(path.dirname(process.execPath), this.userDataPath) : Promise.resolve(0),
      directoryBytes(path.join(this.userDataPath, 'library')),
      directoryBytes(path.join(this.userDataPath, 'dictionaries')),
      fileBytes(path.join(this.userDataPath,'dictionaries','ecdict-base.sqlite')),
      fileBytes(path.join(this.userDataPath,'dictionaries','ecdict-full.sqlite')),
      directoryBytes(appCachePath(this.userDataPath, 'dictionary')),
      this.speechCache.size(),
      directoryBytes(path.join(this.userDataPath, 'Cache')),
      directoryBytes(path.join(this.userDataPath, 'Code Cache')),
      sumPaths(this.userDataPath, ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']),
      directoryBytes(path.join(this.userDataPath, 'blob_storage')),
      sumPaths(this.userDataPath, ['imports', 'publication-packages', 'sync-outbox']),
      directoryBytes(appCachePath(this.userDataPath, 'contents-translations')),
    ])
    const pages = this.databaseStoragePages()
    const secretsBytes = await fileBytes(path.join(this.userDataPath, 'secrets.json'))
    const browserBytes = networkCacheBytes + codeCacheBytes + graphicsCacheBytes + browserTemporaryBytes
    const necessaryRuntime = Math.max(0, userTotal - libraryBytes - dictionaryBytes - dictionaryCacheBytes - speechBytes
      - browserBytes - tempBytes - contentsBytes - pages.resources - pages.cache - pages.user - secretsBytes)
    const necessaryEntries: StorageEntry[] = [
      { id: 'application', label: app.isPackaged ? '应用程序与运行组件' : '应用程序（开发环境不计源码与依赖）', bytes: installTotal, clearable: false },
      { id: 'runtime', label: '数据库运行开销与恢复文件', bytes: necessaryRuntime, clearable: false },
    ]
    const categories: StorageCategoryReport[] = [
      category('necessary', '必要文件', false, necessaryEntries),
      category('resources', '资源文件', false, [
        { id: 'library', label: '已导入刊物与解压资源', bytes: libraryBytes + pages.resources, clearable: false },
        { id: 'dictionary-base', label: 'ECDICT 标准学习包', bytes: dictionaryBaseBytes, clearable: false },
        { id: 'dictionary-full', label: 'ECDICT 完整定义扩展', bytes: dictionaryFullBytes, clearable: false },
        { id: 'dictionary-other', label: '词典安装临时文件', bytes: Math.max(0,dictionaryBytes-dictionaryBaseBytes-dictionaryFullBytes), clearable: false },
      ]),
      category('user-data', '用户数据', false, [
        { id: 'personal', label: '设置、阅读、生词与学习数据', bytes: pages.user, clearable: false },
        { id: 'secrets', label: '本机加密密钥', bytes: secretsBytes, clearable: false },
      ]),
      category('cache', '缓存', true, [
        { id: 'speech', label: 'Google / MiniMax 语音音频', bytes: speechBytes, clearable: true },
        { id: 'dictionary-online', label: '百度词典查询缓存', bytes: dictionaryCacheBytes, clearable: true },
        { id: 'ai-text', label: '目录、正文译文与 AI 文中义', bytes: pages.cache + contentsBytes, clearable: true },
        { id: 'browser-network', label: '网络响应缓存', bytes: networkCacheBytes, clearable: true },
        { id: 'browser-code', label: '网页代码缓存', bytes: codeCacheBytes, clearable: true },
        { id: 'browser-graphics', label: 'GPU 与图形缓存', bytes: graphicsCacheBytes, clearable: true },
        { id: 'browser-temporary', label: '浏览器临时对象', bytes: browserTemporaryBytes, clearable: true },
        { id: 'temporary', label: '临时文件', bytes: tempBytes, clearable: true },
      ]),
    ]
    return {
      scannedAt: new Date().toISOString(), packaged: app.isPackaged,
      totalBytes: installTotal + userTotal, categories,
    }
  }

  async clearSafeCache(): Promise<CacheClearResult> {
    const before = await this.scan()
    await Promise.all([
      this.speechCache.clear(),
      fs.promises.rm(appCachePath(this.userDataPath, 'dictionary'),{recursive:true,force:true}),
      session.defaultSession.clearCache(),
      session.defaultSession.clearCodeCaches({}),
      session.defaultSession.clearData({ dataTypes: ['cache'] }),
    ])
    if (this.canClearTemporaryFiles()) {
      await fs.promises.rm(path.join(this.userDataPath, 'imports'), { recursive: true, force: true })
      await fs.promises.mkdir(path.join(this.userDataPath, 'imports'), { recursive: true })
      await fs.promises.rm(path.join(this.userDataPath, 'library', '.staging'), { recursive: true, force: true })
    }
    const report = await this.scan()
    return { clearedBytes: Math.max(0, before.totalBytes - report.totalBytes), report }
  }

  async clearAiTextCache(confirmationToken: string): Promise<CacheClearResult> {
    if (confirmationToken !== 'CLEAR_AI_TEXT_CACHE') throw new Error('清理确认无效')
    const before = await this.scan()
    const db = this.database.getConnection()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM translations; DELETE FROM context_definitions; COMMIT;')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    await fs.promises.rm(appCachePath(this.userDataPath, 'contents-translations'), { recursive: true, force: true })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
    const report = await this.scan()
    return { clearedBytes: Math.max(0, before.totalBytes - report.totalBytes), report }
  }

  private databaseStoragePages(): { resources: number; user: number; cache: number } {
    const rows = this.database.getConnection().prepare(`
      SELECT COALESCE(m.tbl_name,d.name) AS table_name,SUM(d.pgsize) AS bytes
      FROM dbstat d LEFT JOIN sqlite_schema m ON m.name=d.name GROUP BY COALESCE(m.tbl_name,d.name)
    `).all() as Array<{ table_name: string; bytes: number }>
    const totals = { resources: 0, user: 0, cache: 0 }
    for (const row of rows) {
      if (RESOURCE_TABLES.has(row.table_name)) totals.resources += Number(row.bytes)
      else if (CACHE_TABLES.has(row.table_name)) totals.cache += Number(row.bytes)
      else if (USER_TABLES.has(row.table_name)) totals.user += Number(row.bytes)
    }
    return totals
  }
}

function category(id: StorageCategoryReport['id'], label: string, clearable: boolean, entries: StorageEntry[]): StorageCategoryReport {
  return { id, label, clearable, entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }
}

async function sumPaths(root: string, names: string[]): Promise<number> {
  const values = await Promise.all(names.map((name) => directoryBytes(path.join(root, name))))
  return values.reduce((sum, value) => sum + value, 0)
}

async function fileBytes(filePath: string): Promise<number> {
  try { return (await fs.promises.stat(filePath)).size }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}

async function directoryBytes(root: string, excludedRoot?: string): Promise<number> {
  let total = 0
  const excluded = excludedRoot ? path.resolve(excludedRoot).toLowerCase() : null
  const visit = async (directory: string): Promise<void> => {
    if (excluded && path.resolve(directory).toLowerCase() === excluded) return
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) }
    catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) return; throw error }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) total += await fileBytes(target)
    }
  }
  await visit(root)
  return total
}
