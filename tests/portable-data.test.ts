import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { EpubImporter } from '../src/main/epub-importer'
import { LibraryService } from '../src/main/library-service'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import { PortableDataService, replacePortableBackup } from '../src/main/portable-data-service'
import type { LexemeDetail } from '../src/shared/types'
import { SqliteStudyRepository } from '../src/main/study-repository'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable essential-user-data archive', () => {
  it('does not roll back committed data when obsolete-file cleanup fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-cleanup-'))
    roots.push(root)
    const database = {
      createSafetyBackup: vi.fn().mockResolvedValue(undefined),
      clearPublicationLifecycleForRestore: vi.fn(), beginPortableMerge: vi.fn(),
      commitPortableMerge: vi.fn(), rollbackPortableMerge: vi.fn(),
      getPublicationLifecycle: () => ({ state: 'deleted' }),
    }
    const library = { purgeImportedPublication: vi.fn().mockResolvedValue(undefined) }
    const service = new PortableDataService(database as never, library as never, root, 'test', () => undefined)
    // Inject the validated stage, then fault the filesystem only after COMMIT.
    const internals = service as unknown as {
      staged: Map<string, unknown>
      publicationPackages: { importPackage: () => Promise<unknown> }
      mergePortableFiles: () => Promise<unknown>
    }
    internals.staged.set('test', { root: path.join(root, 'stage'), fileName: 'test.fprbackup',
      manifest: { formatVersion: 3 }, totalBytes: 100,
      books: [{ path: 'validated.fprpub', hash: 'a'.repeat(64), lifecycle: { publicationId: 'new', formatId: 'epub' } }],
    })
    vi.spyOn(internals.publicationPackages, 'importPackage').mockResolvedValue({ duplicate: false, publication: { id: 'new' } })
    vi.spyOn(internals, 'mergePortableFiles').mockResolvedValue({ merged: {}, deletedPublicationIds: ['old'] })
    const remove = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('file locked'))
    try {
      await expect(service.confirmImport('test')).resolves.toMatchObject({ importedPublications: 1 })
      expect(database.commitPortableMerge).toHaveBeenCalledOnce()
      expect(database.rollbackPortableMerge).not.toHaveBeenCalled()
      expect(library.purgeImportedPublication).not.toHaveBeenCalled()
    } finally { remove.mockRestore() }
  })
  it('preserves the previous backup when the atomic replacement fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-replace-'))
    roots.push(root)
    const destination = path.join(root, 'portable.fprbackup')
    const temporary = path.join(root, 'portable.fprbackup.partial-test')
    fs.writeFileSync(destination, 'previous-good-backup')
    fs.writeFileSync(temporary, 'new-backup')

    const failingRename = vi.fn(async () => { throw new Error('replace denied') })
    await expect(replacePortableBackup(temporary, destination, failingRename)).rejects.toThrow('replace denied')

    expect(fs.readFileSync(destination, 'utf8')).toBe('previous-good-backup')
    expect(fs.readFileSync(temporary, 'utf8')).toBe('new-backup')
  })

  it('exports only the allowlist and merges idempotently into another library', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-'))
    roots.push(root)
    const sourceRoot = path.join(root, 'source')
    const targetRoot = path.join(root, 'target')
    const epubPath = path.join(root, 'fixture.epub')
    fs.writeFileSync(epubPath, await syntheticEpub())

    const sourceDb = await SqliteApplicationRepository.open(sourceRoot, '0.3.0-test')
    const sourceLibrary = new LibraryService(sourceDb, epubFormats(), sourceRoot)
    const imported = await sourceLibrary.importFile(epubPath)
    expect(fs.existsSync(epubPath)).toBe(true)
    expect(fs.existsSync(path.join(sourceRoot, 'library', imported.publication.id, 'source.epub'))).toBe(false)
    sourceDb.savePreferences({ theme: 'dark', fontSize: 23, lineHeight: 1.9, columnWidth: 820, paperTint: 58 })
    sourceDb.saveTranslationPreferences({ providerId: 'openai', modelId: 'gpt-5.4-nano' })
    let libraryState = sourceDb.createLibraryCategory('经济周刊')
    const libraryCategoryId = libraryState.categories[0].id
    sourceDb.renameLibraryPublication(imported.publication.id, '便携书名')
    sourceDb.assignLibraryPublications([imported.publication.id], libraryCategoryId)
    sourceDb.saveLibraryPreferences({ viewMode: 'list', sortBy: 'name', sortDirection: 'asc', activeCategoryId: libraryCategoryId })
    const article = imported.publication.sections[0].articles[0]
    sourceDb.savePosition(imported.publication.id, article.id, 345)
    const detail = sourceDb.getArticle(article.id)
    const paragraph = detail.blocks.find((block) => block.type === 'paragraph')!
    const lookupContext = sourceDb.getLookupContext(article.id, paragraph.id, 'important', 1)
    const lexemeKey = 'lex_en_000000000000000000000000'
    const lexemeDetail: LexemeDetail = {
      lexemeKey, lemma: 'important', phonetic: 'ɪmˈpɔːtənt', briefMeanings: ['重要的'],
      tags: ['cet4'], collins: 4, oxford: true,
      frequency: { bnc: 100, contemporary: 100 }, matchedBy: 'lemma', entries: [], forms: [], collections: [],
    }
    sourceDb.setVocabularyFavorite(lookupContext, lexemeDetail, true)
    const sourceStudy = new SqliteStudyRepository(sourceDb)
    sourceStudy.createPlan({ name: 'Portable study', dailyNewLimit: 20, dailyReviewLimit: 100, sources: [{ type: 'reader_manual', ref: 'favorite' }] })
    for (const source of sourceStudy.activeSources()) sourceStudy.applySourceSnapshot(String(source.source_id), sourceStudy.readerSourceItems())
    let studySession = sourceStudy.openToday()
    studySession = sourceStudy.stageAnswer({ sessionId: studySession.sessionId, itemId: studySession.current!.itemId, expectedVersion: studySession.current!.version, answer: 'known' })
    sourceStudy.commitAnswer({ sessionId: studySession.sessionId, itemId: studySession.current!.itemId, commandId: crypto.randomUUID(), expectedVersion: studySession.current!.version, answer: 'known' })

    const backupPath = path.join(root, 'portable.fprbackup')
    const sourceService = new PortableDataService(sourceDb, sourceLibrary, sourceRoot, '0.3.0-test', () => undefined)
    await sourceService.exportPortable(backupPath)
    const selfPreview = await sourceService.inspectImport(backupPath)
    const selfImport = await sourceService.confirmImport(selfPreview.token)
    expect(selfImport.duplicatePublications).toBe(1)
    expect((sourceDb.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as {count:number}).count).toBe(1)

    const archive = await JSZip.loadAsync(fs.readFileSync(backupPath))
    const names = Object.keys(archive.files).filter((name) => !archive.files[name].dir)
    const manifest = JSON.parse(await archive.file('manifest.json')!.async('text')) as { formatVersion: number }
    expect(manifest.formatVersion).toBe(4)
    expect(names).toContain('manifest.json')
    expect(names).toContain('data/settings.json')
    expect(names).toContain('data/publication-lifecycle.ndjson')
    expect(names).toContain('data/reading-positions.ndjson')
    expect(names).toContain('data/user-lexemes.ndjson')
    expect(names).toContain('data/vocabulary-sources.ndjson')
    expect(names).toContain('data/saved-contexts.ndjson')
    expect(names).toContain('data/study-plans.ndjson')
    expect(names).toContain('data/review-cards.ndjson')
    expect(names).toContain('data/review-events.ndjson')
    expect(names).toContain('data/reinforcement-events.ndjson')
    expect(names).toContain('data/review-suspensions.ndjson')
    expect(names).toContain('data/study-progress-state.ndjson')
    expect(names).toContain('data/study-lexeme-resets.ndjson')
    const packageName = names.find((name) => /^publications\/[a-f0-9]{64}\.fprpub$/.test(name))
    expect(packageName).toBeTruthy()
    const publicationPackage = await JSZip.loadAsync(await archive.file(packageName!)!.async('nodebuffer'))
    const packageNames = Object.keys(publicationPackage.files).filter((name) => !publicationPackage.files[name].dir)
    expect(packageNames).toContain('manifest.json')
    expect(packageNames).toContain('publication.json')
    expect(packageNames.some((name) => /\.epub$|source\.epub$/i.test(name))).toBe(false)
    expect(names.some((name) => /secret|dictionary|translation|context-definitions|sqlite|assets/i.test(name))).toBe(false)
    const settings = JSON.parse(await archive.file('data/settings.json')!.async('text')) as Array<{ key: string }>
    expect(settings.some((setting) => setting.key === 'translation.preferences')).toBe(true)
    expect(settings.some((setting) => setting.key === 'library.management')).toBe(true)
    expect(settings.some((setting) => setting.key.startsWith('library.category.'))).toBe(true)
    expect(settings.some((setting) => setting.key.startsWith('library.item.'))).toBe(true)

    const legacyV2Path = path.join(root, 'portable-v2-compatible.fprbackup')
    fs.writeFileSync(legacyV2Path, await downgradePortableArchiveToV2(archive))
    const legacyTargetRoot = path.join(root, 'legacy-target')
    const legacyTargetDb = await SqliteApplicationRepository.open(legacyTargetRoot, '0.3.0-test')
    const legacyTargetLibrary = new LibraryService(legacyTargetDb, epubFormats(), legacyTargetRoot)
    const legacyTargetService = new PortableDataService(legacyTargetDb, legacyTargetLibrary, legacyTargetRoot, '0.3.0-test', () => undefined)
    const legacyPreview = await legacyTargetService.inspectImport(legacyV2Path)
    await legacyTargetService.confirmImport(legacyPreview.token)
    expect(legacyTargetDb.getLibraryState()).toMatchObject({
      publications: [{ title: '便携书名', categoryId: libraryCategoryId }],
      categories: [{ id: libraryCategoryId, name: '经济周刊' }],
    })
    expect((legacyTargetDb.getConnection().prepare(
      "SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'library.category.%' OR key LIKE 'library.item.%'",
    ).get() as { count: number }).count).toBe(2)
    legacyTargetService.close()
    legacyTargetDb.close()

    // Repack every entry with DEFLATE to verify both ZIP storage modes.
    const repackedArchive = new JSZip()
    for (const name of names) repackedArchive.file(name, await archive.file(name)!.async('uint8array'))
    const repackedBackupPath = path.join(root, 'portable-repacked.fprbackup')
    fs.writeFileSync(repackedBackupPath, await repackedArchive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const targetDb = await SqliteApplicationRepository.open(targetRoot, '0.3.0-test')
    const targetLibrary = new LibraryService(targetDb, epubFormats(), targetRoot)
    const targetService = new PortableDataService(targetDb, targetLibrary, targetRoot, '0.3.0-test', () => undefined)
    const preview = await targetService.inspectImport(repackedBackupPath)
    expect(preview.newPublicationCount).toBe(1)
    expect(preview.vocabularyCount).toBe(1)
    expect(preview.vocabularySourceCount).toBe(2)
    expect(preview.savedContextCount).toBe(1)
    expect(preview.studyPlanCount).toBe(1)
    expect(preview.reviewCardCount).toBe(1)
    expect(preview.reviewEventCount).toBe(1)
    expect(preview.reinforcementEventCount).toBe(0)
    const first = await targetService.confirmImport(preview.token)
    expect(first.importedPublications).toBe(1)
    expect(targetDb.listPublications()).toHaveLength(1)
    expect(targetDb.getPreferences().theme).toBe('dark')
    expect(targetDb.getTranslationPreferences()).toEqual({ providerId: 'openai', modelId: 'gpt-5.4-nano' })
    expect(targetDb.getLibraryState()).toMatchObject({
      publications: [{ title: '便携书名', categoryId: libraryCategoryId }],
      categories: [{ id: libraryCategoryId, name: '经济周刊' }],
      preferences: { viewMode: 'list', sortBy: 'name', sortDirection: 'asc', activeCategoryId: libraryCategoryId },
    })
    expect(targetDb.getArticle(article.id).savedPosition.scrollTop).toBe(345)
    expect(targetDb.listVocabularyFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(1)
    expect(targetDb.listSavedContexts(lexemeKey).total).toBe(1)
    expect(new SqliteStudyRepository(targetDb).listPlans()).toHaveLength(1)
    expect((targetDb.getConnection().prepare('SELECT COUNT(*) AS count FROM review_events').get() as { count: number }).count).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 5))
    sourceDb.setVocabularyFavorite(lookupContext, lexemeDetail, false)
    sourceDb.setVocabularyContext(lookupContext, lexemeDetail, false)
    for (const source of sourceStudy.activeSources()) sourceStudy.applySourceSnapshot(String(source.source_id), sourceStudy.readerSourceItems())
    const tombstonePath = path.join(root, 'portable-tombstones.fprbackup')
    await sourceService.exportPortable(tombstonePath)
    const tombstonePreview = await targetService.inspectImport(tombstonePath)
    expect(tombstonePreview.vocabularySourceCount).toBe(0)
    expect(tombstonePreview.savedContextCount).toBe(0)
    await targetService.confirmImport(tombstonePreview.token)
    expect(targetDb.listVocabularyFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(0)
    expect(targetDb.listSavedContexts(lexemeKey).total).toBe(0)

    const oldPreview = await targetService.inspectImport(repackedBackupPath)
    await targetService.confirmImport(oldPreview.token)
    expect(targetDb.listVocabularyFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(0)
    expect(targetDb.listSavedContexts(lexemeKey).total).toBe(0)

    sourceStudy.setDeveloperMode(true)
    sourceStudy.resetAllProgress('RESET_ALL_STUDY_PROGRESS')
    const resetPath = path.join(root, 'portable-reset.fprbackup')
    await sourceService.exportPortable(resetPath)
    const resetPreview = await targetService.inspectImport(resetPath)
    await targetService.confirmImport(resetPreview.token)
    expect((targetDb.getConnection().prepare('SELECT COUNT(*) count FROM review_cards').get() as { count: number }).count).toBe(0)
    expect((targetDb.getConnection().prepare('SELECT COUNT(*) count FROM review_events').get() as { count: number }).count).toBe(0)

    const secondPreview = await targetService.inspectImport(repackedBackupPath)
    const second = await targetService.confirmImport(secondPreview.token)
    expect(second.importedPublications).toBe(0)
    expect(second.duplicatePublications).toBe(1)
    expect(targetDb.listPublications()).toHaveLength(1)
    expect(targetDb.listVocabularyFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(0)
    expect(targetDb.listSavedContexts(lexemeKey).total).toBe(0)

    targetService.close()
    targetDb.close()
    sourceService.close()
    sourceDb.close()
  })

  it('creates and retains verified migration snapshots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-backup-'))
    roots.push(root)
    const database = await SqliteApplicationRepository.open(root, 'test')
    const now = '2026-07-11T12:00:00.000Z'
    database.getConnection().prepare('INSERT INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)')
      .run('backup.sentinel', 'preserved', now, database.getDeviceId())
    let latest = ''
    for (let index = 0; index < 7; index++) latest = await database.createSafetyBackup(`test-${index}`)
    const backups = fs.readdirSync(path.join(root, 'backups', 'migrations')).filter((name) => name.endsWith('.sqlite'))
    expect(backups).toHaveLength(5)

    const snapshot = new DatabaseSync(latest, { readOnly: true })
    expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(snapshot.prepare("SELECT value FROM app_metadata WHERE key='schema_generation'").get()).toEqual({ value: 'formal-v1' })
    expect(snapshot.prepare("SELECT value FROM app_metadata WHERE key='device_id'").get()).toEqual({ value: database.getDeviceId() })
    expect(snapshot.prepare("SELECT value FROM settings WHERE key='backup.sentinel'").get()).toEqual({ value: 'preserved' })
    expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    snapshot.close()
    database.close()
  })

  it('removes partial migration snapshots when finalization fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-backup-failure-'))
    roots.push(root)
    const database = await SqliteApplicationRepository.open(root, 'test')
    const timestamp = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-07-11T12:34:56.789Z')
    try {
      const destination = await database.createSafetyBackup('collision')
      fs.rmSync(destination)
      fs.mkdirSync(destination)

      await expect(database.createSafetyBackup('collision')).rejects.toThrow()
      expect(fs.existsSync(`${destination}.partial`)).toBe(false)
      expect(fs.existsSync(`${destination}.partial-wal`)).toBe(false)
      expect(fs.existsSync(`${destination}.partial-shm`)).toBe(false)
    } finally {
      timestamp.mockRestore()
      database.close()
    }
  })

  it('rejects traversal entries and backups from a newer format', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-invalid-'))
    roots.push(root)
    const database = await SqliteApplicationRepository.open(path.join(root, 'data'), 'test')
    const library = new LibraryService(database, epubFormats(), path.join(root, 'data'))
    const service = new PortableDataService(database, library, path.join(root, 'data'), 'test', () => undefined)

    const traversal = new JSZip()
    traversal.file('../outside.txt', 'unsafe')
    const traversalPath = path.join(root, 'traversal.fprbackup')
    fs.writeFileSync(traversalPath, await traversal.generateAsync({ type: 'nodebuffer' }))
    await expect(service.inspectImport(traversalPath)).rejects.toThrow()
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false)

    const future = new JSZip()
    future.file('manifest.json', JSON.stringify({
      format: 'foreign-press-reader-portable', formatVersion: 99, appVersion: 'future',
      databaseSchemaVersion: 999, contentIdVersion: 1, createdAt: new Date().toISOString(),
      policy: 'essential-user-data', files: [], counts: {},
    }))
    const futurePath = path.join(root, 'future.fprbackup')
    fs.writeFileSync(futurePath, await future.generateAsync({ type: 'nodebuffer' }))
    await expect(service.inspectImport(futurePath)).rejects.toThrow('更高版本')

    const legacy = new JSZip()
    legacy.file('manifest.json', JSON.stringify({
      format: 'foreign-press-reader-portable', formatVersion: 1, appVersion: 'legacy',
      databaseSchemaVersion: 1, contentIdVersion: 2, createdAt: new Date().toISOString(),
      policy: 'essential-user-data', files: [], counts: {},
    }))
    const legacyPath = path.join(root, 'legacy-v1.fprbackup')
    fs.writeFileSync(legacyPath, await legacy.generateAsync({ type: 'nodebuffer' }))
    await expect(service.inspectImport(legacyPath)).rejects.toThrow('不受支持')

    const safeEmptyPath = path.join(root, 'safe-empty.fprbackup')
    await service.exportPortable(safeEmptyPath)
    const unsafeArchive = await JSZip.loadAsync(fs.readFileSync(safeEmptyPath))
    const unsafeLifecycle = JSON.stringify({
      publicationId: '../../outside',
      contentHash: 'a'.repeat(64),
      formatId: 'epub',
      titleSnapshot: 'Unsafe',
      state: 'deleted',
      changedAt: '2026-07-31T00:00:00.000Z',
      deviceId: 'unsafe-device',
    })
    unsafeArchive.file('data/publication-lifecycle.ndjson', `${unsafeLifecycle}\n`)
    const unsafeManifest = JSON.parse(await unsafeArchive.file('manifest.json')!.async('text')) as {
      files: Array<{ path: string; size: number; sha256: string }>
    }
    unsafeManifest.files = unsafeManifest.files.map((file) => file.path === 'data/publication-lifecycle.ndjson' ? {
      ...file,
      size: Buffer.byteLength(`${unsafeLifecycle}\n`),
      sha256: createHash('sha256').update(`${unsafeLifecycle}\n`).digest('hex'),
    } : file)
    unsafeArchive.file('manifest.json', JSON.stringify(unsafeManifest))
    const unsafePath = path.join(root, 'unsafe-publication-id.fprbackup')
    fs.writeFileSync(unsafePath, await unsafeArchive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    await expect(service.inspectImport(unsafePath)).rejects.toThrow('刊物生命周期')

    const demoV4 = new JSZip()
    demoV4.file('manifest.json', JSON.stringify({
      format: 'foreign-press-reader-portable', formatVersion: 99, appVersion: '0.5.6',
      databaseSchemaVersion: 1, contentIdVersion: 2, createdAt: new Date().toISOString(),
      policy: 'essential-user-data', files: [], counts: {},
    }))
    const demoV4Path = path.join(root, 'demo-v4.fprbackup')
    fs.writeFileSync(demoV4Path, await demoV4.generateAsync({ type: 'nodebuffer' }))
    await expect(service.inspectImport(demoV4Path)).rejects.toThrow('更高版本')

    service.close()
    database.close()
  })

  it.each([5, 6, 7])('rejects the Demo v%i portable format', async (version) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `reader-portable-v${version}-`))
    roots.push(root)
    const backupPath = path.join(root, `demo-v${version}.fprbackup`)
    fs.writeFileSync(backupPath, await emptyDemoBackup(version))
    const dataRoot = path.join(root, 'data')
    const database = await SqliteApplicationRepository.open(dataRoot, 'test')
    const library = new LibraryService(database, epubFormats(), dataRoot)
    const service = new PortableDataService(database, library, dataRoot, 'test', () => undefined)
    await expect(service.inspectImport(backupPath)).rejects.toThrow('更高版本')
    service.close()
    database.close()
  })

  it('keeps publication deletion tombstones from being undone by an older backup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-portable-publication-delete-'))
    roots.push(root)
    const sourceRoot = path.join(root, 'source')
    const targetRoot = path.join(root, 'target')
    const epubPath = path.join(root, 'fixture.epub')
    fs.writeFileSync(epubPath, await syntheticEpub())
    const sourceDb = await SqliteApplicationRepository.open(sourceRoot, 'test')
    const sourceLibrary = new LibraryService(sourceDb, epubFormats(), sourceRoot)
    const imported = await sourceLibrary.importFile(epubPath)
    const sourceService = new PortableDataService(sourceDb, sourceLibrary, sourceRoot, 'test', () => undefined)
    const beforeDelete = path.join(root, 'before-delete.fprbackup')
    await sourceService.exportPortable(beforeDelete)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await sourceLibrary.removeImportedPublication(imported.publication.id)
    const afterDelete = path.join(root, 'after-delete.fprbackup')
    await sourceService.exportPortable(afterDelete)

    const targetDb = await SqliteApplicationRepository.open(targetRoot, 'test')
    const targetLibrary = new LibraryService(targetDb, epubFormats(), targetRoot)
    const targetService = new PortableDataService(targetDb, targetLibrary, targetRoot, 'test', () => undefined)
    let preview = await targetService.inspectImport(beforeDelete)
    await targetService.confirmImport(preview.token)
    expect(targetDb.listPublications()).toHaveLength(1)
    preview = await targetService.inspectImport(afterDelete)
    await targetService.confirmImport(preview.token)
    expect(targetDb.listPublications()).toHaveLength(0)
    expect(targetDb.getPublicationLifecycle(imported.publication.id)?.state).toBe('deleted')
    preview = await targetService.inspectImport(beforeDelete)
    expect(preview.newPublicationCount).toBe(0)
    await targetService.confirmImport(preview.token)
    expect(targetDb.listPublications()).toHaveLength(0)

    targetService.close(); targetDb.close(); sourceService.close(); sourceDb.close()
  })
})

async function emptyDemoBackup(version: number): Promise<Buffer> {
  const zip = new JSZip()
  const files = [
    ['data/settings.json', '[]', 'settings'],
    ['data/reading-positions.ndjson', '', 'reading-positions'],
    ['data/user-lexemes.ndjson', '', 'user-lexemes'],
    ['data/vocabulary-sources.ndjson', '', 'vocabulary-sources'],
    ['data/saved-contexts.ndjson', '', 'saved-contexts'],
    ['data/study-plans.ndjson', '', 'study-plans'],
    ['data/study-plan-sources.ndjson', '', 'study-plan-sources'],
    ['data/study-plan-origins.ndjson', '', 'study-plan-origins'],
    ['data/study-plan-exclusions.ndjson', '', 'study-plan-exclusions'],
    ['data/scheduler-profiles.ndjson', '', 'scheduler-profiles'],
    ['data/review-cards.ndjson', '', 'review-cards'],
    ['data/review-events.ndjson', '', 'review-events'],
    ['data/reinforcement-events.ndjson', '', 'reinforcement-events'],
    ['data/review-suspensions.ndjson', '', 'review-suspensions'],
    ['data/study-progress-state.ndjson', '', 'study-progress-state'],
  ] as const
  for (const [name, body] of files) zip.file(name, body)
  zip.file('manifest.json', JSON.stringify({
    format: 'foreign-press-reader-portable', formatVersion: version, appVersion: '0.8.8',
    databaseSchemaVersion: 2, contentIdVersion: 2, createdAt: '2026-07-10T00:00:00.000Z',
    policy: 'essential-user-data',
    files: files.map(([name, body, kind]) => ({
      path: name, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), kind,
    })),
    counts: { publications:0,settings:0,readingPositions:0,vocabulary:0,vocabularySources:0,savedContexts:0,studyPlans:0,reviewCards:0,reviewEvents:0,reinforcementEvents:0,reviewSuspensions:0 },
  }))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function downgradePortableArchiveToV2(source: JSZip): Promise<Buffer> {
  const destination = new JSZip()
  const manifest = JSON.parse(await source.file('manifest.json')!.async('text')) as {
    formatVersion: number
    databaseSchemaVersion: number
    files: Array<{ path: string; size: number; sha256: string; kind: string }>
    counts: Record<string, number>
  }
  const settings = JSON.parse(await source.file('data/settings.json')!.async('text')) as Array<{ key: string }>
  const legacySettings = JSON.stringify(settings.filter((setting) => (
    !setting.key.startsWith('library.category.') && !setting.key.startsWith('library.item.')
  )))
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir || name === 'manifest.json' || name === 'data/settings.json' || name === 'data/reader-records.ndjson') continue
    destination.file(name, await entry.async('uint8array'))
  }
  destination.file('data/settings.json', legacySettings)
  delete manifest.counts.readerRecords
  manifest.files = manifest.files.filter(file=>file.path!=='data/reader-records.ndjson')
  manifest.formatVersion = 2
  manifest.databaseSchemaVersion = 2
  manifest.counts.settings = JSON.parse(legacySettings).length
  manifest.files = manifest.files.map((file) => file.path === 'data/settings.json' ? {
    ...file,
    size: Buffer.byteLength(legacySettings),
    sha256: createHash('sha256').update(legacySettings).digest('hex'),
  } : file)
  destination.file('manifest.json', JSON.stringify(manifest))
  return destination.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function syntheticEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Portable Weekly</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="section" href="section.xhtml" media-type="application/xhtml+xml"/><item id="article" href="article.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="section"/><itemref idref="article"/></spine></package>`)
  zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="section.xhtml">Leaders</a><ol><li><a href="article.xhtml">Portable article</a></li></ol></li></ol></nav></body></html>`)
  zip.file('EPUB/section.xhtml', '<html><body><h2 class="te_section_title">Leaders</h2></body></html>')
  zip.file('EPUB/article.xhtml', `<html><head><title>Portable article</title></head><body><h1 class="te_article_title">Portable article</h1><p>This important paragraph contains enough English words to be treated as readable editorial article content.</p><p>The second paragraph keeps the portable backup fixture representative and stable across repeated imports.</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function epubFormats(): PublicationFormatRegistry {
  return new PublicationFormatRegistry([{
    id: 'epub', name: 'EPUB 电子刊物', extensions: ['epub'],
    maxBytes: 500 * 1024 * 1024, importer: new EpubImporter(),
  }])
}
