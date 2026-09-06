import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { EpubImporter } from '../src/main/epub-importer'
import { SqliteApplicationRepository } from '../src/main/database'
import { LibraryService, safeAssetDestination } from '../src/main/library-service'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import {
  EpubSourceProfileRegistry,
  GENERIC_EPUB_PROFILE,
} from '../src/core/importing/source-profiles'
import {
  EPUB_SAFETY_POLICY,
  EpubImporter as CoreEpubImporter,
  validateEpubArchiveEntries,
} from '../src/core/epub-importer'
import { portableContentHasher, sha256Hex } from '../src/core/sha256'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const item of temporaryPaths.splice(0)) fs.rmSync(item, { recursive: true, force: true })
})

describe('EpubImporter', () => {
  it.each(['<p>Short news matters.</p>', '<div>Div <em>prose</em> survives.</div>',
    '<p>Intro.</p><table><tr><th>Country</th><td>Japan</td></tr></table>'])('preserves short and non-paragraph prose: %s', async body => {
    const zip = await JSZip.loadAsync(await syntheticEpub())
    const document = Object.keys(zip.files).find(name => /article.*\.xhtml$/.test(name))!
    expect(document).toBeTruthy()
    zip.file(document, `<html><head><title>News</title></head><body><h1>News</h1>${body}</body></html>`)
    const plan = await new EpubImporter().parse(await zip.generateAsync({ type: 'nodebuffer' }))
    const article = [...plan.unsectionedArticles, ...plan.sections.flatMap(section => section.articles)].find(article => article.title === 'News')!
    expect(article).toBeTruthy()
    const text = article.blocks.map(block => block.text).join(' ')
    for (const word of body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean)) expect(text).toContain(word)
  })

  it('preserves existing assets on same-identity import and restore conflicts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-import-conflict-'))
    temporaryPaths.push(root)
    const dataRoot = path.join(root, 'data'), epubPath = path.join(root, 'book.epub')
    const bytes = await syntheticEpub()
    fs.writeFileSync(epubPath, bytes)
    const db = await SqliteApplicationRepository.open(dataRoot, 'test')
    try {
      const library = new LibraryService(db, epubFormats(), dataRoot)
      const original = await library.importFile(epubPath)
      const assetsRoot = path.join(dataRoot, 'library', original.publication.id, 'assets')
      const cover = path.join(assetsRoot, 'EPUB', 'images', 'cover.jpg')
      const originalCover = fs.readFileSync(cover)
      const zip = await JSZip.loadAsync(bytes)
      zip.file('changed.txt', 'same identity, different bytes')
      const changed = await zip.generateAsync({ type: 'nodebuffer' })
      fs.writeFileSync(epubPath, changed)
      await expect(library.importFile(epubPath)).rejects.toThrow('已存在')
      const { assets, ...plan } = await new EpubImporter().parse(changed)
      await expect(library.restoreParsedPublication({ ...plan, assetPaths: [...assets.keys()] }, assetsRoot, 'epub')).rejects.toThrow('已存在')
      expect(fs.readFileSync(cover)).toEqual(originalCover)
      expect(db.getPublication(original.publication.id).articleCount).toBe(1)
      fs.unlinkSync(cover)
      fs.writeFileSync(epubPath, bytes)
      await expect(library.importFile(epubPath)).resolves.toMatchObject({ duplicate: true })
      expect(fs.readFileSync(cover)).toEqual(originalCover)
    } finally { db.close() }
  })
  it('matches the shared EPUB safety policy and rejects hostile metadata without allocating payloads', () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'epub-safety-v1.json'),
      'utf8',
    )) as Record<string, unknown>
    expect(vector).toMatchObject({ policyVersion: 1, ...EPUB_SAFETY_POLICY })
    expect(() => validateEpubArchiveEntries([{
      path: 'EPUB/bomb.xhtml', directory: false, compressedBytes: 1, uncompressedBytes: 2_001,
    }], { requireSizes: true })).toThrow('压缩比')
    expect(() => validateEpubArchiveEntries([{
      path: 'EPUB/large.xhtml', directory: false, compressedBytes: 20_000, uncompressedBytes: EPUB_SAFETY_POLICY.textEntryBytes + 1,
    }], { requireSizes: true })).toThrow('文本条目')
    expect(() => validateEpubArchiveEntries([
      { path: 'EPUB/a.xhtml', directory: false, compressedBytes: 1, uncompressedBytes: 1 },
      { path: 'EPUB/a.xhtml', directory: false, compressedBytes: 1, uncompressedBytes: 1 },
    ], { requireSizes: true })).toThrow('重复')
    expect(() => validateEpubArchiveEntries([{
      path: '../outside.xhtml', directory: false, compressedBytes: 1, uncompressedBytes: 1,
    }], { requireSizes: true })).toThrow('越界')
  })

  it('normalizes EPUB navigation, sections, articles and safe inline content', async () => {
    const buffer = await syntheticEpub()
    const parsed = await new EpubImporter().parse(buffer)

    expect(parsed.title).toBe('Synthetic Weekly')
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].title).toBe('Leaders')
    expect(parsed.sections[0].articles).toHaveLength(1)
    const article = parsed.sections[0].articles[0]
    expect(article.title).toBe('A synthetic article')
    expect(article.blocks.map((block) => block.type)).toEqual([
      'title', 'rubric', 'paragraph', 'paragraph', 'image', 'caption',
    ])
    expect(article.blocks[2].html).toContain('<em>important</em>')
    expect(article.blocks[2].html).not.toContain('onclick')
    expect(article.blocks.some((block) => block.text?.includes('malicious'))).toBe(false)
    expect(parsed.coverPath).toBe('EPUB/images/cover.jpg')
  })

  it('keeps the Electron file fast path identical to byte parsing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-file-import-'))
    temporaryPaths.push(root)
    const epubPath = path.join(root, 'fixture.epub')
    const zip = await JSZip.loadAsync(await syntheticEpub())
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    fs.writeFileSync(epubPath, buffer)

    const fromBytes = await new EpubImporter().parse(buffer)
    const fromFile = await new EpubImporter().parseFile(epubPath)

    expect(fromFile).toEqual(fromBytes)
  })

  it('rejects a CRC-corrupted entry on the Electron file fast path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-file-crc-'))
    temporaryPaths.push(root)
    const epubPath = path.join(root, 'corrupt.epub')
    const source = await syntheticEpub()
    const marker = syntheticPhotoBytes()
    const markerOffset = source.indexOf(marker)
    expect(markerOffset).toBeGreaterThanOrEqual(0)
    const corrupted = Buffer.from(source)
    corrupted[markerOffset + 3] ^= 0xff
    fs.writeFileSync(epubPath, corrupted)

    await expect(new EpubImporter().parseFile(epubPath)).rejects.toThrow('CRC')
  })

  it('keeps the streaming archive plan identical to the Electron byte adapter', async () => {
    const buffer = await syntheticEpub()
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false })
    const archive = {
      listEntries: () => Object.entries(zip.files).map(([entryPath, entry]) => ({
        path: entryPath,
        directory: entry.dir,
      })),
      readText: async (entryPath: string) => {
        const entry = zip.file(entryPath)
        if (!entry) throw new Error(`missing ${entryPath}`)
        return entry.async('text')
      },
    }
    const plan = await new CoreEpubImporter(portableContentHasher).parseArchive(
      archive,
      sha256Hex(buffer),
    )
    const full = await new EpubImporter().parse(buffer)
    const { assets, ...metadata } = full

    expect(plan).toEqual({ ...metadata, assetPaths: [...assets.keys()].sort() })
  })

  it('rejects SVG and other unsupported image resources explicitly', async () => {
    const zip = await JSZip.loadAsync(await syntheticEpub())
    const opf = await zip.file('EPUB/content.opf')!.async('text')
    zip.file('EPUB/content.opf', opf.replace(
      '</manifest>',
      '<item id="vector" href="images/vector.svg" media-type="image/svg+xml"/></manifest>',
    ))
    zip.file('EPUB/images/vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(new EpubImporter().parse(buffer)).rejects.toThrow('不受支持的图片资源')
  })

  it('matches the shared content ID v2 EPUB vector', async () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'epub-content-v2.json'),
      'utf8',
    )) as { contentIdVersion: number; expectedPlan: unknown }
    const buffer = await syntheticEpub()
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false })
    const plan = await new CoreEpubImporter(portableContentHasher).parseArchive({
      listEntries: () => Object.entries(zip.files).map(([entryPath, entry]) => ({
        path: entryPath,
        directory: entry.dir,
      })),
      readText: async (entryPath: string) => {
        const entry = zip.file(entryPath)
        if (!entry) throw new Error(`missing ${entryPath}`)
        return entry.async('text')
      },
    }, 'a'.repeat(64))

    expect(vector.contentIdVersion).toBe(2)
    expect(plan).toEqual(vector.expectedPlan)
  })

  it('persists, restores and de-duplicates an imported publication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-test-'))
    temporaryPaths.push(root)
    const epubPath = path.join(root, 'fixture.epub')
    const source = await syntheticEpub()
    fs.writeFileSync(epubPath, source)
    const db = await SqliteApplicationRepository.open(path.join(root, 'data'), 'test')
    const library = new LibraryService(db, epubFormats(), path.join(root, 'data'))

    const first = await library.importFile(epubPath)
    const second = await library.importFile(epubPath)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(db.listPublications()).toHaveLength(1)
    expect(first.publication.articleCount).toBe(1)
    const articleId = first.publication.sections[0].articles[0].id
    const block = db.getTranslatableBlocks(articleId)[0]
    db.saveTranslation(block.id, block.sourceHash, '原模型的有效译文', 'previous-model', 'previous-prompt')
    db.saveTranslation(block.id, 'obsolete-source-hash', '不应显示的旧正文译文', 'other-model', 'other-prompt')
    expect(db.getArticle(articleId).blocks[0].translation).toBe('原模型的有效译文')
    expect(fs.readFileSync(epubPath)).toEqual(source)
    expect(fs.existsSync(path.join(root, 'data', 'library', first.publication.id, 'source.epub'))).toBe(false)
    let state = db.createLibraryCategory('每周刊物')
    const categoryId = state.categories[0].id
    state = db.renameLibraryPublication(first.publication.id, '我的合成周刊')
    state = db.assignLibraryPublications([first.publication.id], categoryId)
    state = db.saveLibraryPreferences({ viewMode: 'list', sortBy: 'name', sortDirection: 'asc', activeCategoryId: categoryId })
    expect(state.publications[0]).toMatchObject({ title: '我的合成周刊', originalTitle: 'Synthetic Weekly', categoryId })
    expect(state.preferences).toEqual({ viewMode: 'list', sortBy: 'name', sortDirection: 'asc', activeCategoryId: categoryId })
    expect(db.getPublication(first.publication.id).title).toBe('我的合成周刊')
    expect(db.getArticle(first.publication.sections[0].articles[0].id).publicationTitle).toBe('我的合成周刊')
    state = db.deleteLibraryCategory(categoryId)
    expect(state.publications[0].categoryId).toBeNull()
    await library.removeImportedPublications([first.publication.id])
    expect(db.listPublications()).toHaveLength(0)
    expect(fs.existsSync(path.join(root, 'data', 'library', first.publication.id))).toBe(false)
    db.close()
  })

  it('removes validated retained sources on upgrade and never deletes an unsafe candidate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-source-cleanup-'))
    temporaryPaths.push(root)
    const dataRoot = path.join(root, 'data')
    const epubPath = path.join(root, 'fixture.epub')
    const source = await syntheticEpub()
    fs.writeFileSync(epubPath, source)
    const db = await SqliteApplicationRepository.open(dataRoot, 'test')
    try {
      const library = new LibraryService(db, epubFormats(), dataRoot)
      const imported = await library.importFile(epubPath)
      const managedSource = path.join(dataRoot, 'library', imported.publication.id, 'source.epub')
      fs.writeFileSync(managedSource, source)
      db.getConnection().prepare(`
        UPDATE publications SET source_path=?, source_storage='retained' WHERE id=?
      `).run(managedSource, imported.publication.id)

      await expect(library.removeRetainedSources()).resolves.toEqual({
        removed: 1,
        reclaimedBytes: source.length,
        skipped: [],
      })
      expect(fs.existsSync(managedSource)).toBe(false)
      expect(db.getConnection().prepare(
        'SELECT source_path,source_storage FROM publications WHERE id=?',
      ).get(imported.publication.id)).toEqual({ source_path: '', source_storage: 'parsed-only' })
      await expect(library.removeRetainedSources()).resolves.toEqual({ removed: 0, reclaimedBytes: 0, skipped: [] })

      fs.writeFileSync(managedSource, 'not the imported EPUB')
      db.getConnection().prepare(`
        UPDATE publications SET source_path=?, source_storage='retained' WHERE id=?
      `).run(managedSource, imported.publication.id)
      const unsafe = await library.removeRetainedSources()
      expect(unsafe.removed).toBe(0)
      expect(unsafe.skipped).toHaveLength(1)
      expect(unsafe.skipped[0]).toContain('受管源文件校验失败')
      expect(fs.existsSync(managedSource)).toBe(true)
      expect(db.getConnection().prepare(
        'SELECT source_storage FROM publications WHERE id=?',
      ).get(imported.publication.id)).toEqual({ source_storage: 'retained' })
      expect(fs.readFileSync(epubPath)).toEqual(source)
    } finally {
      db.close()
    }
  })

  it('prevents extracted assets from escaping the library root', () => {
    expect(() => safeAssetDestination('C:\\library\\assets', '../secret.txt')).toThrow('资源路径越界')
  })

  it('resolves publication formats through an extensible registry', () => {
    const registry = epubFormats()
    expect(registry.resolve('weekly.EPUB').id).toBe('epub')
    expect(() => registry.resolve('weekly.pdf')).toThrow('当前支持：.epub')
  })

  it('allows future EPUB sources to register their own profile', () => {
    const registry = new EpubSourceProfileRegistry([], GENERIC_EPUB_PROFILE)
    registry.register({
      id: 'future-weekly',
      titleSelectors: '.future-title',
      sectionSelectors: '.future-section',
      rubricSelectors: '.future-rubric',
      dateSelectors: 'time',
      matches: (title) => title === 'Future Weekly',
      shouldSkipDocument: () => false,
    })
    expect(registry.select('Future Weekly', []).id).toBe('future-weekly')
    expect(registry.select('Unknown', []).id).toBe('generic-epub')
  })

  const samplePath = process.env.EPUB_SAMPLE_PATH
  it.skipIf(!samplePath)('matches the supplied Economist acceptance sample', async () => {
    const parsed = await new EpubImporter().parse(fs.readFileSync(samplePath!))
    const articles = parsed.sections.flatMap((section) => section.articles)
    const july11 = path.basename(samplePath!).includes('2026.07.11')
    expect(parsed.sections).toHaveLength(july11 ? 20 : 19)
    expect(articles).toHaveLength(july11 ? 76 : 74)
    expect(parsed.coverPath).toBeTruthy()
    if (!july11) {
      expect(articles.find((article) => article.title.startsWith('America is anxious'))?.blocks).toHaveLength(22)
    }
  })
})

function epubFormats(): PublicationFormatRegistry {
  return new PublicationFormatRegistry([{
    id: 'epub',
    name: 'EPUB 电子刊物',
    extensions: ['epub'],
    maxBytes: 500 * 1024 * 1024,
    importer: new EpubImporter(),
  }])
}

async function syntheticEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`)
  zip.file('EPUB/content.opf', `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Synthetic Weekly</dc:title><dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
        <item id="section" href="section.xhtml" media-type="application/xhtml+xml"/>
        <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
        <item id="image" href="images/photo.jpg" media-type="image/jpeg"/>
      </manifest>
      <spine><itemref idref="section"/><itemref idref="article"/></spine>
    </package>`)
  zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="section.xhtml">Leaders</a><ol><li><a href="article.xhtml">A synthetic article</a></li></ol></li></ol></nav></body></html>`)
  zip.file('EPUB/section.xhtml', '<html><head><title>Leaders</title></head><body><h2 class="te_section_title">Leaders</h2></body></html>')
  zip.file('EPUB/article.xhtml', `<html><head><title>A synthetic article</title></head><body>
    <h1 class="te_article_title">A synthetic article</h1><h3 class="te_article_rubric">A useful rubric</h3>
    <p onclick="bad()">This is an <em>important</em> first paragraph with enough English words for article classification today.</p>
    <script>malicious()</script><p>The second paragraph makes this fixture representative while remaining deliberately concise for a unit test.</p>
    <img src="images/photo.jpg" alt="Synthetic photograph"/><figcaption>A short caption</figcaption>
  </body></html>`)
  zip.file('EPUB/images/cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  zip.file('EPUB/images/photo.jpg', syntheticPhotoBytes(), { compression: 'STORE' })
  return zip.generateAsync({ type: 'nodebuffer' })
}

function syntheticPhotoBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xff, 0xd9])
}
