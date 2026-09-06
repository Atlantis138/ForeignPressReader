import { validateReaderRecord, type ReaderRecord } from '../core/reader-records'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Entry, ZipFile } from 'yauzl'
import type {
  DataStatus,
  DataTransferProgress,
  PortableImportPreview,
  PortableTransferResult,
} from '../shared/types'
import type {
  PortableDatasetKey,
  PortableDatasetRecord,
  PortableMergeResult,
  PortablePublicationLifecycleRecord,
  PortableUserData,
} from '../core/portable-data'
import { CONTENT_ID_VERSION } from './epub-importer'
import { isSafePublicationId } from '../core/publication-package'
import type { PortableDataRepository } from './database-ports'
import type { LibraryService } from './library-service'
import { PublicationPackageService } from './publication-package-service'
import {
  isLibraryEntitySettingKey,
  isValidLibraryEntitySetting,
} from './library-sync-settings'

const FORMAT = 'foreign-press-reader-portable'
const FORMAT_VERSION = 4
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MERGE_BATCH_SIZE = 500

interface ManifestFile {
  path: string
  size: number
  sha256: string
  kind: 'reader-records' | 'publication-lifecycle' | 'settings' | 'reading-positions' | 'user-lexemes' | 'lexeme-examples' | 'vocabulary-sources' | 'saved-contexts' | 'study-plans' | 'study-plan-sources' | 'study-plan-origins' | 'study-plan-exclusions' | 'scheduler-profiles' | 'review-cards' | 'review-events' | 'reinforcement-events' | 'review-suspensions' | 'study-progress-state' | 'study-lexeme-resets' | 'publication-package'
}

interface PortableManifest {
  format: typeof FORMAT
  formatVersion: number
  appVersion: string
  databaseSchemaVersion: number
  contentIdVersion: number
  createdAt: string
  policy: 'essential-user-data'
  files: ManifestFile[]
  counts: {
    readerRecords?: number
    publications: number
    settings: number
    readingPositions: number
    vocabulary: number
    vocabularySources: number
    savedContexts: number
    studyPlans: number
    reviewCards: number
    reviewEvents: number
    reinforcementEvents: number
    reviewSuspensions: number
  }
}

interface PortableDatasetDescriptor {
  key: PortableDatasetKey
  path: string
  kind: Exclude<ManifestFile['kind'], 'publication-package'>
  settingsJson?: boolean
}

const PORTABLE_DATASETS: readonly PortableDatasetDescriptor[] = [
  { key: 'readerRecords', path: 'data/reader-records.ndjson', kind: 'reader-records' },
  { key: 'publicationLifecycle', path: 'data/publication-lifecycle.ndjson', kind: 'publication-lifecycle' },
  { key: 'settings', path: 'data/settings.json', kind: 'settings', settingsJson: true },
  { key: 'readingPositions', path: 'data/reading-positions.ndjson', kind: 'reading-positions' },
  { key: 'userLexemes', path: 'data/user-lexemes.ndjson', kind: 'user-lexemes' },
  { key: 'lexemeExamples', path: 'data/lexeme-examples.ndjson', kind: 'lexeme-examples' },
  { key: 'vocabularySources', path: 'data/vocabulary-sources.ndjson', kind: 'vocabulary-sources' },
  { key: 'savedContexts', path: 'data/saved-contexts.ndjson', kind: 'saved-contexts' },
  { key: 'studyPlans', path: 'data/study-plans.ndjson', kind: 'study-plans' },
  { key: 'studyPlanSources', path: 'data/study-plan-sources.ndjson', kind: 'study-plan-sources' },
  { key: 'studyPlanOrigins', path: 'data/study-plan-origins.ndjson', kind: 'study-plan-origins' },
  { key: 'studyPlanExclusions', path: 'data/study-plan-exclusions.ndjson', kind: 'study-plan-exclusions' },
  { key: 'schedulerProfiles', path: 'data/scheduler-profiles.ndjson', kind: 'scheduler-profiles' },
  { key: 'studyProgressState', path: 'data/study-progress-state.ndjson', kind: 'study-progress-state' },
  { key: 'studyLexemeResets', path: 'data/study-lexeme-resets.ndjson', kind: 'study-lexeme-resets' },
  { key: 'reviewCards', path: 'data/review-cards.ndjson', kind: 'review-cards' },
  { key: 'reviewEvents', path: 'data/review-events.ndjson', kind: 'review-events' },
  { key: 'reinforcementEvents', path: 'data/reinforcement-events.ndjson', kind: 'reinforcement-events' },
  { key: 'reviewSuspensions', path: 'data/review-suspensions.ndjson', kind: 'review-suspensions' },
]

const DATA_FILE_KINDS: Record<string, ManifestFile['kind']> = Object.fromEntries(
  PORTABLE_DATASETS.map((dataset) => [dataset.path, dataset.kind]),
)

interface StagedImport {
  root: string
  fileName: string
  manifest: PortableManifest
  books: Array<{
    path: string
    hash: string
    lifecycle: PortablePublicationLifecycleRecord | null
  }>
  summary: PortableScanSummary
  totalBytes: number
}

interface PortableScanSummary {
  counts: Record<PortableDatasetKey, number>
  lifecycleByHash: Map<string, PortablePublicationLifecycleRecord>
  lifecyclePublicationIds: Set<string>
  presentLifecycleHashes: Set<string>
  presentLifecycleCount: number
  activeVocabularyCount: number
  activeVocabularySourceCount: number
  activeSavedContextCount: number
  activeSuspensionCount: number
}

export class PortableDataService {
  private controller: AbortController | null = null
  private readonly staged = new Map<string, StagedImport>()
  private readonly importsRoot: string
  private readonly publicationPackages: PublicationPackageService

  get busy(): boolean { return this.controller !== null }

  constructor(
    private readonly database: PortableDataRepository,
    private readonly library: LibraryService,
    private readonly userDataPath: string,
    private readonly appVersion: string,
    private readonly emitProgress: (progress: DataTransferProgress) => void,
  ) {
    this.importsRoot = path.join(userDataPath, 'imports')
    fs.rmSync(this.importsRoot, { recursive: true, force: true })
    fs.mkdirSync(this.importsRoot, { recursive: true })
    this.publicationPackages = new PublicationPackageService(database, library, userDataPath)
  }

  getStatus(): DataStatus {
    const status = this.database.getSchemaStatus()
    return { ...status, formatVersion: FORMAT_VERSION }
  }

  async exportPortable(destination: string): Promise<PortableTransferResult> {
    this.beginOperation()
    const temporary = `${destination}.partial-${crypto.randomUUID()}`
    const packageRoot = path.join(this.importsRoot, `.export-${crypto.randomUUID()}`)
    try {
      await fs.promises.mkdir(packageRoot, { recursive: true })
      const logicalFiles: Array<{ manifest: ManifestFile; sourcePath: string; store?: boolean }> = []
      const datasetCounts = new Map<PortableDatasetKey, number>()
      const activeLifecycle = new Map<string, PortablePublicationLifecycleRecord>()
      let activeLifecycleCount = 0
      for (const dataset of PORTABLE_DATASETS) {
        this.throwIfCancelled()
        const filePath = path.join(packageRoot, ...dataset.path.split('/'))
        const written = await writePortableDataset(
          filePath,
          this.database.iteratePortableDataset(dataset.key),
          dataset.settingsJson === true,
          dataset.key === 'publicationLifecycle' ? (record) => {
            const lifecycle = record as PortablePublicationLifecycleRecord
            if (lifecycle.state === 'present') {
              activeLifecycleCount++
              activeLifecycle.set(lifecycle.contentHash, lifecycle)
            }
          } : undefined,
        )
        datasetCounts.set(dataset.key, written.count)
        logicalFiles.push({
          manifest: {
            path: dataset.path,
            size: written.size,
            sha256: written.sha256,
            kind: dataset.kind,
          },
          sourcePath: filePath,
        })
      }
      const books = this.database.listPortableBooks()
      if (activeLifecycleCount !== books.length || activeLifecycle.size !== books.length || books.some((book) => {
        const lifecycle = activeLifecycle.get(book.hash)
        return !lifecycle || lifecycle.publicationId !== book.publicationId || lifecycle.formatId !== book.formatId
      })) throw new Error('活动刊物与生命周期记录不一致，无法生成完整备份')
      for (const book of books) {
        this.throwIfCancelled()
        const created = await this.publicationPackages.createPackage(
          book,
          path.join(packageRoot, `${book.hash}.fprpub`),
        )
        logicalFiles.push({
          manifest: {
            path: `publications/${book.hash}.fprpub`,
            size: created.byteLength,
            sha256: created.payloadSha256,
            kind: 'publication-package',
          },
          sourcePath: created.path,
          store: true,
        })
      }
      const status = this.database.getSchemaStatus()
      const manifest: PortableManifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        appVersion: this.appVersion,
        databaseSchemaVersion: status.schemaVersion,
        contentIdVersion: CONTENT_ID_VERSION,
        createdAt: new Date().toISOString(),
        policy: 'essential-user-data',
        files: logicalFiles.map((file) => file.manifest),
        counts: {
          readerRecords: datasetCounts.get('readerRecords') ?? 0,
          publications: books.length,
          settings: datasetCounts.get('settings') ?? 0,
          readingPositions: datasetCounts.get('readingPositions') ?? 0,
          vocabulary: datasetCounts.get('userLexemes') ?? 0,
          vocabularySources: datasetCounts.get('vocabularySources') ?? 0,
          savedContexts: datasetCounts.get('savedContexts') ?? 0,
          studyPlans: datasetCounts.get('studyPlans') ?? 0,
          reviewCards: datasetCounts.get('reviewCards') ?? 0,
          reviewEvents: datasetCounts.get('reviewEvents') ?? 0,
          reinforcementEvents: datasetCounts.get('reinforcementEvents') ?? 0,
          reviewSuspensions: datasetCounts.get('reviewSuspensions') ?? 0,
        },
      }
      const totalBytes = logicalFiles.reduce((sum, file) => sum + file.manifest.size, 0)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) throw new Error('便携备份超过 20 GB 限制')
      this.emit('export', 'exporting', 0, totalBytes, '正在写入便携备份')
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await this.writeArchive(temporary, manifest, logicalFiles, totalBytes)
      const handle = await fs.promises.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await replacePortableBackup(temporary, destination)
      const bytes = (await fs.promises.stat(destination)).size
      this.emit('export', 'completed', totalBytes, totalBytes, '导出完成')
      return { fileName: path.basename(destination), bytes }
    } catch (error) {
      await fs.promises.rm(temporary, { force: true })
      this.emit('export', isAbort(error) ? 'cancelled' : 'error', 0, 0, messageOf(error))
      throw error
    } finally {
      await fs.promises.rm(packageRoot, { recursive: true, force: true })
      this.controller = null
    }
  }

  async inspectImport(sourcePath: string): Promise<PortableImportPreview> {
    this.beginOperation()
    const token = crypto.randomUUID()
    const root = path.join(this.importsRoot, token)
    fs.mkdirSync(root, { recursive: true })
    try {
      this.emit('import', 'validating', 0, 0, '正在验证备份包')
      const archiveSize = (await fs.promises.stat(sourcePath)).size
      if (archiveSize <= 0 || archiveSize > MAX_ARCHIVE_BYTES) throw new Error('备份包为空或超过 20 GB 限制')
      const extracted = await extractZip(sourcePath, root, () => this.throwIfCancelled())
      const manifestPath = path.join(root, 'manifest.json')
      if ((await fs.promises.stat(manifestPath)).size > MAX_MANIFEST_BYTES) throw new Error('备份清单超过 1 MiB 限制')
      const manifest = parseManifest(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')))
      const currentSchemaVersion = this.database.getSchemaStatus().schemaVersion
      const compatibleSchema = manifest.databaseSchemaVersion === currentSchemaVersion
        || (manifest.formatVersion === 2 && manifest.databaseSchemaVersion === 2 && currentSchemaVersion >= 3)
        || (manifest.formatVersion === 3 && manifest.databaseSchemaVersion === 3 && currentSchemaVersion >= 4)
      if (!compatibleSchema) {
        throw new Error('备份数据库结构版本与当前应用不兼容')
      }
      await validateExtractedFiles(root, extracted, manifest)
      const summary = await scanPortableData(root)
      validateManifestCounts(manifest, summary)
      const bookFiles = manifest.files.filter((file) => file.kind === 'publication-package')
      const packageHashes = new Set(bookFiles.map((file) => path.basename(file.path, '.fprpub')))
      if (manifest.counts.publications !== bookFiles.length
        || summary.lifecycleByHash.size !== summary.counts.publicationLifecycle
        || summary.lifecyclePublicationIds.size !== summary.counts.publicationLifecycle
        || summary.presentLifecycleHashes.size !== summary.presentLifecycleCount
        || packageHashes.size !== bookFiles.length || packageHashes.size !== summary.presentLifecycleHashes.size
        || [...packageHashes].some((hash) => !summary.presentLifecycleHashes.has(hash))) {
        throw new Error('备份中的活动刊物与解析内容包不一致')
      }
      const books: StagedImport['books'] = []
      for (const file of bookFiles) {
        const hash = path.basename(file.path, '.fprpub')
        const lifecycle = summary.lifecycleByHash.get(hash) ?? null
        if (!lifecycle || lifecycle.state !== 'present') throw new Error('刊物包缺少活动生命周期记录')
        const current = this.database.getPublicationLifecycleByHash(hash)
        if (current?.state === 'deleted' && !this.database.shouldAcceptPublicationLifecycle(lifecycle)) continue
        const bookPath = path.join(root, ...file.path.split('/'))
        const inspected = await this.publicationPackages.validatePackage(bookPath)
        if (inspected.manifest.sourceContentSha256 !== hash) throw new Error('刊物包文件名与内容身份不一致')
        if (inspected.manifest.publicationId !== lifecycle.publicationId
          || inspected.manifest.sourceFormat !== lifecycle.formatId) {
          throw new Error('刊物包与生命周期记录身份不一致')
        }
        books.push({
          path: bookPath,
          hash,
          lifecycle,
        })
      }
      const newCount = books.filter((book) => !this.database.findPublicationIdByHash(book.hash)).length
      const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
      const staged: StagedImport = {
        root,
        fileName: path.basename(sourcePath),
        manifest,
        books,
        summary,
        totalBytes,
      }
      this.staged.set(token, staged)
      this.controller = null
      return {
        token,
        fileName: staged.fileName,
        totalBytes,
        publicationCount: books.length,
        newPublicationCount: newCount,
        duplicatePublicationCount: books.length - newCount,
        settingCount: summary.counts.settings,
        readerRecordCount: summary.counts.readerRecords ?? 0,
        readingPositionCount: summary.counts.readingPositions,
        vocabularyCount: summary.activeVocabularyCount,
        vocabularySourceCount: summary.activeVocabularySourceCount,
        savedContextCount: summary.activeSavedContextCount,
        studyPlanCount: summary.counts.studyPlans,
        reviewCardCount: summary.counts.reviewCards,
        reviewEventCount: summary.counts.reviewEvents,
        reinforcementEventCount: summary.counts.reinforcementEvents,
        suspendedWordCount: summary.activeSuspensionCount,
        createdAt: manifest.createdAt,
      }
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true })
      this.controller = null
      this.emit('import', isAbort(error) ? 'cancelled' : 'error', 0, 0, messageOf(error))
      throw error
    }
  }

  async confirmImport(token: string): Promise<PortableTransferResult> {
    const staged = this.staged.get(token)
    if (!staged) throw new Error('导入预览已失效，请重新选择备份包')
    this.beginOperation()
    let imported = 0
    let duplicate = 0
    const createdPublicationIds: string[] = []
    let mergeStarted = false
    let mergeCommitted = false
    try {
      await this.database.createSafetyBackup('before-portable-import')
      for (let index = 0; index < staged.books.length; index++) {
        this.throwIfCancelled()
        this.emit('import', 'importing-books', index, staged.books.length, '正在恢复刊物内容')
        const book = staged.books[index]
        if (!book.lifecycle) throw new Error('刊物包缺少活动生命周期记录')
        const result = await this.publicationPackages.importPackage(book.path, {
          publicationId: book.lifecycle.publicationId,
          sourceFormat: book.lifecycle.formatId,
          sourceContentSha256: book.hash,
        })
        if (result.duplicate) duplicate++
        else {
          imported++
          createdPublicationIds.push(result.publication.id)
          if (book.lifecycle) this.database.clearPublicationLifecycleForRestore(result.publication.id)
        }
      }
      this.throwIfCancelled()
      this.emit('import', 'merging-data', staged.books.length, staged.books.length, '正在合并用户数据')
      this.database.beginPortableMerge()
      mergeStarted = true
      const { merged, deletedPublicationIds } = await this.mergePortableFiles(
        staged.root,
        staged.manifest.formatVersion >= 3 ? 'fine-grained' : 'legacy',
      )
      this.database.commitPortableMerge()
      mergeStarted = false
      mergeCommitted = true
      for (const publicationId of deletedPublicationIds) {
        if (this.database.getPublicationLifecycle(publicationId)?.state === 'deleted') {
          // Once committed, leftover files are cleanup work, not a failed import.
          await fs.promises.rm(path.join(this.userDataPath, 'library', publicationId), { recursive: true, force: true }).catch(() => undefined)
        }
      }
      this.emit('import', 'completed', staged.totalBytes, staged.totalBytes, '导入完成')
      return {
        fileName: staged.fileName,
        bytes: staged.totalBytes,
        importedPublications: imported,
        duplicatePublications: duplicate,
        mergedSettings: merged.settings,
        mergedReadingPositions: merged.readingPositions,
        mergedVocabulary: merged.vocabulary,
        mergedVocabularySources: merged.vocabularySources,
        mergedSavedContexts: merged.savedContexts,
        mergedStudyPlans: merged.studyPlans,
        mergedReviewCards: merged.reviewCards,
        mergedReviewEvents: merged.reviewEvents,
        mergedReinforcementEvents: merged.reinforcementEvents,
        mergedReviewSuspensions: merged.reviewSuspensions,
      }
    } catch (error) {
      if (mergeStarted) {
        try { this.database.rollbackPortableMerge() } catch { /* preserve the original failure */ }
      }
      for (const publicationId of mergeCommitted ? [] : createdPublicationIds.reverse()) {
        await this.library.purgeImportedPublication(publicationId).catch(() => undefined)
      }
      this.emit('import', isAbort(error) ? 'cancelled' : 'error', 0, staged.totalBytes, messageOf(error))
      throw error
    } finally {
      this.controller = null
      this.staged.delete(token)
      try { fs.rmSync(staged.root, { recursive: true, force: true }) } catch { /* A stale staging directory must not undo a committed import. */ }
    }
  }

  cancel(): void {
    if (this.controller) this.controller.abort()
    else {
      for (const staged of this.staged.values()) fs.rmSync(staged.root, { recursive: true, force: true })
      this.staged.clear()
    }
  }

  close(): void {
    this.cancel()
    fs.rmSync(this.importsRoot, { recursive: true, force: true })
  }

  private beginOperation(): void {
    if (this.controller) throw new Error('已有数据任务正在进行')
    this.controller = new AbortController()
  }

  private throwIfCancelled(): void {
    if (this.controller?.signal.aborted) throw new DOMException('操作已取消', 'AbortError')
  }

  private emit(
    operation: 'export' | 'import', stage: DataTransferProgress['stage'],
    completedBytes: number, totalBytes: number, message: string,
  ): void {
    this.emitProgress({ operation, stage, completedBytes, totalBytes, message })
  }

  private async mergePortableFiles(root: string, librarySyncMode: 'legacy' | 'fine-grained'): Promise<{
    merged: PortableMergeResult
    deletedPublicationIds: Set<string>
  }> {
    const merged = emptyMergeResult()
    const deletedPublicationIds = new Set<string>()
    for (const dataset of PORTABLE_DATASETS) {
      let batch: PortableDatasetRecord[] = []
      const flush = () => {
        if (batch.length === 0) return
        addMergeResult(merged, this.database.mergePortableUserData(
          portableDataChunk(dataset.key, batch),
          'newer-wins',
          false,
          false,
          librarySyncMode,
        ))
        batch = []
      }
      for await (const record of iteratePortableDatasetFile(root, dataset)) {
        this.throwIfCancelled()
        if (dataset.key === 'publicationLifecycle') {
          const lifecycle = record as PortablePublicationLifecycleRecord
          if (lifecycle.state === 'deleted') deletedPublicationIds.add(lifecycle.publicationId)
        }
        batch.push(record)
        if (batch.length >= MERGE_BATCH_SIZE) flush()
      }
      flush()
    }
    addMergeResult(merged, this.database.mergePortableUserData(
      emptyPortableData(),
      'newer-wins',
      false,
      true,
      librarySyncMode,
    ))
    return { merged, deletedPublicationIds }
  }

  private async writeArchive(
    destination: string,
    manifest: PortableManifest,
    files: Array<{ manifest: ManifestFile; sourcePath: string; store?: boolean }>,
    totalBytes: number,
  ): Promise<void> {
    const { default: archiver } = await import('archiver')
    const output = fs.createWriteStream(destination, { flags: 'wx' })
    const archive = archiver('zip', { zlib: { level: 6 } })
    const completion = new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
      archive.on('error', reject)
    })
    const cancel = () => {
      archive.abort()
      output.destroy(new DOMException('操作已取消', 'AbortError'))
    }
    this.controller?.signal.addEventListener('abort', cancel, { once: true })
    archive.on('progress', (progress) => {
      this.emit('export', 'exporting', progress.fs.processedBytes, totalBytes, '正在写入便携备份')
    })
    archive.pipe(output)
    try {
      archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' })
      for (const file of files) {
        archive.append(fs.createReadStream(file.sourcePath), {
          name: file.manifest.path,
          ...(file.store ? { store: true } : {}),
        })
      }
      await archive.finalize()
      await completion
    } finally {
      this.controller?.signal.removeEventListener('abort', cancel)
    }
  }
}

async function writePortableDataset(
  filePath: string,
  records: Iterable<PortableDatasetRecord>,
  settingsJson: boolean,
  onRecord?: (record: PortableDatasetRecord) => void,
): Promise<{ count: number; size: number; sha256: string }> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  const output = await fs.promises.open(filePath, 'wx', 0o600)
  const digest = crypto.createHash('sha256')
  let count = 0
  let size = 0
  const write = async (value: string) => {
    const bytes = Buffer.from(value, 'utf8')
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await output.write(bytes, offset, bytes.byteLength - offset)
      if (result.bytesWritten <= 0) throw new Error('无法写入便携备份数据')
      offset += result.bytesWritten
    }
    digest.update(bytes)
    size += bytes.byteLength
  }
  try {
    if (settingsJson) await write('[')
    for (const record of records) {
      const encoded = JSON.stringify(record)
      if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) throw new Error('便携备份单条记录超过 1 MiB 限制')
      if (settingsJson) await write(`${count ? ',' : ''}${encoded}`)
      else await write(`${encoded}\n`)
      count++
      onRecord?.(record)
    }
    if (settingsJson) await write(']')
    if (settingsJson && size > MAX_SETTINGS_BYTES) throw new Error('便携备份设置文件超过 16 MiB 限制')
    await output.sync()
    return { count, size, sha256: digest.digest('hex') }
  } catch (error) {
    await output.close().catch(() => undefined)
    await fs.promises.rm(filePath, { force: true })
    throw error
  } finally {
    await output.close().catch(() => undefined)
  }
}

export async function replacePortableBackup(
  temporary: string,
  destination: string,
  rename: (source: string, target: string) => Promise<void> = fs.promises.rename,
): Promise<void> {
  await rename(temporary, destination)
}

const PORTABLE_RECORD_FIELDS = {
  readerRecords: ['recordId','publicationId','articleId','kind','payload','updatedAt','deviceId'],
  publicationLifecycle: ['publicationId', 'contentHash', 'formatId', 'titleSnapshot', 'state', 'changedAt', 'deviceId'],
  settings: ['key', 'value', 'updatedAt', 'deviceId'],
  readingPositions: ['publicationId', 'articleId', 'scrollTop', 'anchorBlockId', 'anchorTokenIndex', 'anchorFraction', 'updatedAt', 'deviceId'],
  userLexemes: ['lexemeKey', 'lemmaSnapshot', 'phoneticSnapshot', 'briefMeaningsJson', 'senseGroupsJson', 'bncRank', 'frequencyRank', 'manualState', 'manualFamiliarity', 'createdAt', 'updatedAt', 'deviceId', 'snapshotProvider', 'snapshotQuality'],
  lexemeExamples: ['exampleId', 'lexemeKey', 'text', 'translationZh', 'partOfSpeech', 'definition', 'providerId', 'position', 'createdAt', 'updatedAt', 'deviceId'],
  vocabularySources: ['sourceId', 'lexemeKey', 'sourceType', 'sourceRef', 'active', 'addedAt', 'removedAt', 'updatedAt', 'deviceId'],
  savedContexts: ['contextId', 'lexemeKey', 'surface', 'publicationId', 'publicationTitle', 'articleId', 'articleTitle', 'blockId', 'tokenIndex', 'sentence', 'paragraph', 'sentenceHash', 'active', 'savedAt', 'removedAt', 'updatedAt', 'deviceId'],
  studyPlans: ['planId', 'name', 'status', 'dailyNewLimit', 'dailyReviewLimit', 'newOrder', 'createdAt', 'updatedAt', 'deviceId', 'deletedAt'],
  studyPlanSources: ['sourceId', 'planId', 'sourceType', 'sourceRef', 'active', 'addedAt', 'removedAt', 'updatedAt', 'deviceId'],
  studyPlanOrigins: ['originId', 'planId', 'planSourceId', 'lexemeKey', 'active', 'discoveredAt', 'removedAt', 'updatedAt', 'deviceId'],
  studyPlanExclusions: ['planId', 'lexemeKey', 'excluded', 'excludedAt', 'restoredAt', 'updatedAt', 'deviceId'],
  schedulerProfiles: ['profileId', 'fsrsVersion', 'parametersJson', 'parametersHash', 'createdAt'],
  studyProgressState: ['stateId', 'resetAt', 'updatedAt', 'deviceId'],
  studyLexemeResets: ['lexemeKey', 'resetAt', 'updatedAt', 'deviceId'],
  reviewCards: ['lexemeKey', 'dueAt', 'stability', 'difficulty', 'elapsedDays', 'scheduledDays', 'learningSteps', 'reps', 'lapses', 'state', 'lastReviewAt', 'updatedAt', 'deviceId'],
  reviewEvents: ['eventId', 'commandId', 'lexemeKey', 'planId', 'answer', 'rating', 'profileId', 'preCardJson', 'postCardJson', 'logJson', 'reviewedAt', 'deviceId'],
  reinforcementEvents: ['eventId', 'commandId', 'lexemeKey', 'planId', 'answer', 'consecutiveBefore', 'consecutiveAfter', 'createdAt', 'deviceId'],
  reviewSuspensions: ['lexemeKey', 'active', 'reason', 'suspendedAt', 'restoredAt', 'updatedAt', 'deviceId'],
} as const satisfies Record<PortableDatasetKey, readonly string[]>

const BOOLEAN_FIELDS = new Set(['active', 'excluded'])
const NUMBER_FIELDS = new Set([
  'scrollTop', 'anchorTokenIndex', 'anchorFraction', 'bncRank', 'frequencyRank', 'manualFamiliarity',
  'snapshotQuality', 'position', 'tokenIndex', 'dailyNewLimit', 'dailyReviewLimit', 'stability',
  'difficulty', 'elapsedDays', 'scheduledDays', 'learningSteps', 'reps', 'lapses', 'rating',
  'consecutiveBefore', 'consecutiveAfter',
])
const NULLABLE_FIELDS: Partial<Record<PortableDatasetKey, ReadonlySet<string>>> = {
  readingPositions: new Set(['anchorBlockId', 'anchorTokenIndex', 'anchorFraction']),
  userLexemes: new Set(['phoneticSnapshot', 'bncRank', 'frequencyRank', 'manualFamiliarity']),
  lexemeExamples: new Set(['translationZh', 'partOfSpeech', 'definition']),
  vocabularySources: new Set(['removedAt']),
  savedContexts: new Set(['publicationId', 'articleId', 'blockId', 'removedAt']),
  studyPlans: new Set(['deletedAt']),
  studyPlanSources: new Set(['removedAt']),
  studyPlanOrigins: new Set(['removedAt']),
  studyPlanExclusions: new Set(['excludedAt', 'restoredAt']),
  studyProgressState: new Set(['resetAt']),
  reviewCards: new Set(['lastReviewAt']),
  reviewEvents: new Set(['planId']),
  reinforcementEvents: new Set(['planId']),
  reviewSuspensions: new Set(['restoredAt']),
}
const ALLOWED_SETTINGS = new Set([
  'reader.preferences', 'dictionary.preferences', 'study.preferences', 'speech.preferences',
  'translation.preferences', 'library.management',
])
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

async function scanPortableData(root: string): Promise<PortableScanSummary> {
  const counts = Object.fromEntries(PORTABLE_DATASETS.map((dataset) => [dataset.key, 0])) as Record<PortableDatasetKey, number>
  const lifecycleByHash = new Map<string, PortablePublicationLifecycleRecord>()
  const lifecyclePublicationIds = new Set<string>()
  const presentLifecycleHashes = new Set<string>()
  const activeVocabulary = new Set<string>()
  let presentLifecycleCount = 0
  let activeVocabularySourceCount = 0
  let activeSavedContextCount = 0
  let activeSuspensionCount = 0
  for (const dataset of PORTABLE_DATASETS) {
    for await (const record of iteratePortableDatasetFile(root, dataset)) {
      counts[dataset.key]++
      const value = record as unknown as Record<string, unknown>
      if (dataset.key === 'publicationLifecycle') {
        const lifecycle = record as PortablePublicationLifecycleRecord
        if (lifecycleByHash.has(lifecycle.contentHash) || lifecyclePublicationIds.has(lifecycle.publicationId)) {
          throw new Error('备份包含重复的刊物生命周期记录')
        }
        lifecycleByHash.set(lifecycle.contentHash, lifecycle)
        lifecyclePublicationIds.add(lifecycle.publicationId)
        if (lifecycle.state === 'present') {
          presentLifecycleCount++
          presentLifecycleHashes.add(lifecycle.contentHash)
        }
      } else if (dataset.key === 'vocabularySources' && value.active === true) {
        activeVocabularySourceCount++
        if (value.sourceType === 'reader_manual' && typeof value.lexemeKey === 'string') activeVocabulary.add(value.lexemeKey)
      } else if (dataset.key === 'savedContexts' && value.active === true) {
        activeSavedContextCount++
      } else if (dataset.key === 'reviewSuspensions' && value.active === true) {
        activeSuspensionCount++
      }
    }
  }
  return {
    counts,
    lifecycleByHash,
    lifecyclePublicationIds,
    presentLifecycleHashes,
    presentLifecycleCount,
    activeVocabularyCount: activeVocabulary.size,
    activeVocabularySourceCount,
    activeSavedContextCount,
    activeSuspensionCount,
  }
}

async function* iteratePortableDatasetFile(
  root: string,
  dataset: PortableDatasetDescriptor,
): AsyncGenerator<PortableDatasetRecord> {
  const filePath = path.join(root, ...dataset.path.split('/'))
  if (dataset.key === 'readerRecords' && !fs.existsSync(filePath)) return
  if (dataset.settingsJson) {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_SETTINGS_BYTES) throw new Error('备份设置文件超过 16 MiB 限制')
    const values = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown
    if (!Array.isArray(values)) throw new Error('备份设置文件结构无效')
    for (const value of values) {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RECORD_BYTES) throw new Error('便携备份单条记录超过 1 MiB 限制')
      yield validatePortableRecord(dataset.key, value)
    }
    return
  }

  const parts: Buffer[] = []
  let lineBytes = 0
  const takeLine = (): PortableDatasetRecord | null => {
    if (lineBytes === 0) return null
    let bytes = Buffer.concat(parts, lineBytes)
    parts.length = 0
    lineBytes = 0
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1)
    if (bytes.length === 0) return null
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`便携备份记录 JSON 无效：${dataset.path}`) }
    return validatePortableRecord(dataset.key, value)
  }
  for await (const rawChunk of fs.createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const slice = chunk.subarray(offset, end)
      if (lineBytes + slice.length > MAX_RECORD_BYTES) throw new Error('便携备份单条记录超过 1 MiB 限制')
      if (slice.length) { parts.push(slice); lineBytes += slice.length }
      if (newline < 0) break
      const record = takeLine()
      if (record) yield record
      offset = newline + 1
    }
  }
  const finalRecord = takeLine()
  if (finalRecord) yield finalRecord
}

function validatePortableRecord(dataset: PortableDatasetKey, value: unknown): PortableDatasetRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('便携备份记录必须是对象')
  const record = value as Record<string, unknown>
  const fields = PORTABLE_RECORD_FIELDS[dataset]
  const keys = Object.keys(record)
  if (keys.length !== fields.length || keys.some((key) => !(fields as readonly string[]).includes(key))) {
    throw new Error(`便携备份记录字段无效：${dataset}`)
  }
  for (const field of fields) {
    const item = record[field]
    if (item === null) {
      if (!NULLABLE_FIELDS[dataset]?.has(field)) throw new Error(`便携备份记录字段不能为空：${field}`)
      continue
    }
    if (BOOLEAN_FIELDS.has(field)) {
      if (typeof item !== 'boolean') throw new Error(`便携备份布尔字段无效：${field}`)
    } else if (NUMBER_FIELDS.has(field) || (dataset === 'reviewCards' && field === 'state')) {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`便携备份数值字段无效：${field}`)
    } else if (typeof item !== 'string') {
      throw new Error(`便携备份文本字段无效：${field}`)
    }
    if (field.endsWith('At') && typeof item === 'string'
      && (!RFC3339.test(item) || !Number.isFinite(Date.parse(item)))) {
      throw new Error(`便携备份时间字段无效：${field}`)
    }
  }
  if (dataset === 'readerRecords') validateReaderRecord(record as unknown as ReaderRecord)
  if (dataset === 'settings') {
    const key = String(record.key)
    if (!ALLOWED_SETTINGS.has(key) && !isLibraryEntitySettingKey(key)) throw new Error('便携备份包含不允许的设置')
    let settingValue: unknown
    try { settingValue = JSON.parse(String(record.value)) } catch { throw new Error('便携备份设置值不是有效 JSON') }
    if (isLibraryEntitySettingKey(key) && !isValidLibraryEntitySetting(key, settingValue)) {
      throw new Error('便携备份书库同步记录无效')
    }
  }
  if (dataset === 'publicationLifecycle') {
    if (!isSafePublicationId(record.publicationId)
      || !/^[a-f0-9]{64}$/.test(String(record.contentHash))
      || !['present', 'deleted'].includes(String(record.state))) {
      throw new Error('刊物生命周期记录无效')
    }
  }
  return record as unknown as PortableDatasetRecord
}

function validateManifestCounts(manifest: PortableManifest, summary: PortableScanSummary): void {
  const expected: Array<[keyof PortableManifest['counts'], PortableDatasetKey]> = [
    ['settings', 'settings'], ['readingPositions', 'readingPositions'], ['vocabulary', 'userLexemes'],
    ['vocabularySources', 'vocabularySources'], ['savedContexts', 'savedContexts'], ['studyPlans', 'studyPlans'],
    ['reviewCards', 'reviewCards'], ['reviewEvents', 'reviewEvents'],
    ['reinforcementEvents', 'reinforcementEvents'], ['reviewSuspensions', 'reviewSuspensions'],
  ]
  if (manifest.formatVersion >= 4) expected.push(['readerRecords', 'readerRecords'])
  for (const [manifestKey, datasetKey] of expected) {
    if (manifest.counts[manifestKey] !== summary.counts[datasetKey]) throw new Error(`备份记录数与清单不一致：${datasetKey}`)
  }
}

function emptyPortableData(): PortableUserData {
  return {
    readerRecords: [], publicationLifecycle: [], settings: [], readingPositions: [], userLexemes: [], lexemeExamples: [],
    vocabularySources: [], savedContexts: [], studyPlans: [], studyPlanSources: [], studyPlanOrigins: [],
    studyPlanExclusions: [], schedulerProfiles: [], studyProgressState: [], studyLexemeResets: [],
    reviewCards: [], reviewEvents: [], reinforcementEvents: [], reviewSuspensions: [],
  }
}

function portableDataChunk(key: PortableDatasetKey, records: PortableDatasetRecord[]): PortableUserData {
  const data = emptyPortableData()
  ;(data as unknown as Record<PortableDatasetKey, PortableDatasetRecord[]>)[key] = records
  return data
}

function emptyMergeResult(): PortableMergeResult {
  return {
    publicationLifecycle: 0, settings: 0, readingPositions: 0, vocabulary: 0,
    vocabularySources: 0, savedContexts: 0, studyPlans: 0, reviewCards: 0, reviewEvents: 0,
    reinforcementEvents: 0, reviewSuspensions: 0, studyLexemeResets: 0,
  }
}

function addMergeResult(target: PortableMergeResult, source: PortableMergeResult): void {
  target.publicationLifecycle += source.publicationLifecycle
  target.settings += source.settings
  target.readingPositions += source.readingPositions
  target.vocabulary += source.vocabulary
  target.vocabularySources += source.vocabularySources
  target.savedContexts += source.savedContexts
  target.studyPlans += source.studyPlans
  target.reviewCards += source.reviewCards
  target.reviewEvents += source.reviewEvents
  target.reinforcementEvents += source.reinforcementEvents
  target.reviewSuspensions += source.reviewSuspensions
  target.studyLexemeResets += source.studyLexemeResets
}

async function hashFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    hash.update(buffer)
  }
  return { sha256: hash.digest('hex'), size }
}

async function extractZip(sourcePath: string, root: string, checkCancelled: () => void): Promise<string[]> {
  const zip = await openZip(sourcePath)
  const extracted: string[] = []
  const seen = new Set<string>()
  let count = 0
  let total = 0
  try {
    while (true) {
      checkCancelled()
      const entry = await nextEntry(zip)
      if (!entry) break
      count++
      if (count > MAX_ENTRIES) throw new Error('备份包文件数量异常')
      const entryPath = normalizeEntryPath(entry.fileName)
      if (entryPath.endsWith('/')) continue
      if (seen.has(entryPath)) throw new Error('备份包包含重复文件路径')
      seen.add(entryPath)
      total += entry.uncompressedSize
      if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_BYTES) throw new Error('备份包解压后超过 20 GB 限制')
      if (entry.uncompressedSize > 0
        && (entry.compressedSize === 0 || entry.uncompressedSize > entry.compressedSize * 2_000)) {
        throw new Error('备份包压缩比例异常')
      }
      if (entryPath === 'manifest.json' && entry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('备份清单超过 1 MiB 限制')
      if (entryPath === 'data/settings.json' && entry.uncompressedSize > MAX_SETTINGS_BYTES) throw new Error('备份设置文件超过 16 MiB 限制')
      if (!isAllowedEntry(entryPath)) throw new Error(`备份包包含未知文件：${entryPath}`)
      const destination = path.join(root, ...entryPath.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const input = await openEntryStream(zip, entry)
      await pipeline(input, fs.createWriteStream(destination, { flags: 'wx' }))
      extracted.push(entryPath)
    }
  } finally {
    zip.close()
  }
  return extracted
}

async function openZip(filePath: string): Promise<ZipFile> {
  const { default: yauzl } = await import('yauzl')
  return new Promise((resolve, reject) => yauzl.open(filePath, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error('无法打开备份包'))
    else resolve(zip)
  }))
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry) }
    const onEnd = () => { cleanup(); resolve(null) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => {
      zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError)
    }
    zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError); zip.readEntry()
  })
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) reject(error ?? new Error('无法读取备份条目'))
    else resolve(stream)
  }))
}

function normalizeEntryPath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const directory = normalized.endsWith('/')
  const trimmed = directory ? normalized.slice(0, -1) : normalized
  if (!trimmed || trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)
    || trimmed.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('备份包包含越界路径')
  }
  return directory ? `${trimmed}/` : trimmed
}

function isAllowedEntry(value: string): boolean {
  return value === 'manifest.json'
    || Object.hasOwn(DATA_FILE_KINDS, value)
    || /^publications\/[a-f0-9]{64}\.fprpub$/.test(value)
}

function parseManifest(value: unknown): PortableManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份清单格式无效')
  const manifest = value as PortableManifest
  if (manifest.format !== FORMAT || manifest.policy !== 'essential-user-data') throw new Error('不是外刊阅读器便携备份')
  if (manifest.formatVersion > FORMAT_VERSION) throw new Error('备份格式来自更高版本，请先升级应用')
  const supportedFormat = [2, 3, FORMAT_VERSION].includes(manifest.formatVersion)
  const supportedSchema = manifest.databaseSchemaVersion === manifest.formatVersion
  if (!supportedFormat || !supportedSchema || manifest.contentIdVersion !== CONTENT_ID_VERSION) {
    throw new Error('备份格式或内容ID版本不受支持')
  }
  if (!Number.isSafeInteger(manifest.databaseSchemaVersion) || manifest.databaseSchemaVersion < 1
    || typeof manifest.appVersion !== 'string' || manifest.appVersion.length < 1 || manifest.appVersion.length > 100
    || typeof manifest.createdAt !== 'string' || !RFC3339.test(manifest.createdAt) || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('备份清单版本或时间字段无效')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < PORTABLE_DATASETS.length - (manifest.formatVersion < 4 ? 1 : 0)
    || manifest.files.length > MAX_ENTRIES - 1 || !manifest.counts || typeof manifest.counts !== 'object') {
    throw new Error('备份清单缺少文件列表或记录数')
  }
  const countKeys: Array<keyof PortableManifest['counts']> = [
    'publications', 'settings', 'readingPositions', 'vocabulary', 'vocabularySources', 'savedContexts',
    'studyPlans', 'reviewCards', 'reviewEvents', 'reinforcementEvents', 'reviewSuspensions',
  ]
  if (manifest.formatVersion >= 4) countKeys.push('readerRecords')
  if (Object.keys(manifest.counts).length !== countKeys.length
    || countKeys.some((key) => !Number.isSafeInteger(manifest.counts[key]) || (manifest.counts[key] ?? -1) < 0)) {
    throw new Error('备份清单记录数无效')
  }
  return manifest
}

async function validateExtractedFiles(root: string, extracted: string[], manifest: PortableManifest): Promise<void> {
  const expected = new Set(['manifest.json', ...manifest.files.map((file) => file.path)])
  if (expected.size !== manifest.files.length + 1
    || expected.size !== extracted.length || extracted.some((file) => !expected.has(file))) {
    throw new Error('备份包文件与清单不一致')
  }
  let total = 0
  for (const file of manifest.files) {
    if (!isAllowedEntry(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('备份清单包含无效文件记录')
    }
    if (file.kind === 'publication-package' && !/^publications\/[a-f0-9]{64}\.fprpub$/.test(file.path)) {
      throw new Error('备份清单中的刊物文件类型无效')
    }
    if (file.kind !== 'publication-package' && DATA_FILE_KINDS[file.path] !== file.kind) {
      throw new Error('备份清单中的数据文件类型无效')
    }
    const target = path.join(root, ...file.path.split('/'))
    const stat = fs.statSync(target)
    const actual = await hashFile(target)
    if (stat.size !== file.size || actual.sha256 !== file.sha256) {
      throw new Error(`备份文件校验失败：${file.path}`)
    }
    total += file.size
    if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_BYTES) throw new Error('备份清单数据总量超过 20 GB 限制')
  }
  for (const dataset of PORTABLE_DATASETS) {
    if (dataset.key === 'readerRecords' && manifest.formatVersion < 4) continue
    if (!manifest.files.some((file) => file.path === dataset.path && file.kind === dataset.kind)) {
      throw new Error(`备份缺少必要数据文件：${dataset.path}`)
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
