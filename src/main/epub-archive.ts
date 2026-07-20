import crypto from 'node:crypto'
import fs from 'node:fs'
import { createInflateRaw } from 'node:zlib'
import JSZip from 'jszip'
import type { Entry, ZipFile } from 'yauzl'
import type { ParsedPublication } from '../shared/types'
import {
  EPUB_SAFETY_POLICY,
  EpubImporter as CoreEpubImporter,
  isSupportedRasterAsset,
  validateEpubArchiveEntries,
  type ContentHasher,
  type EpubArchiveEntry,
  type EpubArchiveReader,
} from '../core/epub-importer'

export async function parseEpubBuffer(
  data: Uint8Array,
  hasher: ContentHasher,
): Promise<ParsedPublication> {
  if (data.byteLength === 0 || data.byteLength > EPUB_SAFETY_POLICY.sourceBytes) {
    throw new Error('EPUB 文件为空或超过 500 MiB 限制')
  }
  const archive = await JsZipEpubArchive.open(data)
  return parseEpubArchive(archive, hasher, hasher.sha256(data))
}

export async function parseEpubFile(
  sourceFile: string,
  hasher: ContentHasher,
): Promise<ParsedPublication> {
  const before = await fs.promises.stat(sourceFile)
  if (!before.isFile() || before.size === 0 || before.size > EPUB_SAFETY_POLICY.sourceBytes) {
    throw new Error('EPUB 文件为空或超过 500 MiB 限制')
  }
  const hash = await hashFile(sourceFile)
  const archive = await YauzlFileEpubArchive.open(sourceFile)
  const parsed = await parseEpubArchive(archive, hasher, hash)
  const after = await fs.promises.stat(sourceFile)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('EPUB 文件在导入过程中发生变化')
  }
  return parsed
}

async function parseEpubArchive(
  archive: EpubArchiveReader,
  hasher: ContentHasher,
  hash: string,
): Promise<ParsedPublication> {
  const readBinary = archive.readBinary?.bind(archive)
  if (!readBinary) throw new Error('EPUB 平台适配器不支持读取二进制资源')
  const plan = await new CoreEpubImporter(hasher).parseArchive(archive, hash)
  const assets = new Map<string, Uint8Array>()
  let totalAssetBytes = 0
  for (const assetPath of plan.assetPaths) {
    if (!isSupportedRasterAsset(assetPath)) throw new Error(`EPUB 包含不受支持的图片资源：${assetPath}`)
    const bytes = await readBinary(assetPath)
    totalAssetBytes += bytes.byteLength
    if (totalAssetBytes > EPUB_SAFETY_POLICY.extractedRasterBytes) {
      throw new Error('EPUB 图片资源解压后超过 750 MiB 限制')
    }
    assets.set(assetPath, bytes)
  }
  const { assetPaths: _assetPaths, ...publication } = plan
  return { ...publication, assets }
}

class YauzlFileEpubArchive implements EpubArchiveReader {
  private readonly entryByPath: ReadonlyMap<string, Entry>

  private constructor(
    private readonly sourceFile: string,
    private readonly entries: readonly EpubArchiveEntry[],
    rawEntries: readonly Entry[],
  ) {
    this.entryByPath = new Map(rawEntries.map((entry) => [entry.fileName.replace(/\/$/, ''), entry]))
  }

  static async open(sourceFile: string): Promise<YauzlFileEpubArchive> {
    const zip = await openZipFile(sourceFile)
    try {
      const rawEntries = await readAllEntries(zip)
      const entries = rawEntries.map(toArchiveEntry)
      validateEpubArchiveEntries(entries, { requireSizes: true })
      return new YauzlFileEpubArchive(sourceFile, entries, rawEntries)
    } finally {
      zip.close()
    }
  }

  listEntries(): readonly EpubArchiveEntry[] {
    return this.entries
  }

  async readText(entryPath: string): Promise<string> {
    const bytes = await this.readBinary(entryPath)
    if (bytes.byteLength > EPUB_SAFETY_POLICY.textEntryBytes) {
      throw new Error(`EPUB 文本条目超过 16 MiB 限制：${entryPath}`)
    }
    return new TextDecoder().decode(bytes)
  }

  async readBinary(entryPath: string): Promise<Uint8Array> {
    const entry = this.entryByPath.get(entryPath)
    if (!entry || /\/$/.test(entry.fileName)) throw new Error(`EPUB 缺少文件：${entryPath}`)
    const output = new Uint8Array(entry.uncompressedSize)
    const { offset, crc } = entry.compressionMethod === 0
      ? await readStoredEntry(this.sourceFile, entry, output)
      : await readCompressedEntry(this.sourceFile, entry, output)
    if (offset !== output.byteLength) {
      throw new Error(`EPUB 条目实际大小与中央目录不一致：${entryPath}`)
    }
    const actualCrc = (crc ^ 0xffffffff) >>> 0
    if (actualCrc !== (entry.crc32 >>> 0)) throw new Error(`EPUB 条目 CRC 校验失败：${entryPath}`)
    return output
  }
}

class JsZipEpubArchive implements EpubArchiveReader {
  private readonly entryByPath: ReadonlyMap<string, EpubArchiveEntry>

  private constructor(
    private readonly zip: JSZip,
    private readonly entries: readonly EpubArchiveEntry[],
  ) {
    this.entryByPath = new Map(entries.map((entry) => [entry.path.replace(/\/$/, ''), entry]))
  }

  static async open(data: Uint8Array): Promise<JsZipEpubArchive> {
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const entries = await readCentralDirectory(buffer)
    validateEpubArchiveEntries(entries, { requireSizes: true })
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false })
    const actualFiles = Object.keys(zip.files)
    if (actualFiles.length !== entries.length) throw new Error('EPUB 中央目录与文件索引不一致')
    return new JsZipEpubArchive(zip, entries)
  }

  listEntries(): readonly EpubArchiveEntry[] {
    return this.entries
  }

  async readText(entryPath: string): Promise<string> {
    const bytes = await this.readBinary(entryPath)
    if (bytes.byteLength > EPUB_SAFETY_POLICY.textEntryBytes) {
      throw new Error(`EPUB 文本条目超过 16 MiB 限制：${entryPath}`)
    }
    return new TextDecoder().decode(bytes)
  }

  async readBinary(entryPath: string): Promise<Uint8Array> {
    const descriptor = this.entryByPath.get(entryPath)
    const entry = this.zip.file(entryPath)
    if (!descriptor || descriptor.directory || !entry) throw new Error(`EPUB 缺少文件：${entryPath}`)
    const bytes = await entry.async('uint8array')
    if (bytes.byteLength !== descriptor.uncompressedBytes) {
      throw new Error(`EPUB 条目实际大小与中央目录不一致：${entryPath}`)
    }
    return bytes
  }
}

async function readCentralDirectory(buffer: Buffer): Promise<EpubArchiveEntry[]> {
  const zip = await openZipBuffer(buffer)
  const entries: EpubArchiveEntry[] = []
  try {
    while (true) {
      const entry = await nextEntry(zip)
      if (!entry) break
      entries.push({
        path: entry.fileName,
        directory: /\/$/.test(entry.fileName),
        compressedBytes: entry.compressedSize,
        uncompressedBytes: entry.uncompressedSize,
      })
      if (entries.length > EPUB_SAFETY_POLICY.entries) throw new Error('EPUB 内文件数量异常')
    }
    return entries
  } finally {
    zip.close()
  }
}

async function readAllEntries(zip: ZipFile): Promise<Entry[]> {
  const entries: Entry[] = []
  while (true) {
    const entry = await nextEntry(zip)
    if (!entry) break
    entries.push(entry)
    if (entries.length > EPUB_SAFETY_POLICY.entries) throw new Error('EPUB 内文件数量异常')
  }
  return entries
}

function toArchiveEntry(entry: Entry): EpubArchiveEntry {
  return {
    path: entry.fileName,
    directory: /\/$/.test(entry.fileName),
    compressedBytes: entry.compressedSize,
    uncompressedBytes: entry.uncompressedSize,
  }
}

async function openZipBuffer(buffer: Buffer): Promise<ZipFile> {
  const { default: yauzl } = await import('yauzl')
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, {
    autoClose: false,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error('无法打开 EPUB'))
    else resolve(zip)
  }))
}

async function openZipFile(sourceFile: string): Promise<ZipFile> {
  const { default: yauzl } = await import('yauzl')
  return new Promise((resolve, reject) => yauzl.open(sourceFile, {
    autoClose: false,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error('无法打开 EPUB'))
    else resolve(zip)
  }))
}

async function readStoredEntry(
  sourceFile: string,
  entry: Entry,
  output: Uint8Array,
): Promise<{ offset: number; crc: number }> {
  if (entry.isEncrypted()) throw new Error(`EPUB 条目已加密，无法读取：${entry.fileName}`)
  if (entry.compressedSize !== entry.uncompressedSize || entry.uncompressedSize !== output.byteLength) {
    throw new Error(`EPUB 条目实际大小与中央目录不一致：${entry.fileName}`)
  }
  const handle = await fs.promises.open(sourceFile, 'r')
  try {
    const header = Buffer.allocUnsafe(30)
    const headerRead = await handle.read(header, 0, header.byteLength, entry.relativeOffsetOfLocalHeader)
    if (headerRead.bytesRead !== header.byteLength || header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(`EPUB 本地文件头无效：${entry.fileName}`)
    }
    if (header.readUInt16LE(8) !== 0) throw new Error(`EPUB 条目压缩方式不一致：${entry.fileName}`)
    const dataStart = entry.relativeOffsetOfLocalHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const stat = await handle.stat()
    if (dataStart + entry.compressedSize > stat.size) throw new Error(`EPUB 条目超出文件边界：${entry.fileName}`)
    let offset = 0
    let crc = 0xffffffff
    while (offset < output.byteLength) {
      const requested = Math.min(256 * 1024, output.byteLength - offset)
      const read = await handle.read(output, offset, requested, dataStart + offset)
      if (read.bytesRead === 0) break
      crc = updateCrc32(crc, output.subarray(offset, offset + read.bytesRead))
      offset += read.bytesRead
    }
    return { offset, crc }
  } finally {
    await handle.close()
  }
}

async function readCompressedEntry(
  sourceFile: string,
  entry: Entry,
  output: Uint8Array,
): Promise<{ offset: number; crc: number }> {
  if (entry.isEncrypted()) throw new Error(`EPUB 条目已加密，无法读取：${entry.fileName}`)
  if (entry.compressionMethod !== 8) throw new Error(`EPUB 条目使用不受支持的压缩方式：${entry.fileName}`)
  const handle = await fs.promises.open(sourceFile, 'r')
  let dataStart = 0
  try {
    const header = Buffer.allocUnsafe(30)
    const headerRead = await handle.read(header, 0, header.byteLength, entry.relativeOffsetOfLocalHeader)
    if (headerRead.bytesRead !== header.byteLength || header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(`EPUB 本地文件头无效：${entry.fileName}`)
    }
    if (header.readUInt16LE(8) !== 8) throw new Error(`EPUB 条目压缩方式不一致：${entry.fileName}`)
    dataStart = entry.relativeOffsetOfLocalHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const stat = await handle.stat()
    if (dataStart + entry.compressedSize > stat.size) throw new Error(`EPUB 条目超出文件边界：${entry.fileName}`)
  } finally {
    await handle.close()
  }
  if (entry.compressedSize === 0) return { offset: 0, crc: 0xffffffff }
  const source = fs.createReadStream(sourceFile, {
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
  })
  const inflater = createInflateRaw()
  let offset = 0
  let crc = 0xffffffff
  try {
    source.pipe(inflater)
    for await (const rawChunk of inflater) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array)
      if (offset + chunk.byteLength > output.byteLength) {
        throw new Error(`EPUB 条目实际大小与中央目录不一致：${entry.fileName}`)
      }
      output.set(chunk, offset)
      offset += chunk.byteLength
      crc = updateCrc32(crc, chunk)
    }
    return { offset, crc }
  } catch (error) {
    source.destroy()
    inflater.destroy()
    throw error
  }
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry) }
    const onEnd = () => { cleanup(); resolve(null) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const cleanup = () => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

async function hashFile(sourceFile: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(sourceFile)) hash.update(chunk)
  return hash.digest('hex')
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  return crc >>> 0
})

function updateCrc32(current: number, chunk: Uint8Array): number {
  let crc = current
  for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}
