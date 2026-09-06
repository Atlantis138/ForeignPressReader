import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, expect, it } from 'vitest'
import type { PortableUserData } from '../src/core/portable-data'
import { PORTABLE_DATASET_KEYS } from '../src/core/portable-data'
import { EpubImporter } from '../src/main/epub-importer'
import { SqliteApplicationRepository } from '../src/main/database'
import { LibraryService } from '../src/main/library-service'
import { PortableDataService } from '../src/main/portable-data-service'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'

const roots: string[] = []
const interopTest = process.env.FPR_RUN_RUST_INTEROP === '1' ? it : it.skip

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* failed tests may retain open SQLite handles */ }
  }
})

interopTest('round-trips format v4 through Windows and Rust with rollback and idempotency', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-interop-'))
  roots.push(root)
  const sourceRoot = path.join(root, 'windows-source')
  const sourceDb = await SqliteApplicationRepository.open(sourceRoot, 'portable-interop')
  const sourceLibrary = new LibraryService(sourceDb, epubFormats(), sourceRoot)
  const epubPath = path.join(root, 'micro.epub')
  fs.writeFileSync(epubPath, await syntheticEpub())
  const publication = await sourceLibrary.importFile(epubPath)
  const article = publication.publication.sections[0].articles[0]
  sourceDb.savePosition(publication.publication.id, article.id, 321)
  sourceDb.changeReadingData(article.id,{kind:'bookmark',value:true})
  sourceDb.changeReadingData(article.id,{kind:'read',value:true})
  const translationBlock=sourceDb.getArticle(article.id).blocks.find(b=>b.type==='paragraph')!
  sourceDb.saveTranslation(translationBlock.id,createHash('sha256').update(translationBlock.text!).digest('hex'),'跨平台保留译文','interop-model','interop-prompt')
  const translationVersion=sourceDb.preserveTranslations(article.id)!
  sourceDb.changeReadingData(article.id,{kind:'translation-selection',value:translationVersion})

  const vector = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test-vectors', 'portable-v2-interop.json'), 'utf8',
  )) as { portableData: PortableUserData }
  sourceDb.mergePortableUserData(vector.portableData, 'incoming-wins')

  const windowsBackup = path.join(root, 'windows.fprbackup')
  const sourceService = new PortableDataService(sourceDb, sourceLibrary, sourceRoot, 'portable-interop', () => undefined)
  await sourceService.exportPortable(windowsBackup)

  const rustBackup = path.join(root, 'rust.fprbackup')
  const command = spawnSync('cargo', [
    'run', '--quiet', '--manifest-path', path.join(process.cwd(), 'src-tauri', 'Cargo.toml'),
    '--features', 'portable-interop', '--bin', 'portable-interop', '--',
    'roundtrip', windowsBackup, rustBackup, path.join(root, 'rust-state'),
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000 })
  expect(command.error, command.stderr).toBeUndefined()
  expect(command.status, command.stderr).toBe(0)
  const report = JSON.parse(command.stdout.trim().split(/\r?\n/).at(-1)!) as {
    first: { newPublications: number }
    second: Record<string, number> & { duplicatePublications: number }
    exportedBytes: number
  }
  expect(report.first.newPublications).toBe(1)
  expect(report.second.duplicatePublications).toBe(1)
  expect(Object.entries(report.second)
    .filter(([key]) => key !== 'duplicatePublications')
    .every(([, count]) => count === 0)).toBe(true)
  expect(report.exportedBytes).toBeGreaterThan(0)

  const archive = await JSZip.loadAsync(fs.readFileSync(rustBackup))
  const names = Object.keys(archive.files).filter((name) => !archive.files[name].dir)
  expect(names.some((name) => /secret|credential|cache|sqlite|source\.epub/i.test(name))).toBe(false)
  expect(names.some((name) => /^publications\/[a-f0-9]{64}\.fprpub$/.test(name))).toBe(true)

  const targetRoot = path.join(root, 'windows-target')
  const targetDb = await SqliteApplicationRepository.open(targetRoot, 'portable-interop')
  targetDb.getConnection().prepare(`
    INSERT INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)
  `).run(
    'translation.preferences',
    '{"providerId":"none","modelId":"target-wins"}',
    '2026-01-02T00:00:00.000Z',
    'device-z',
  )
  const targetLibrary = new LibraryService(targetDb, epubFormats(), targetRoot)
  const targetService = new PortableDataService(targetDb, targetLibrary, targetRoot, 'portable-interop', () => undefined)
  let preview = await targetService.inspectImport(rustBackup)
  expect(preview.newPublicationCount).toBe(1)
  const first = await targetService.confirmImport(preview.token)
  expect(first.importedPublications).toBe(1)
  expect(targetDb.getConnection().prepare("SELECT value FROM settings WHERE key='translation.preferences'").get())
    .toEqual({ value: '{"providerId":"none","modelId":"target-wins"}' })

  for (const dataset of PORTABLE_DATASET_KEYS) {
    if (dataset === 'settings') continue
    expect(Array.from(targetDb.iteratePortableDataset(dataset)), dataset)
      .toEqual(Array.from(sourceDb.iteratePortableDataset(dataset)))
  }
  expect(tableCounts(targetDb)).toEqual({
    publications: 1,
    publication_lifecycle: 1,
    reading_positions: 1,
    user_lexemes: 2,
    lexeme_examples: 1,
    vocabulary_sources: 2,
    saved_contexts: 1,
    study_plans: 1,
    study_plan_sources: 1,
    study_plan_lexeme_origins: 2,
    study_plan_exclusions: 1,
    scheduler_profiles: 1,
    study_progress_state: 1,
    study_lexeme_resets: 1,
    review_cards: 1,
    review_events: 1,
    reinforcement_events: 1,
    review_suspensions: 1,
  })
  preview = await targetService.inspectImport(rustBackup)
  const second = await targetService.confirmImport(preview.token)
  expect(second.importedPublications).toBe(0)
  expect(second.duplicatePublications).toBe(1)

  const invalidBackup = path.join(root, 'invalid-duplicate-command.fprbackup')
  await addDuplicateReviewCommand(rustBackup, invalidBackup)
  const rollbackRoot = path.join(root, 'windows-rollback')
  const rollbackDb = await SqliteApplicationRepository.open(rollbackRoot, 'portable-interop')
  const rollbackLibrary = new LibraryService(rollbackDb, epubFormats(), rollbackRoot)
  const rollbackService = new PortableDataService(rollbackDb, rollbackLibrary, rollbackRoot, 'portable-interop', () => undefined)
  const rollbackPreview = await rollbackService.inspectImport(invalidBackup)
  await expect(rollbackService.confirmImport(rollbackPreview.token)).rejects.toThrow()
  expect(rollbackDb.listPublications()).toHaveLength(0)
  expect((rollbackDb.getConnection().prepare('SELECT count(*) AS count FROM user_lexemes').get() as { count: number }).count).toBe(0)
  expect(fs.readdirSync(path.join(rollbackRoot, 'library')).filter((name) => name !== '.staging')).toHaveLength(0)

  rollbackService.close(); rollbackDb.close()
  targetService.close(); targetDb.close()
  sourceService.close(); sourceDb.close()
}, 300_000)

function tableCounts(database: SqliteApplicationRepository): Record<string, number> {
  const tables = [
    'publications', 'publication_lifecycle', 'reading_positions', 'user_lexemes', 'lexeme_examples',
    'vocabulary_sources', 'saved_contexts', 'study_plans', 'study_plan_sources',
    'study_plan_lexeme_origins', 'study_plan_exclusions', 'scheduler_profiles',
    'study_progress_state', 'study_lexeme_resets', 'review_cards', 'review_events',
    'reinforcement_events', 'review_suspensions',
  ]
  return Object.fromEntries(tables.map((table) => [
    table,
    (database.getConnection().prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]))
}

async function addDuplicateReviewCommand(source: string, destination: string): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(source))
  const pathName = 'data/review-events.ndjson'
  const body = await zip.file(pathName)!.async('text')
  const first = JSON.parse(body.trim().split(/\r?\n/)[0]) as Record<string, unknown>
  const tampered = `${body.trimEnd()}\n${JSON.stringify({ ...first, eventId: 'review-event-duplicate-command' })}\n`
  zip.file(pathName, tampered)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')) as {
    files: Array<{ path: string; size: number; sha256: string }>
    counts: { reviewEvents: number }
  }
  const listed = manifest.files.find((file) => file.path === pathName)!
  listed.size = Buffer.byteLength(tampered)
  listed.sha256 = createHash('sha256').update(tampered).digest('hex')
  manifest.counts.reviewEvents += 1
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  fs.writeFileSync(destination, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

async function syntheticEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('EPUB/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Interop Weekly</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="section" href="section.xhtml" media-type="application/xhtml+xml"/><item id="article" href="article.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="section"/><itemref idref="article"/></spine></package>')
  zip.file('EPUB/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="section.xhtml">Technology</a><ol><li><a href="article.xhtml">A portable record</a></li></ol></li></ol></nav></body></html>')
  zip.file('EPUB/section.xhtml', '<html><body><h2 class="te_section_title">Technology</h2></body></html>')
  zip.file('EPUB/article.xhtml', '<html><head><title>A portable record</title></head><body><h1>A portable record</h1><p>This sufficiently long English paragraph creates deterministic readable content for the portable interoperability test.</p><p>A second paragraph keeps the micro publication representative while containing no private user data.</p></body></html>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

function epubFormats(): PublicationFormatRegistry {
  return new PublicationFormatRegistry([{
    id: 'epub', name: 'EPUB', extensions: ['epub'], maxBytes: 500 * 1024 * 1024,
    importer: new EpubImporter(),
  }])
}
