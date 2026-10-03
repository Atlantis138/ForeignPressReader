import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ImportProgress, ImportResult, ParsedPublicationPlan } from '../shared/types'
import type { LibraryRepository } from '../core/ports'
import {
  PublicationFormatRegistry,
  type PublicationFormatAdapter,
} from '../core/importing/publication-formats'

export class LibraryService {
  private importController: AbortController | null = null
  private activeFormat: PublicationFormatAdapter | null = null

  constructor(
    private readonly database: LibraryRepository,
    private readonly formats: PublicationFormatRegistry,
    private readonly userDataPath: string,
    private readonly onProgress: (progress: ImportProgress) => void = () => undefined,
  ) {
    fs.rmSync(path.join(userDataPath, 'library', '.staging'), { recursive: true, force: true })
  }

  getImportDialogOptions(): { name: string; extensions: string[] }[] {
    return this.formats.list().map((format) => ({
      name: format.name,
      extensions: [...format.extensions],
    }))
  }

  async importFile(sourceFile: string): Promise<ImportResult> {
    return this.importPreparedFile(async () => sourceFile)
  }

  async importPreparedFile(prepare: (signal: AbortSignal) => Promise<string>): Promise<ImportResult> {
    if (this.importController) throw new Error('已有刊物正在导入')
    const controller = new AbortController()
    this.importController = controller
    let format: PublicationFormatAdapter | null = null
    let finalRoot: string | null = null
    let stagingRoot: string | null = null
    let parsedHash: string | null = null
    let ownsFinalRoot = false
    try {
      const sourceFile = await prepare(controller.signal)
      this.throwIfCancelled(controller)
      format = this.formats.resolve(sourceFile)
      this.activeFormat = format
      const stat = await fs.promises.stat(sourceFile)
      if (!stat.isFile()) throw new Error('请选择出版物文件')
      if (stat.size > format.maxBytes) {
        throw new Error(`${format.name} 文件超过 ${Math.round(format.maxBytes / 1024 / 1024)} MB 限制`)
      }
      this.emit('reading', 0, stat.size, '正在读取出版物')
      this.throwIfCancelled(controller)
      this.emit('parsing', stat.size, stat.size, `正在解析 ${format.name} 结构与来源规则`)
      const importer = format.importer
      const fileImporter = importer as typeof importer & {
        parseFile?: (filePath: string) => Promise<Awaited<ReturnType<typeof importer.parse>>>
      }
      const parsed = fileImporter.parseFile
        ? await fileImporter.parseFile(sourceFile)
        : await format.importer.parse(await fs.promises.readFile(sourceFile))
      parsedHash = parsed.hash
      this.throwIfCancelled(controller)
      const existingId = this.database.findPublicationIdByHash(parsed.hash)
      if (existingId) {
        if (parsed.id !== existingId) throw new Error('相同源文件的刊物身份不一致')
        // Add missing assets without replacing existing files.
        const assetsRoot = path.join(this.userDataPath, 'library', existingId, 'assets')
        for (const [assetPath, data] of parsed.assets) {
          this.throwIfCancelled(controller)
          const destination = safeAssetDestination(assetsRoot, assetPath)
          await fs.promises.mkdir(path.dirname(destination), { recursive: true })
          try { await fs.promises.writeFile(destination, data, { flag: 'wx' }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        const repaired = this.database.repairPublication({ ...parsed, assetPaths: [...parsed.assets.keys()] })
        this.emit('completed', 1, 1, repaired ? '已重新解析并补全刊物' : '已核对原刊物与资源')
        return { publication: this.database.getPublication(existingId), duplicate: true, repaired }
      }
      const assetBytes = [...parsed.assets.values()].reduce((sum, asset) => sum + asset.byteLength, 0)
      const space = await fs.promises.statfs(this.userDataPath)
      const availableBytes = space.bavail * space.bsize
      if (availableBytes < assetBytes + 64 * 1024 * 1024) {
        throw new Error('磁盘空间不足，无法导入 EPUB')
      }
      finalRoot = path.join(this.userDataPath, 'library', parsed.id)
      if (fs.existsSync(finalRoot)) throw new Error('这本刊物已存在，但文件内容不同。请保留原刊物，另行核对 EPUB 来源。')
      stagingRoot = path.join(this.userDataPath, 'library', '.staging', crypto.randomUUID())
      const assetsRoot = path.join(stagingRoot, 'assets')
      this.emit('writing', 0, Math.max(parsed.assets.size, 1), '正在写入书库')
      await fs.promises.mkdir(assetsRoot, { recursive: true })
      let completed = 0
      for (const [assetPath, data] of parsed.assets) {
        this.throwIfCancelled(controller)
        const destination = safeAssetDestination(assetsRoot, assetPath)
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await fs.promises.writeFile(destination, data)
        this.emit('writing', ++completed, Math.max(parsed.assets.size, 1), '正在写入资源')
      }
      await fs.promises.mkdir(path.dirname(finalRoot), { recursive: true })
      await fs.promises.rename(stagingRoot, finalRoot)
      ownsFinalRoot = true
      stagingRoot = null
      this.database.savePublication(parsed, format.id)
      this.emit('completed', 1, 1, '导入完成')
      return { publication: this.database.getPublication(parsed.id), duplicate: false }
    } catch (error) {
      if (stagingRoot) await fs.promises.rm(stagingRoot, { recursive: true, force: true })
      if (ownsFinalRoot && finalRoot && (!parsedHash || !this.database.findPublicationIdByHash(parsedHash))) {
        await fs.promises.rm(finalRoot, { recursive: true, force: true })
      }
      this.emit(controller.signal.aborted ? 'cancelled' : 'error', 0, 0, error instanceof Error ? error.message : '导入失败')
      throw error
    } finally {
      if (this.importController === controller) this.importController = null
      if (this.activeFormat === format) this.activeFormat = null
    }
  }

  async removeRetainedSources(): Promise<{ removed: number; reclaimedBytes: number; skipped: string[] }> {
    let removed = 0
    let reclaimedBytes = 0
    const skipped: string[] = []
    for (const candidate of this.database.listRetainedPublicationSources()) {
      try {
        if (candidate.expectedArticleCount !== candidate.actualArticleCount
          || candidate.expectedSectionCount !== candidate.actualSectionCount
          || candidate.actualArticleCount === 0) {
          throw new Error('解析内容计数不完整')
        }
        const publicationRoot = path.resolve(this.userDataPath, 'library', candidate.publicationId)
        const expectedSource = path.join(publicationRoot, 'source.epub')
        const sourcePath = candidate.sourcePath ? path.resolve(candidate.sourcePath) : expectedSource
        if (sourcePath !== expectedSource) throw new Error('源文件不在受管书库路径内')
        for (const assetPath of candidate.referencedAssetPaths) {
          const asset = safeAssetDestination(path.join(publicationRoot, 'assets'), assetPath)
          const stat = await fs.promises.stat(asset)
          if (!stat.isFile()) throw new Error(`解析资源不可用：${assetPath}`)
        }
        if (fs.existsSync(sourcePath)) {
          const stat = await fs.promises.stat(sourcePath)
          if (!stat.isFile() || await hashFile(sourcePath) !== candidate.contentHash) {
            throw new Error('受管源文件校验失败')
          }
          await fs.promises.rm(sourcePath)
          reclaimedBytes += stat.size
          removed++
        }
        this.database.markPublicationParsedOnly(candidate.publicationId)
      } catch (error) {
        skipped.push(`${candidate.publicationId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { removed, reclaimedBytes, skipped }
  }

  async restoreParsedPublication(
    plan: ParsedPublicationPlan,
    extractedAssetsRoot: string,
    formatId: string,
    firstImportedAt?: string,
  ): Promise<ImportResult> {
    const existingId = this.database.findPublicationIdByHash(plan.hash)
    if (existingId) {
      if (existingId !== plan.id) throw new Error('刊物内容包身份不一致')
      const assetsRoot = path.join(this.userDataPath,'library',existingId,'assets')
      for (const assetPath of plan.assetPaths) {
        const destination = safeAssetDestination(assetsRoot,assetPath)
        await fs.promises.mkdir(path.dirname(destination),{recursive:true})
        try { await fs.promises.copyFile(safeAssetDestination(extractedAssetsRoot,assetPath),destination,fs.constants.COPYFILE_EXCL) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const repaired = this.database.repairPublication(plan)
      return { publication: this.database.getPublication(existingId), duplicate: true, repaired }
    }
    const finalRoot = path.join(this.userDataPath, 'library', plan.id)
    const stagingRoot = path.join(this.userDataPath, 'library', '.staging', crypto.randomUUID())
    let ownsFinalRoot = false
    try {
      if (fs.existsSync(finalRoot)) throw new Error('刊物身份已存在但内容不同')
      const stagingAssets = path.join(stagingRoot, 'assets')
      await fs.promises.mkdir(stagingAssets, { recursive: true })
      for (const assetPath of plan.assetPaths) {
        const source = safeAssetDestination(extractedAssetsRoot, assetPath)
        const destination = safeAssetDestination(stagingAssets, assetPath)
        const stat = await fs.promises.stat(source)
        if (!stat.isFile()) throw new Error(`刊物包资源不可用：${assetPath}`)
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await fs.promises.copyFile(source, destination)
      }
      await fs.promises.mkdir(path.dirname(finalRoot), { recursive: true })
      await fs.promises.rename(stagingRoot, finalRoot)
      ownsFinalRoot = true
      this.database.savePublication({ ...plan, assets: new Map() }, formatId, firstImportedAt)
      return { publication: this.database.getPublication(plan.id), duplicate: false }
    } catch (error) {
      await fs.promises.rm(stagingRoot, { recursive: true, force: true })
      if (ownsFinalRoot && !this.database.findPublicationIdByHash(plan.hash)) {
        await fs.promises.rm(finalRoot, { recursive: true, force: true })
      }
      throw error
    }
  }

  cancelImport(): void {
    this.importController?.abort()
    this.activeFormat?.importer.cancel?.()
  }

  private throwIfCancelled(controller: AbortController): void {
    if (controller.signal.aborted) throw new Error('导入已取消')
  }

  private emit(stage: ImportProgress['stage'], completed: number, total: number, message: string): void {
    this.onProgress({ stage, completed, total, message })
  }

  async removeImportedPublication(publicationId: string): Promise<void> {
    await this.removeImportedPublications([publicationId])
  }

  async removeImportedPublications(publicationIds: string[]): Promise<void> {
    const unique = [...new Set(publicationIds)]
    this.database.deletePublications(unique)
    await Promise.all(unique.map((publicationId) =>
      fs.promises.rm(path.join(this.userDataPath, 'library', publicationId), { recursive: true, force: true }),
    ))
  }

  async purgeImportedPublication(publicationId: string): Promise<void> {
    await this.purgeImportedPublications([publicationId])
  }

  async purgeImportedPublications(publicationIds: string[]): Promise<void> {
    const unique = [...new Set(publicationIds)]
    this.database.purgePublications(unique)
    await Promise.all(unique.map((publicationId) =>
      fs.promises.rm(path.join(this.userDataPath, 'library', publicationId), { recursive: true, force: true }),
    ))
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function safeAssetDestination(assetsRoot: string, assetPath: string): string {
  const root = path.resolve(assetsRoot)
  const destination = path.resolve(root, ...assetPath.replace(/\\/g, '/').split('/'))
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error('资源路径越界')
  }
  return destination
}
