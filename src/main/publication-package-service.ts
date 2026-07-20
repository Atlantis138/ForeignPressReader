import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Entry, ZipFile } from 'yauzl'
import {
  PUBLICATION_PACKAGE_CONTENT_ID_VERSION,
  PUBLICATION_PACKAGE_FORMAT,
  PUBLICATION_PACKAGE_VERSION,
  validateParsedPublicationPlan,
  validatePublicationPackageManifest,
  type PublicationPackageFile,
  type PublicationPackageManifest,
} from '../core/publication-package'
import type { PortableBookRecord } from '../core/portable-data'
import type { ParsedPublicationPlan, ImportResult } from '../shared/types'
import type { PortableDataRepository } from './database-ports'
import type { LibraryService } from './library-service'

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 10_000

export interface CreatedPublicationPackage {
  path: string
  payloadSha256: string
  byteLength: number
  sourceContentSha256: string
  publicationId: string
  formatId: string
}

export interface InspectedPublicationPackage {
  manifest: PublicationPackageManifest
  plan: ParsedPublicationPlan
  extractedRoot: string
}

export interface PublicationPackageExpectation {
  publicationId: string
  sourceFormat: string
  sourceContentSha256: string
}

export async function publicationPackageExpandedBytes(packagePath: string): Promise<number> {
  const stat = await fs.promises.stat(packagePath)
  if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('刊物包大小无效')
  const zip = await openZip(packagePath)
  let total = 0
  let entries = 0
  try {
    while (true) {
      const entry = await nextEntry(zip)
      if (!entry) break
      if (entry.fileName.endsWith('/')) continue
      normalizePackageEntry(entry.fileName)
      entries += 1
      total += entry.uncompressedSize
      if (entries > MAX_PACKAGE_ENTRIES || total > MAX_PACKAGE_BYTES || !Number.isSafeInteger(total)) {
        throw new Error('刊物包展开大小异常')
      }
    }
    return total
  } finally {
    zip.close()
  }
}

export class PublicationPackageService {
  private readonly temporaryRoot: string

  constructor(
    private readonly database: Pick<PortableDataRepository, 'getParsedPublicationPlan' | 'findPublicationIdByHash'>,
    private readonly library: Pick<LibraryService, 'restoreParsedPublication'>,
    private readonly userDataPath: string,
  ) {
    this.temporaryRoot = path.join(userDataPath, 'publication-packages')
    fs.rmSync(this.temporaryRoot, { recursive: true, force: true })
    fs.mkdirSync(this.temporaryRoot, { recursive: true })
  }

  async createPackage(book: PortableBookRecord, destination: string): Promise<CreatedPublicationPackage> {
    const assetsRoot = path.join(this.userDataPath, 'library', book.publicationId, 'assets')
    const assets = await listAssetFiles(assetsRoot)
    const plan = validateParsedPublicationPlan(this.database.getParsedPublicationPlan(
      book.publicationId,
      assets.map((asset) => asset.relativePath),
    ))
    if (plan.hash !== book.hash || plan.id !== book.publicationId) throw new Error('刊物包身份与书库记录不一致')
    const planBuffer = Buffer.from(JSON.stringify(plan))
    const files: PublicationPackageFile[] = [{
      path: 'publication.json', size: planBuffer.length, sha256: sha256(planBuffer), kind: 'plan',
    }]
    for (const asset of assets) {
      const actual = await hashFile(asset.absolutePath)
      files.push({ path: `assets/${asset.relativePath}`, size: actual.size, sha256: actual.sha256, kind: 'asset' })
    }
    const manifest: PublicationPackageManifest = {
      format: PUBLICATION_PACKAGE_FORMAT,
      formatVersion: PUBLICATION_PACKAGE_VERSION,
      contentIdVersion: PUBLICATION_PACKAGE_CONTENT_ID_VERSION,
      publicationId: book.publicationId,
      sourceFormat: book.formatId,
      sourceContentSha256: book.hash,
      firstImportedAt: book.importedAt,
      planPath: 'publication.json',
      files,
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    await fs.promises.rm(destination, { force: true })
    await writePackageArchive(destination, manifest, planBuffer, assets)
    const payload = await hashFile(destination)
    return {
      path: destination,
      payloadSha256: payload.sha256,
      byteLength: payload.size,
      sourceContentSha256: book.hash,
      publicationId: book.publicationId,
      formatId: book.formatId,
    }
  }

  async validatePackage(packagePath: string): Promise<Omit<InspectedPublicationPackage, 'extractedRoot'>> {
    const inspected = await this.inspectPackage(packagePath)
    try {
      return { manifest: inspected.manifest, plan: inspected.plan }
    } finally {
      await fs.promises.rm(inspected.extractedRoot, { recursive: true, force: true })
    }
  }

  async importPackage(packagePath: string, expected?: PublicationPackageExpectation): Promise<ImportResult> {
    const inspected = await this.inspectPackage(packagePath)
    try {
      if (expected && (inspected.manifest.publicationId !== expected.publicationId
        || inspected.manifest.sourceFormat !== expected.sourceFormat
        || inspected.manifest.sourceContentSha256 !== expected.sourceContentSha256)) {
        throw new Error('刊物包与预期身份不一致')
      }
      return await this.library.restoreParsedPublication(
        inspected.plan,
        path.join(inspected.extractedRoot, 'assets'),
        inspected.manifest.sourceFormat,
        inspected.manifest.firstImportedAt,
      )
    } finally {
      await fs.promises.rm(inspected.extractedRoot, { recursive: true, force: true })
    }
  }

  async inspectPackage(packagePath: string): Promise<InspectedPublicationPackage> {
    const stat = await fs.promises.stat(packagePath)
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('刊物包大小无效')
    const root = path.join(this.temporaryRoot, crypto.randomUUID())
    await fs.promises.mkdir(root, { recursive: true })
    try {
      const extracted = await extractPackageZip(packagePath, root)
      const manifest = validatePublicationPackageManifest(
        JSON.parse(await fs.promises.readFile(path.join(root, 'manifest.json'), 'utf8')),
      )
      const expected = new Set(['manifest.json', ...manifest.files.map((file) => file.path)])
      if (expected.size !== extracted.length || extracted.some((entry) => !expected.has(entry))) {
        throw new Error('刊物包文件与清单不一致')
      }
      for (const file of manifest.files) {
        const actual = await hashFile(path.join(root, ...file.path.split('/')))
        if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`刊物包文件校验失败：${file.path}`)
      }
      const plan = validateParsedPublicationPlan(
        JSON.parse(await fs.promises.readFile(path.join(root, manifest.planPath), 'utf8')),
      )
      if (plan.id !== manifest.publicationId || plan.hash !== manifest.sourceContentSha256) {
        throw new Error('刊物包解析计划身份不一致')
      }
      const packagedAssets = manifest.files.filter((file) => file.kind === 'asset').map((file) => file.path.slice(7)).sort()
      if (packagedAssets.length !== plan.assetPaths.length
        || packagedAssets.some((assetPath, index) => assetPath !== [...plan.assetPaths].sort()[index])) {
        throw new Error('刊物包解析计划与资源清单不一致')
      }
      return { manifest, plan, extractedRoot: root }
    } catch (error) {
      await fs.promises.rm(root, { recursive: true, force: true })
      throw error
    }
  }
}

async function writePackageArchive(
  destination: string,
  manifest: PublicationPackageManifest,
  planBuffer: Buffer,
  assets: Array<{ relativePath: string; absolutePath: string }>,
): Promise<void> {
  const { default: archiver } = await import('archiver')
  const output = fs.createWriteStream(destination, { flags: 'wx' })
  const archive = archiver('zip', { zlib: { level: 6 } })
  const completion = new Promise<void>((resolve, reject) => {
    output.on('close', resolve); output.on('error', reject); archive.on('error', reject)
  })
  const date = new Date(0)
  archive.pipe(output)
  archive.append(Buffer.from(JSON.stringify(manifest)), { name: 'manifest.json', date })
  archive.append(planBuffer, { name: 'publication.json', date })
  for (const asset of assets) {
    archive.append(fs.createReadStream(asset.absolutePath), { name: `assets/${asset.relativePath}`, date, store: true })
  }
  await archive.finalize()
  await completion
}

async function listAssetFiles(root: string): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const result: Array<{ relativePath: string; absolutePath: string }> = []
  const visit = async (directory: string) => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('书库资源目录包含符号链接')
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
        if (!relativePath || relativePath.startsWith('../')) throw new Error('书库资源路径越界')
        result.push({ relativePath, absolutePath })
      }
    }
  }
  if (fs.existsSync(root)) await visit(root)
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function extractPackageZip(sourcePath: string, root: string): Promise<string[]> {
  const zip = await openZip(sourcePath)
  const extracted: string[] = []
  let total = 0
  try {
    while (true) {
      const entry = await nextEntry(zip)
      if (!entry) break
      if (extracted.length >= MAX_PACKAGE_ENTRIES) throw new Error('刊物包文件数量异常')
      const entryPath = normalizePackageEntry(entry.fileName)
      if (entryPath.endsWith('/')) continue
      total += entry.uncompressedSize
      if (total > MAX_PACKAGE_BYTES) throw new Error('刊物包解压大小异常')
      if (entryPath !== 'manifest.json' && entryPath !== 'publication.json' && !entryPath.startsWith('assets/')) {
        throw new Error(`刊物包含未知文件：${entryPath}`)
      }
      const destination = path.join(root, ...entryPath.split('/'))
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(destination, { flags: 'wx' }))
      extracted.push(entryPath)
    }
  } finally {
    zip.close()
  }
  return extracted
}

function normalizePackageEntry(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const directory = normalized.endsWith('/')
  const trimmed = directory ? normalized.slice(0, -1) : normalized
  if (!trimmed || trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)
    || trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error('刊物包路径越界')
  return directory ? `${trimmed}/` : trimmed
}

async function openZip(filePath: string): Promise<ZipFile> {
  const { default: yauzl } = await import('yauzl')
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, decodeStrings: true }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error('无法打开刊物包'))
    else resolve(zip)
  }))
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError) }
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry) }
    const onEnd = () => { cleanup(); resolve(null) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError); zip.readEntry()
  })
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) reject(error ?? new Error('无法读取刊物包条目'))
    else resolve(stream)
  }))
}

async function hashFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.from(chunk); size += buffer.length; hash.update(buffer)
  }
  return { sha256: hash.digest('hex'), size }
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}
