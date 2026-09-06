import { publicationContentHash } from './publication-content'
import { repairPublication } from './publication-repair'
import type { SyncEntityRef } from '../core/sync-model'
import { ReaderRepository } from './reader-repository'
import type { ArticleReadingChange, ArticleSearchQuery } from '../shared/reader-types'
import type { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import type {
  ArticleDetail,
  ArticleSummary,
  ContextDefinition,
  DictionaryPreferences,
  DictionaryExample,
  LibraryCategory,
  LibraryPreferences,
  LibraryState,
  ParsedPublication,
  ParsedPublicationPlan,
  PublicationDetail,
  PublicationSummary,
  ReaderPreferences,
  ReadingPositionInput,
  SpeechPreferences,
  TranslationPreferences,
  SectionSummary,
  LexemeKey,
  LexemeDetail,
  ManualLearningState,
  ReaderVocabularyState,
  SavedContextPage,
  VocabularyListPage,
  VocabularyListQuery,
} from '../shared/types'
import { normalizeEnglishWord, sentenceAroundToken, tokenizeEnglish } from '../shared/word-utils'
import { savedContextIdentity, vocabularySourceIdentity } from './migrations'
import type {
  PortableBookRecord,
  PortableDatasetKey,
  PortableDatasetRecord,
  PortableMergeResult,
  PortablePublicationLifecycleRecord,
  PortableMergePolicy,
  PortableUserData,
} from '../core/portable-data'
import { compareVersionedRecord } from '../core/portable-data'
import {
  createDefaultTranslationProviderRegistry,
  translationCacheModel,
} from '../core/translation-providers'
import { TRANSLATION_PROMPT_VERSION } from '../core/translation-service'
import { createDefaultSpeechProviderRegistry } from '../core/speech-providers'
import type { VocabularyContext } from '../core/lexicon/ports'
import { AppDatabase } from './sqlite-database'
import { writeLibraryManagementSettings } from './library-sync-settings'
import { PortableSqliteRepository } from './portable-database'
import type { LibrarySyncDataMode } from './portable-database'

type Row = Record<string, unknown>

const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: 'light',
  fontSize: 20,
  lineHeight: 1.8,
  columnWidth: 760,
  paperTint: 58,
}

const DEFAULT_DICTIONARY_PREFERENCES: DictionaryPreferences = {
  enabled: true,
  lookupProviderId: 'ecdict',
  fallbackToLocal: true,
  contextExplanationEnabled: true,
  translateExamples: false,
}

interface LibraryItemManagement {
  customTitle: string | null
  categoryId: string | null
}

interface LibraryManagementRecord extends LibraryPreferences {
  categories: LibraryCategory[]
  items: Record<string, LibraryItemManagement>
}

const DEFAULT_LIBRARY_MANAGEMENT: LibraryManagementRecord = {
  viewMode: 'grid',
  sortBy: 'importedAt',
  sortDirection: 'desc',
  activeCategoryId: 'all',
  categories: [],
  items: {},
}

const translationProviders = createDefaultTranslationProviderRegistry()
const speechProviders = createDefaultSpeechProviderRegistry()

export class SqliteApplicationRepository {
  private readonly db: DatabaseSync
  private readonly portable: PortableSqliteRepository
  private constructor(private readonly database: AppDatabase) {
    this.db = database.connection
    this.portable = new PortableSqliteRepository(this.db)
  }

  static async open(userDataPath: string, appVersion = '0.0.0'): Promise<SqliteApplicationRepository> {
    return new SqliteApplicationRepository(await AppDatabase.open(userDataPath, appVersion))
  }

  async createSafetyBackup(label = 'manual'): Promise<string> {
    return this.database.createSafetyBackup(label)
  }

  close(): void { this.database.close() }
  getConnection(): DatabaseSync { return this.db }
  getDeviceId(): string { return this.database.deviceId }
  private get deviceId(): string { return this.database.deviceId }

  getSchemaStatus(): { schemaVersion: number; publicationCount: number; vocabularyCount: number } {
    const publications = this.db.prepare('SELECT COUNT(*) AS count FROM publications').get() as Row
    return {
      schemaVersion: this.database.schemaVersion,
      publicationCount: Number(publications.count ?? 0),
      vocabularyCount: this.getVocabularyCount(),
    }
  }

  listPortableBooks(): PortableBookRecord[] {
    return this.portable.listPortableBooks()
  }

  getParsedPublicationPlan(publicationId: string, assetPaths: string[]): ParsedPublicationPlan {
    return this.portable.getParsedPublicationPlan(publicationId, assetPaths)
  }

  exportPortableUserData(selection?: readonly Pick<SyncEntityRef, 'type' | 'key'>[]): PortableUserData {
    return this.portable.exportPortableUserData(selection)
  }

  iteratePortableDataset(dataset: PortableDatasetKey): Iterable<PortableDatasetRecord> {
    return this.portable.iteratePortableDataset(dataset)
  }

  mergePortableUserData(
    data: Pick<PortableUserData, 'settings' | 'readingPositions' | 'userLexemes' | 'vocabularySources' | 'savedContexts'>
      & Partial<Omit<PortableUserData, 'settings' | 'readingPositions' | 'userLexemes' | 'vocabularySources' | 'savedContexts'>>,
    policy: PortableMergePolicy = 'newer-wins',
    manageTransaction = true,
    finalizeStudy = true,
    librarySyncMode: LibrarySyncDataMode = 'auto',
  ): PortableMergeResult {
    return this.portable.mergePortableUserData(data, policy, manageTransaction, finalizeStudy, librarySyncMode)
  }

  beginPortableMerge(): void { this.portable.beginPortableMerge() }
  commitPortableMerge(): void { this.portable.commitPortableMerge() }
  rollbackPortableMerge(): void { this.portable.rollbackPortableMerge() }

  applyIncomingSyncData(
    data: Parameters<SqliteApplicationRepository['mergePortableUserData']>[0],
    receipt: { senderDeviceId: string; batchId: string; payloadSha256: string; senderThroughRevision: number },
    librarySyncMode: LibrarySyncDataMode,
  ): PortableMergeResult {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const merged = this.mergePortableUserData(data, 'incoming-wins', false, true, librarySyncMode)
      this.saveSyncReceipt(receipt.senderDeviceId, receipt.batchId, receipt.payloadSha256, receipt.senderThroughRevision)
      const peer = this.getSyncPeerState(receipt.senderDeviceId)
      this.saveSyncPeerState(receipt.senderDeviceId, {
        outboundAckedRevision: peer?.outboundAckedRevision ?? 0,
        inboundAppliedRevision: Math.max(peer?.inboundAppliedRevision ?? 0, receipt.senderThroughRevision),
        peerInspectedRevision: peer?.peerInspectedRevision ?? 0,
      })
      this.db.exec('COMMIT')
      return merged
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }


  getSyncRevision(): number {
    const row = this.db.prepare('SELECT current_revision FROM sync_clock WHERE singleton=1').get() as Row | undefined
    return Number(row?.current_revision ?? 0)
  }

  listSyncEntityRevisions(afterRevision = 0): Array<{ entityType: string; entityKey: string; revision: number }> {
    return (this.db.prepare(`
      SELECT entity_type,entity_key,revision FROM sync_entity_revisions
      WHERE revision>? ORDER BY revision,entity_type,entity_key
    `).all(Math.max(0, Math.trunc(afterRevision))) as Row[]).map((row) => ({
      entityType: String(row.entity_type), entityKey: String(row.entity_key), revision: Number(row.revision),
    }))
  }

  getSyncPeerState(peerDeviceId: string): { outboundAckedRevision: number; inboundAppliedRevision: number; peerInspectedRevision: number } | null {
    const row = this.db.prepare('SELECT * FROM sync_peer_state WHERE peer_device_id=?').get(peerDeviceId) as Row | undefined
    return row ? {
      outboundAckedRevision: Number(row.outbound_acked_revision),
      inboundAppliedRevision: Number(row.inbound_applied_revision),
      peerInspectedRevision: Number(row.peer_inspected_revision),
    } : null
  }

  saveSyncPeerState(peerDeviceId: string, value: { outboundAckedRevision: number; inboundAppliedRevision: number; peerInspectedRevision: number }): void {
    this.db.prepare(`
      INSERT INTO sync_peer_state(peer_device_id,outbound_acked_revision,inbound_applied_revision,peer_inspected_revision,last_sync_at)
      VALUES(?,?,?,?,?) ON CONFLICT(peer_device_id) DO UPDATE SET
        outbound_acked_revision=excluded.outbound_acked_revision,
        inbound_applied_revision=excluded.inbound_applied_revision,
        peer_inspected_revision=excluded.peer_inspected_revision,last_sync_at=excluded.last_sync_at
    `).run(peerDeviceId, value.outboundAckedRevision, value.inboundAppliedRevision, value.peerInspectedRevision, new Date().toISOString())
  }

  hasSyncReceipt(senderDeviceId: string, batchId: string, payloadSha256: string): boolean {
    const row = this.db.prepare('SELECT payload_sha256 FROM sync_receipts WHERE sender_device_id=? AND batch_id=?')
      .get(senderDeviceId, batchId) as Row | undefined
    if (!row) return false
    if (String(row.payload_sha256) !== payloadSha256) throw new Error('同步批次标识与内容不一致')
    return true
  }

  saveSyncReceipt(senderDeviceId: string, batchId: string, payloadSha256: string, senderThroughRevision: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO sync_receipts(sender_device_id,batch_id,payload_sha256,sender_through_revision,applied_at)
      VALUES(?,?,?,?,?)
    `).run(senderDeviceId, batchId, payloadSha256, senderThroughRevision, new Date().toISOString())
  }

  findPublicationIdByHash(hash: string): string | null {
    const row = this.db.prepare('SELECT id FROM publications WHERE hash = ?').get(hash) as Row | undefined
    return row ? String(row.id) : null
  }

  listRetainedPublicationSources(): import('../core/ports').PublicationSourceCleanupCandidate[] {
    const publications = this.db.prepare(`
      SELECT p.id,p.hash,p.source_path,p.article_count,p.section_count,
        (SELECT COUNT(*) FROM articles a WHERE a.publication_id=p.id) AS actual_article_count,
        (SELECT COUNT(*) FROM sections s WHERE s.publication_id=p.id) AS actual_section_count
      FROM publications p WHERE p.source_storage='retained' ORDER BY p.imported_at
    `).all() as Row[]
    const assetRows = this.db.prepare(`
      SELECT cover_path AS asset_path FROM publications WHERE id=? AND cover_path IS NOT NULL
      UNION
      SELECT b.asset_path FROM blocks b JOIN articles a ON a.id=b.article_id
      WHERE a.publication_id=? AND b.asset_path IS NOT NULL
    `)
    return publications.map((row) => ({
      publicationId: String(row.id),
      contentHash: String(row.hash),
      sourcePath: String(row.source_path),
      expectedArticleCount: Number(row.article_count),
      actualArticleCount: Number(row.actual_article_count),
      expectedSectionCount: Number(row.section_count),
      actualSectionCount: Number(row.actual_section_count),
      referencedAssetPaths: (assetRows.all(String(row.id), String(row.id)) as Row[])
        .map((asset) => String(asset.asset_path)),
    }))
  }

  markPublicationParsedOnly(publicationId: string): void {
    this.db.prepare(`
      UPDATE publications SET source_path='',source_storage='parsed-only'
      WHERE id=? AND source_storage='retained'
    `).run(publicationId)
  }

  getPublicationLifecycleByHash(hash: string): PortablePublicationLifecycleRecord | null {
    const row = this.db.prepare('SELECT * FROM publication_lifecycle WHERE content_hash=?').get(hash) as Row | undefined
    return row ? {
      publicationId:String(row.publication_id),contentHash:String(row.content_hash),formatId:String(row.format_id),
      titleSnapshot:String(row.title_snapshot),state:String(row.state) as 'present'|'deleted',changedAt:String(row.changed_at),deviceId:String(row.device_id),
    } : null
  }

  getPublicationLifecycle(publicationId: string): PortablePublicationLifecycleRecord | null {
    const row = this.db.prepare('SELECT * FROM publication_lifecycle WHERE publication_id=?').get(publicationId) as Row | undefined
    return row ? {
      publicationId:String(row.publication_id),contentHash:String(row.content_hash),formatId:String(row.format_id),
      titleSnapshot:String(row.title_snapshot),state:String(row.state) as 'present'|'deleted',changedAt:String(row.changed_at),deviceId:String(row.device_id),
    } : null
  }

  shouldAcceptPublicationLifecycle(record: PortablePublicationLifecycleRecord, policy: PortableMergePolicy = 'newer-wins'): boolean {
    const current = this.getPublicationLifecycle(record.publicationId) ?? this.getPublicationLifecycleByHash(record.contentHash)
    if (!current) return true
    if (policy === 'incoming-wins') return true
    return compareVersionedRecord({updatedAt:record.changedAt,deviceId:record.deviceId},{updatedAt:current.changedAt,deviceId:current.deviceId})>0
  }

  clearPublicationLifecycleForRestore(publicationId: string): void {
    this.db.prepare('DELETE FROM publication_lifecycle WHERE publication_id=?').run(publicationId)
  }

  deletePublication(id: string): void {
    this.deletePublications([id])
  }

  deletePublications(ids: string[]): void {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return
    const management = this.getLibraryManagement()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = new Date().toISOString()
      const lifecycle = this.db.prepare(`
        INSERT INTO publication_lifecycle(publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id)
        VALUES(?,?,'epub',?,'deleted',?,?)
        ON CONFLICT(publication_id) DO UPDATE SET content_hash=excluded.content_hash,title_snapshot=excluded.title_snapshot,
          state='deleted',changed_at=excluded.changed_at,device_id=excluded.device_id
      `)
      const statement = this.db.prepare('DELETE FROM publications WHERE id = ?')
      for (const id of unique) {
        const publication = this.db.prepare('SELECT hash,title FROM publications WHERE id=?').get(id) as Row | undefined
        if (!publication) continue
        const existing = this.db.prepare('SELECT format_id FROM publication_lifecycle WHERE publication_id=?').get(id) as Row | undefined
        lifecycle.run(id, String(publication.hash), String(publication.title), now, this.deviceId)
        if (existing?.format_id && String(existing.format_id) !== 'epub') {
          this.db.prepare('UPDATE publication_lifecycle SET format_id=? WHERE publication_id=?').run(String(existing.format_id), id)
        }
        statement.run(id)
        delete management.items[id]
      }
      this.writeLibraryManagement(management)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  purgePublications(ids: string[]): void {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const removePublication = this.db.prepare('DELETE FROM publications WHERE id=?')
      const removeLifecycle = this.db.prepare('DELETE FROM publication_lifecycle WHERE publication_id=?')
      for (const id of unique) { removePublication.run(id); removeLifecycle.run(id) }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  savePublication(parsed: ParsedPublication, formatId = 'epub', firstImportedAt?: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const importedAt = normalizeImportedAt(firstImportedAt)
      const articleCount = parsed.sections.reduce((sum, section) => sum + section.articles.length, 0)
        + parsed.unsectionedArticles.length
      this.db.prepare(`
        INSERT INTO publications
          (id, hash, source_key, profile_id, title, creator, language, cover_path, source_path, imported_at, article_count, section_count, source_storage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'parsed-only')
      `).run(
        parsed.id,
        parsed.hash,
        parsed.sourceKey,
        parsed.profileId,
        parsed.title,
        parsed.creator,
        parsed.language,
        parsed.coverPath,
        importedAt,
        articleCount,
        parsed.sections.length,
      )

      const sectionStatement = this.db.prepare(
        'INSERT INTO sections (id, publication_id, source_key, title, position) VALUES (?, ?, ?, ?, ?)',
      )
      const articleStatement = this.db.prepare(`
        INSERT INTO articles
          (id, publication_id, section_id, source_key, title, rubric, published_at, position, source_href)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const blockStatement = this.db.prepare(`
        INSERT INTO blocks
          (id, article_id, source_key, type, position, text, html, asset_path, alt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const saveArticle = (article: ParsedPublication['unsectionedArticles'][number], sectionId: string | null) => {
        articleStatement.run(
          article.id,
          parsed.id,
          sectionId,
          article.sourceKey,
          article.title,
          article.rubric,
          article.publishedAt,
          article.position,
          article.sourceHref,
        )
        for (const block of article.blocks) {
          blockStatement.run(
            block.id,
            article.id,
            block.sourceKey,
            block.type,
            block.position,
            block.text,
            block.html,
            block.assetPath,
            block.alt,
          )
        }
      }

      for (const section of parsed.sections) {
        sectionStatement.run(section.id, parsed.id, section.sourceKey, section.title, section.position)
        for (const article of section.articles) saveArticle(article, section.id)
      }
      for (const article of parsed.unsectionedArticles) saveArticle(article, null)
      this.db.prepare(`
        INSERT INTO publication_lifecycle(publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id)
        VALUES(?,?,?,?, 'present',?,?) ON CONFLICT(publication_id) DO UPDATE SET
          content_hash=excluded.content_hash,format_id=excluded.format_id,title_snapshot=excluded.title_snapshot,
          state='present',changed_at=excluded.changed_at,device_id=excluded.device_id
      `).run(parsed.id, parsed.hash, formatId, parsed.title, importedAt, this.deviceId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  repairPublication(plan: ParsedPublicationPlan): boolean { return repairPublication(this.db,plan, this.deviceId) }
  getArticleTitle(id: string): string | null {
    const row = this.db.prepare('SELECT title FROM articles WHERE id=?').get(id)
    return typeof row?.title === 'string' ? row.title : null
  }
  getPublicationContentHash(id: string): string { return publicationContentHash(this.db,id) }

  listPublications(): PublicationSummary[] {
    const management = this.getLibraryManagement()
    const rows = this.db.prepare(`
      SELECT p.*, min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) AS effective_imported_at,
        rp.article_id AS last_article_id
      FROM publications p
      LEFT JOIN publication_lifecycle l ON l.publication_id=p.id AND l.state='present'
      LEFT JOIN reading_positions rp ON rp.publication_id = p.id
      ORDER BY p.imported_at DESC
    `).all() as Row[]
    return rows.map((row) => this.publicationSummary(row, management))
  }

  getLibraryState(): LibraryState {
    const management = this.getLibraryManagement()
    return {
      publications: (this.db.prepare(`
        SELECT p.*, min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) AS effective_imported_at,
          rp.article_id AS last_article_id
        FROM publications p
        LEFT JOIN publication_lifecycle l ON l.publication_id=p.id AND l.state='present'
        LEFT JOIN reading_positions rp ON rp.publication_id = p.id
        ORDER BY p.imported_at DESC
      `).all() as Row[]).map((row) => this.publicationSummary(row, management)),
      categories: management.categories,
      preferences: libraryPreferencesOf(management),
    }
  }

  saveLibraryPreferences(preferences: LibraryPreferences): LibraryState {
    const management = this.getLibraryManagement()
    management.viewMode = preferences.viewMode === 'list' ? 'list' : 'grid'
    management.sortBy = preferences.sortBy === 'name' ? 'name' : 'importedAt'
    management.sortDirection = preferences.sortDirection === 'asc' ? 'asc' : 'desc'
    management.activeCategoryId = normalizeActiveCategory(preferences.activeCategoryId, management.categories)
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  createLibraryCategory(name: string): LibraryState {
    const management = this.getLibraryManagement()
    const normalized = normalizeLibraryName(name, '分类名称')
    assertUniqueCategoryName(management.categories, normalized)
    management.categories.push({
      id: `category_${crypto.randomUUID().replaceAll('-', '')}`,
      name: normalized,
      createdAt: new Date().toISOString(),
    })
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  renameLibraryCategory(categoryId: string, name: string): LibraryState {
    const management = this.getLibraryManagement()
    const category = management.categories.find((item) => item.id === categoryId)
    if (!category) throw new Error('未找到该分类')
    const normalized = normalizeLibraryName(name, '分类名称')
    assertUniqueCategoryName(management.categories, normalized, categoryId)
    category.name = normalized
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  deleteLibraryCategory(categoryId: string): LibraryState {
    const management = this.getLibraryManagement()
    if (!management.categories.some((item) => item.id === categoryId)) throw new Error('未找到该分类')
    management.categories = management.categories.filter((item) => item.id !== categoryId)
    for (const item of Object.values(management.items)) {
      if (item.categoryId === categoryId) item.categoryId = null
    }
    if (management.activeCategoryId === categoryId) management.activeCategoryId = 'all'
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  renameLibraryPublication(publicationId: string, title: string): LibraryState {
    const publication = this.db.prepare('SELECT title FROM publications WHERE id = ?').get(publicationId) as Row | undefined
    if (!publication) throw new Error('未找到该刊物')
    const normalized = title.trim().replace(/\s+/g, ' ').slice(0, 200)
    if (!normalized) throw new Error('书名不能为空')
    const management = this.getLibraryManagement()
    const current = management.items[publicationId] ?? { customTitle: null, categoryId: null }
    current.customTitle = normalized === String(publication.title) ? null : normalized
    management.items[publicationId] = current
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  assignLibraryPublications(publicationIds: string[], categoryId: string | null): LibraryState {
    const unique = [...new Set(publicationIds)]
    if (unique.length === 0) throw new Error('请先选择书籍')
    const management = this.getLibraryManagement()
    if (categoryId && !management.categories.some((item) => item.id === categoryId)) throw new Error('未找到该分类')
    const exists = this.db.prepare('SELECT 1 FROM publications WHERE id = ?')
    for (const publicationId of unique) {
      if (!exists.get(publicationId)) throw new Error('选择中包含不存在的刊物')
      const current = management.items[publicationId] ?? { customTitle: null, categoryId: null }
      current.categoryId = categoryId
      management.items[publicationId] = current
    }
    this.writeLibraryManagement(management)
    return this.getLibraryState()
  }

  getPublication(id: string): PublicationDetail {
    const management = this.getLibraryManagement()
    const row = this.db.prepare(`
      SELECT p.*, min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) AS effective_imported_at,
        rp.article_id AS last_article_id
      FROM publications p
      LEFT JOIN publication_lifecycle l ON l.publication_id=p.id AND l.state='present'
      LEFT JOIN reading_positions rp ON rp.publication_id = p.id
      WHERE p.id = ?
    `).get(id) as Row | undefined
    if (!row) throw new Error('未找到该刊物')

    const sectionRows = this.db.prepare(
      'SELECT * FROM sections WHERE publication_id = ? ORDER BY position',
    ).all(id) as Row[]
    const articleRows = this.db.prepare(`
      SELECT a.*, COUNT(b.id) AS block_count
      FROM articles a LEFT JOIN blocks b ON b.article_id = a.id
      WHERE a.publication_id = ?
      GROUP BY a.id ORDER BY a.position
    `).all(id) as Row[]
    const articles = articleRows.map((article) => this.articleSummary(article))
    const sections: SectionSummary[] = sectionRows.map((section) => ({
      id: String(section.id),
      title: String(section.title),
      position: Number(section.position),
      articles: articles.filter((article) => article.sectionId === String(section.id)),
    }))

    return {
      ...this.publicationSummary(row, management),
      sections,
      unsectionedArticles: articles.filter((article) => article.sectionId === null),
    }
  }

  private get reading(): ReaderRepository { return new ReaderRepository(this.db, this.deviceId) }
  searchArticles(query: ArticleSearchQuery) { return this.reading.search(query) }
  getReadingData(articleId: string) { return this.reading.get(articleId) }
  changeReadingData(articleId: string, change: ArticleReadingChange) { return this.reading.change(articleId, change) }
  preserveTranslations(articleId: string) { return this.reading.preserveTranslations(articleId) }

  getArticle(id: string): ArticleDetail {
    const selected = this.reading.selectedTranslations(id)
    const { provider, model } = translationProviders.resolve(this.getTranslationPreferences())
    const cacheModel = translationCacheModel(provider, model)
    const row = this.db.prepare(`
      SELECT a.*, p.title AS publication_title, s.title AS section_title,
             rp.scroll_top AS saved_scroll_top, rp.anchor_block_id AS saved_anchor_block_id,
             rp.anchor_token_index AS saved_anchor_token_index, rp.anchor_fraction AS saved_anchor_fraction
      FROM articles a
      JOIN publications p ON p.id = a.publication_id
      LEFT JOIN sections s ON s.id = a.section_id
      LEFT JOIN reading_positions rp ON rp.publication_id = a.publication_id
        AND rp.article_id = a.id
      WHERE a.id = ?
    `).get(id) as Row | undefined
    if (!row) throw new Error('未找到该文章')

    const blocks = this.db.prepare(`
      SELECT b.* FROM blocks b WHERE b.article_id = ? ORDER BY b.position
    `).all(id) as Row[]
    const findTranslation = this.db.prepare(`
      SELECT text FROM translations
      WHERE block_id = ? AND source_hash = ? AND target_language = 'zh-CN'
      ORDER BY (model = ? AND prompt_version = ?) DESC, created_at DESC LIMIT 1
    `)

    return {
      ...this.articleSummary({ ...row, block_count: blocks.length }),
      publicationId: String(row.publication_id),
      publicationTitle: this.libraryTitle(String(row.publication_id), String(row.publication_title)),
      sectionTitle: row.section_title == null ? null : String(row.section_title),
      savedPosition: this.reading.position(id) ?? {
        scrollTop: Number(row.saved_scroll_top ?? 0),
        anchorBlockId: row.saved_anchor_block_id == null ? null : String(row.saved_anchor_block_id),
        anchorTokenIndex: row.saved_anchor_token_index == null ? null : Number(row.saved_anchor_token_index),
        anchorFraction: Number(row.saved_anchor_fraction ?? 0),
      },
      blocks: blocks.map((block) => {
        const text = block.text == null ? null : String(block.text)
        const translation = text == null ? undefined : findTranslation.get(
          String(block.id),
          hashText(text),
          cacheModel,
          TRANSLATION_PROMPT_VERSION,
        ) as Row | undefined
        return {
          id: String(block.id),
          type: block.type as ArticleDetail['blocks'][number]['type'],
          position: Number(block.position),
          text,
          html: block.html == null ? null : String(block.html),
          assetUrl: block.asset_path == null
            ? null
            : `reader-asset://asset/${encodeURIComponent(String(row.publication_id))}/${String(block.asset_path).split('/').map(encodeURIComponent).join('/')}`,
          alt: block.alt == null ? null : String(block.alt),
          translation: selected ? (selected.get(String(block.id))?.sourceHash === hashText(text ?? '') ? selected.get(String(block.id))!.text : null) : translation?.text == null ? null : String(translation.text),
        }
      }),
    }
  }

  getTranslatableBlocks(articleId: string): Array<{ id: string; type: string; text: string; sourceHash: string }> {
    const rows = this.db.prepare(`
      SELECT id, type, text FROM blocks
      WHERE article_id = ? AND text IS NOT NULL AND trim(text) <> '' AND type <> 'image'
      ORDER BY position
    `).all(articleId) as Row[]
    return rows.map((row) => {
      const text = String(row.text)
      return { id: String(row.id), type: String(row.type), text, sourceHash: hashText(text) }
    })
  }

  hasTranslation(blockId: string, sourceHash: string, model: string, promptVersion: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM translations
      WHERE block_id = ? AND source_hash = ? AND target_language = 'zh-CN'
        AND model = ? AND prompt_version = ?
    `).get(blockId, sourceHash, model, promptVersion))
  }

  saveTranslation(
    blockId: string,
    sourceHash: string,
    text: string,
    model: string,
    promptVersion: string,
  ): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO translations
        (block_id, source_hash, target_language, model, prompt_version, text, created_at)
      VALUES (?, ?, 'zh-CN', ?, ?, ?, ?)
    `).run(blockId, sourceHash, model, promptVersion, text, new Date().toISOString())
  }

  savePosition(publicationId: string, articleId: string, input: ReadingPositionInput | number): void {
    const position: ReadingPositionInput = typeof input === 'number'
      ? { scrollTop: input, anchorBlockId: null, anchorTokenIndex: null, anchorFraction: 0 }
      : input
    if (!this.db.prepare('SELECT 1 FROM articles WHERE id=? AND publication_id=?').get(articleId, publicationId)) {
      throw new Error('阅读位置不属于当前刊物')
    }
    if (position.anchorTokenIndex != null && position.anchorBlockId == null) throw new Error('阅读锚点缺少内容块')
    if (position.anchorBlockId && !this.db.prepare('SELECT 1 FROM blocks WHERE id=? AND article_id=?').get(position.anchorBlockId, articleId)) {
      throw new Error('阅读锚点不属于当前文章')
    }
    this.db.prepare(`
      INSERT INTO reading_positions (publication_id, article_id, scroll_top, anchor_block_id, anchor_token_index, anchor_fraction, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id) DO UPDATE SET
        article_id = excluded.article_id,
        scroll_top = excluded.scroll_top,
        anchor_block_id = excluded.anchor_block_id,
        anchor_token_index = excluded.anchor_token_index,
        anchor_fraction = excluded.anchor_fraction,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id
    `).run(publicationId, articleId, Math.max(0, position.scrollTop), position.anchorBlockId,
      position.anchorTokenIndex, clampFraction(position.anchorFraction), new Date().toISOString(), this.deviceId)
  }

  getPreferences(): ReaderPreferences {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'reader.preferences'").get() as Row | undefined
    if (!row) return DEFAULT_PREFERENCES
    try {
      return { ...DEFAULT_PREFERENCES, ...(JSON.parse(String(row.value)) as Partial<ReaderPreferences>) }
    } catch {
      return DEFAULT_PREFERENCES
    }
  }

  savePreferences(preferences: ReaderPreferences): ReaderPreferences {
    const value: ReaderPreferences = {
      theme: preferences.theme === 'dark' ? 'dark' : 'light',
      fontSize: clamp(preferences.fontSize, 15, 30),
      lineHeight: clamp(preferences.lineHeight, 1.4, 2.2),
      columnWidth: clamp(preferences.columnWidth, 560, 980),
      paperTint: clamp(preferences.paperTint ?? DEFAULT_PREFERENCES.paperTint, 0, 100),
    }
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at, device_id) VALUES ('reader.preferences', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id
    `).run(JSON.stringify(value), new Date().toISOString(), this.deviceId)
    return value
  }

  getSpeechPreferences(): SpeechPreferences {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'speech.preferences'").get() as Row | undefined
    if (!row) return speechProviders.normalize(null)
    try {
      return speechProviders.normalize(JSON.parse(String(row.value)) as Partial<SpeechPreferences>)
    } catch {
      return speechProviders.normalize(null)
    }
  }

  saveSpeechPreferences(preferences: SpeechPreferences): SpeechPreferences {
    const value = speechProviders.normalize(preferences)
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at, device_id) VALUES ('speech.preferences', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id
    `).run(JSON.stringify(value), new Date().toISOString(), this.deviceId)
    return value
  }

  getTranslationPreferences(): TranslationPreferences {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'translation.preferences'").get() as Row | undefined
    if (!row) return translationProviders.normalize(null)
    try {
      return translationProviders.normalize(JSON.parse(String(row.value)) as Partial<TranslationPreferences>)
    } catch {
      return translationProviders.normalize(null)
    }
  }

  saveTranslationPreferences(preferences: TranslationPreferences): TranslationPreferences {
    translationProviders.resolve(preferences)
    const value = translationProviders.normalize(preferences)
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at, device_id) VALUES ('translation.preferences', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id
    `).run(JSON.stringify(value), new Date().toISOString(), this.deviceId)
    return value
  }

  getDictionaryPreferences(): DictionaryPreferences {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'dictionary.preferences'").get() as Row | undefined
    if (!row) return DEFAULT_DICTIONARY_PREFERENCES
    try {
      const saved = JSON.parse(String(row.value)) as Partial<DictionaryPreferences> & {mode?:string}
      if (saved.mode) return {
        ...DEFAULT_DICTIONARY_PREFERENCES, enabled: saved.mode !== 'disabled',
        contextExplanationEnabled: saved.mode === 'local-context',
      }
      return normalizeDictionaryPreferences(saved)
    } catch {
      return DEFAULT_DICTIONARY_PREFERENCES
    }
  }

  saveDictionaryPreferences(preferences: DictionaryPreferences): DictionaryPreferences {
    const value = normalizeDictionaryPreferences(preferences)
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at, device_id) VALUES ('dictionary.preferences', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id
    `).run(JSON.stringify(value), new Date().toISOString(), this.deviceId)
    return value
  }

  getLookupContext(articleId: string, blockId: string, surface: string, tokenIndex: number): VocabularyContext {
    const row = this.db.prepare(`
      SELECT b.text, a.title AS article_title, a.publication_id, p.title AS publication_title
      FROM blocks b JOIN articles a ON a.id = b.article_id
      JOIN publications p ON p.id = a.publication_id
      WHERE b.id = ? AND b.article_id = ? AND b.text IS NOT NULL
    `).get(blockId, articleId) as Row | undefined
    if (!row) throw new Error('无法定位所选单词的正文')
    const text = String(row.text)
    const token = tokenizeEnglish(text)[tokenIndex]
    if (!token || normalizeEnglishWord(surface) !== token.normalized) {
      throw new Error('所选单词与正文内容不一致')
    }
    return {
      publicationId: String(row.publication_id),
      publicationTitle: String(row.publication_title),
      articleId,
      blockId,
      tokenIndex,
      articleTitle: String(row.article_title),
      text,
      surface: token.surface,
      normalized: token.normalized,
      sentence: sentenceAroundToken(text, token),
    }
  }

  getReaderVocabularyState(context: VocabularyContext, lexemeKey: LexemeKey): ReaderVocabularyState {
    const contextId = this.contextId(context, lexemeKey)
    const lexeme = this.db.prepare('SELECT manual_state FROM user_lexemes WHERE lexeme_key=?').get(lexemeKey) as Row | undefined
    const favorite = Boolean(this.db.prepare(`
      SELECT 1 FROM vocabulary_sources
      WHERE lexeme_key=? AND source_type='reader_manual' AND source_ref='favorite' AND active=1
    `).get(lexemeKey))
    const contextSaved = Boolean(this.db.prepare(
      'SELECT 1 FROM saved_contexts WHERE context_id=? AND active=1',
    ).get(contextId))
    return {
      lexemeKey, favorite, contextSaved,
      manualState: (lexeme?.manual_state ?? 'unrated') as ManualLearningState,
    }
  }

  setVocabularyFavorite(
    context: VocabularyContext,
    detail: LexemeDetail,
    favorite: boolean,
  ): ReaderVocabularyState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureUserLexeme(detail)
      if (favorite) this.saveLexemeExamples(detail.lexemeKey, detail.examples)
      this.setManualSource(detail.lexemeKey, favorite)
      if (favorite) this.setSavedContext(context, detail.lexemeKey, true)
      this.db.exec('COMMIT')
      return this.getReaderVocabularyState(context, detail.lexemeKey)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setVocabularyContext(
    context: VocabularyContext,
    detail: LexemeDetail,
    saved: boolean,
  ): ReaderVocabularyState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureUserLexeme(detail)
      this.setSavedContext(context, detail.lexemeKey, saved)
      this.db.exec('COMMIT')
      return this.getReaderVocabularyState(context, detail.lexemeKey)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeManualFavorite(lexemeKey: LexemeKey): void {
    if (!this.db.prepare('SELECT 1 FROM user_lexemes WHERE lexeme_key=?').get(lexemeKey)) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.setManualSource(lexemeKey, false)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listVocabularyFavorites(query: VocabularyListQuery): VocabularyListPage {
    const limit = Math.min(50, Math.max(1, query.limit))
    const offset = Math.max(0, query.offset)
    const text = query.text.normalize('NFKC').trim().toLowerCase()
    const condition = text ? 'AND (lower(u.lemma_snapshot) LIKE ? OR u.brief_meanings_json LIKE ?)' : ''
    const parameters = text ? [`%${text.replace(/[\\%_]/g, (item) => `\\${item}`)}%`, `%${text}%`] : []
    const base = `FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key
      WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1 ${condition}`
    const total = this.db.prepare(`SELECT COUNT(DISTINCT u.lexeme_key) AS count ${base}`).get(...parameters) as Row
    const rows = this.db.prepare(`
      SELECT u.*, s.added_at ${base} ORDER BY s.added_at DESC LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as Row[]
    return {
      items: rows.map((row) => ({
        lexemeKey: String(row.lexeme_key), lemma: String(row.lemma_snapshot),
        phonetic: row.phonetic_snapshot == null ? null : String(row.phonetic_snapshot),
        briefMeanings: parseStringArray(row.brief_meanings_json),
        manualState: String(row.manual_state) as ManualLearningState, addedAt: String(row.added_at),
      })),
      offset, limit, total: Number(total.count),
    }
  }

  listSavedContexts(lexemeKey: LexemeKey, offset = 0, limit = 50): SavedContextPage {
    const safeLimit = Math.min(50, Math.max(1, limit))
    const safeOffset = Math.max(0, offset)
    const total = this.db.prepare(
      'SELECT COUNT(*) AS count FROM saved_contexts WHERE lexeme_key=? AND active=1',
    ).get(lexemeKey) as Row
    const rows = this.db.prepare(`
      SELECT * FROM saved_contexts WHERE lexeme_key=? AND active=1
      ORDER BY saved_at DESC LIMIT ? OFFSET ?
    `).all(lexemeKey, safeLimit, safeOffset) as Row[]
    return {
      items: rows.map((row) => ({
        contextId: String(row.context_id),
        publicationId: row.publication_id == null ? null : String(row.publication_id),
        publicationTitle: String(row.publication_title_snapshot),
        articleId: row.article_id == null ? null : String(row.article_id),
        articleTitle: String(row.article_title_snapshot),
        sentence: String(row.sentence_snapshot), paragraph: String(row.paragraph_snapshot),
        surface: String(row.surface), savedAt: String(row.saved_at),
      })),
      offset: safeOffset, limit: safeLimit, total: Number(total.count),
    }
  }

  getVocabularyCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT lexeme_key) AS count FROM vocabulary_sources
      WHERE source_type='reader_manual' AND source_ref='favorite' AND active=1
    `).get() as Row
    return Number(row.count)
  }

  listLexemeExamples(lexemeKey: LexemeKey): DictionaryExample[] {
    return (this.db.prepare('SELECT * FROM lexeme_examples WHERE lexeme_key=? ORDER BY position').all(lexemeKey) as Row[]).map(row => ({
      exampleId: String(row.example_id), text: String(row.text),
      translationZh: row.translation_zh == null ? null : String(row.translation_zh),
      partOfSpeech: row.part_of_speech == null ? null : String(row.part_of_speech),
      definition: row.definition == null ? null : String(row.definition),
      providerId: String(row.provider_id) === 'baidu' ? 'baidu' : 'ecdict',
    }))
  }

  saveLexemeExamples(lexemeKey: LexemeKey, examples: DictionaryExample[]): DictionaryExample[] {
    if (!examples?.length || !this.db.prepare('SELECT 1 FROM user_lexemes WHERE lexeme_key=?').get(lexemeKey)) return this.listLexemeExamples(lexemeKey)
    const now = new Date().toISOString()
    const insert = this.db.prepare(`INSERT INTO lexeme_examples(example_id,lexeme_key,text,translation_zh,part_of_speech,definition,provider_id,position,created_at,updated_at,device_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(example_id) DO UPDATE SET
      translation_zh=COALESCE(excluded.translation_zh,lexeme_examples.translation_zh),updated_at=excluded.updated_at,device_id=excluded.device_id`)
    for (const [position, example] of examples.slice(0, 2).entries()) {
      insert.run(example.exampleId, lexemeKey, example.text, example.translationZh, example.partOfSpeech,
        example.definition, example.providerId, position, now, now, this.deviceId)
    }
    return this.listLexemeExamples(lexemeKey)
  }

  private ensureUserLexeme(detail: LexemeDetail): void {
    const now = new Date().toISOString()
    const provider = detail.providerId ?? 'ecdict'
    const quality = provider === 'baidu' ? 30 : 10
    this.db.prepare(`
      INSERT INTO user_lexemes
        (lexeme_key, lemma_snapshot, phonetic_snapshot, brief_meanings_json, sense_groups_json,
         bnc_rank, frequency_rank, manual_state, manual_familiarity, created_at, updated_at, device_id,
         snapshot_provider,snapshot_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unrated', NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(lexeme_key) DO UPDATE SET
        lemma_snapshot=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality THEN excluded.lemma_snapshot ELSE user_lexemes.lemma_snapshot END,
        phonetic_snapshot=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality THEN COALESCE(excluded.phonetic_snapshot,user_lexemes.phonetic_snapshot) ELSE user_lexemes.phonetic_snapshot END,
        brief_meanings_json=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality AND excluded.brief_meanings_json!='[]' THEN excluded.brief_meanings_json ELSE user_lexemes.brief_meanings_json END,
        sense_groups_json=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality AND excluded.sense_groups_json!='[]' THEN excluded.sense_groups_json ELSE user_lexemes.sense_groups_json END,
        bnc_rank=COALESCE(user_lexemes.bnc_rank,excluded.bnc_rank),frequency_rank=COALESCE(user_lexemes.frequency_rank,excluded.frequency_rank),
        snapshot_provider=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality THEN excluded.snapshot_provider ELSE user_lexemes.snapshot_provider END,
        snapshot_quality=max(user_lexemes.snapshot_quality,excluded.snapshot_quality),updated_at=excluded.updated_at,device_id=excluded.device_id
    `).run(
      detail.lexemeKey, detail.lemma, detail.phonetic, JSON.stringify(detail.briefMeanings),
      JSON.stringify(detail.entries.flatMap((entry) => entry.senses)),
      detail.frequency.bnc, detail.frequency.contemporary,
      now, now, this.deviceId, provider, quality,
    )
  }

  private setManualSource(lexemeKey: LexemeKey, active: boolean): void {
    const now = new Date().toISOString()
    const sourceId = vocabularySourceIdentity(lexemeKey, 'reader_manual', 'favorite')
    this.db.prepare(`
      INSERT INTO vocabulary_sources
        (source_id, lexeme_key, source_type, source_ref, active, added_at, removed_at, updated_at, device_id)
      VALUES (?, ?, 'reader_manual', 'favorite', ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET active=excluded.active,
        removed_at=excluded.removed_at, updated_at=excluded.updated_at, device_id=excluded.device_id
    `).run(sourceId, lexemeKey, active ? 1 : 0, now, active ? null : now, now, this.deviceId)
  }

  private setSavedContext(context: VocabularyContext, lexemeKey: LexemeKey, active: boolean): void {
    const now = new Date().toISOString()
    const sentenceHash = hashText(context.sentence)
    const contextId = this.contextId(context, lexemeKey)
    this.db.prepare(`
      INSERT INTO saved_contexts
        (context_id, lexeme_key, surface, publication_id, publication_title_snapshot,
         article_id, article_title_snapshot, block_id, token_index, sentence_snapshot,
         paragraph_snapshot, sentence_hash, active, saved_at, removed_at, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_id) DO UPDATE SET surface=excluded.surface,
        publication_id=excluded.publication_id,
        publication_title_snapshot=excluded.publication_title_snapshot,
        article_id=excluded.article_id, article_title_snapshot=excluded.article_title_snapshot,
        block_id=excluded.block_id, token_index=excluded.token_index,
        sentence_snapshot=excluded.sentence_snapshot, paragraph_snapshot=excluded.paragraph_snapshot,
        sentence_hash=excluded.sentence_hash, active=excluded.active,
        removed_at=excluded.removed_at, updated_at=excluded.updated_at, device_id=excluded.device_id
    `).run(
      contextId, lexemeKey, context.surface, context.publicationId, context.publicationTitle,
      context.articleId, context.articleTitle, context.blockId, context.tokenIndex,
      context.sentence, context.text, sentenceHash, active ? 1 : 0, now,
      active ? null : now, now, this.deviceId,
    )
  }

  private contextId(context: VocabularyContext, lexemeKey: LexemeKey): string {
    return savedContextIdentity(
      lexemeKey, context.publicationId, context.articleId, context.blockId,
      context.tokenIndex, hashText(context.sentence),
    )
  }

  getContextDefinition(cacheKey: string): ContextDefinition | null {
    const row = this.db.prepare('SELECT result_json FROM context_definitions WHERE cache_key = ?').get(cacheKey) as Row | undefined
    if (!row) return null
    try {
      return { ...(JSON.parse(String(row.result_json)) as ContextDefinition), cached: true }
    } catch {
      return null
    }
  }

  saveContextDefinition(input: {
    cacheKey: string
    lexemeKey: LexemeKey
    word: string
    lemma: string
    articleId: string
    blockId: string
    sentenceHash: string
    dictionaryVersion: string
    model: string
    promptVersion: string
    result: ContextDefinition
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO context_definitions
        (cache_key, lexeme_key, word, lemma, article_id, block_id, sentence_hash, dictionary_version, model, prompt_version, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.cacheKey,
      input.lexemeKey,
      input.word,
      input.lemma,
      input.articleId,
      input.blockId,
      input.sentenceHash,
      input.dictionaryVersion,
      input.model,
      input.promptVersion,
      JSON.stringify(input.result),
      new Date().toISOString(),
    )
  }

  private getLibraryManagement(): LibraryManagementRecord {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'library.management'").get() as Row | undefined
    if (!row) return structuredClone(DEFAULT_LIBRARY_MANAGEMENT)
    try {
      return normalizeLibraryManagement(JSON.parse(String(row.value)) as Partial<LibraryManagementRecord>)
    } catch {
      return structuredClone(DEFAULT_LIBRARY_MANAGEMENT)
    }
  }

  private writeLibraryManagement(value: LibraryManagementRecord): void {
    const normalized = normalizeLibraryManagement(value)
    writeLibraryManagementSettings(
      this.db,
      this.deviceId,
      normalized as unknown as Record<string, unknown>,
    )
  }

  private libraryTitle(publicationId: string, originalTitle: string): string {
    return this.getLibraryManagement().items[publicationId]?.customTitle || originalTitle
  }

  private publicationSummary(row: Row, management = this.getLibraryManagement()): PublicationSummary {
    const originalTitle = String(row.title)
    const item = management.items[String(row.id)]
    const coverUrl = row.cover_path == null
      ? null
      : `reader-asset://asset/${encodeURIComponent(String(row.id))}/${String(row.cover_path).split('/').map(encodeURIComponent).join('/')}`
    return {
      id: String(row.id),
      title: item?.customTitle || originalTitle,
      originalTitle,
      categoryId: item?.categoryId ?? null,
      creator: row.creator == null ? null : String(row.creator),
      language: row.language == null ? null : String(row.language),
      coverUrl,
      coverThumbnailUrl: coverUrl,
      coverThumbnailWidth: null,
      coverThumbnailHeight: null,
      importedAt: String(row.effective_imported_at ?? row.imported_at),
      articleCount: Number(row.article_count),
      sectionCount: Number(row.section_count),
      lastArticleId: row.last_article_id == null ? null : String(row.last_article_id),
    }
  }

  private articleSummary(row: Row): ArticleSummary {
    return {
      id: String(row.id),
      sectionId: row.section_id == null ? null : String(row.section_id),
      title: String(row.title),
      rubric: row.rubric == null ? null : String(row.rubric),
      publishedAt: row.published_at == null ? null : String(row.published_at),
      position: Number(row.position),
      blockCount: Number(row.block_count ?? 0),
    }
  }
}

function normalizeDictionaryPreferences(value: Partial<DictionaryPreferences>): DictionaryPreferences {
  return {
    enabled: value.enabled !== false,
    lookupProviderId: value.lookupProviderId === 'baidu' ? 'baidu' : 'ecdict',
    fallbackToLocal: value.fallbackToLocal !== false,
    contextExplanationEnabled: value.contextExplanationEnabled !== false,
    translateExamples: value.translateExamples === true,
  }
}

function normalizeLibraryManagement(value: Partial<LibraryManagementRecord>): LibraryManagementRecord {
  const categories: LibraryCategory[] = []
  const categoryIds = new Set<string>()
  const categoryNames = new Set<string>()
  for (const candidate of Array.isArray(value.categories) ? value.categories : []) {
    if (!candidate || typeof candidate !== 'object') continue
    const id = String(candidate.id ?? '')
    const name = normalizeLibraryText(String(candidate.name ?? ''), 100)
    const folded = name.toLocaleLowerCase('zh-CN')
    if (!/^category_[a-f0-9]{32}$/.test(id) || !name || categoryIds.has(id) || categoryNames.has(folded)) continue
    categoryIds.add(id)
    categoryNames.add(folded)
    categories.push({
      id,
      name,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
    })
  }
  const items: Record<string, LibraryItemManagement> = {}
  if (value.items && typeof value.items === 'object') {
    for (const [publicationId, candidate] of Object.entries(value.items)) {
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(publicationId) || !candidate || typeof candidate !== 'object') continue
      const customTitle = typeof candidate.customTitle === 'string'
        ? normalizeLibraryText(candidate.customTitle, 200) || null
        : null
      const categoryId = typeof candidate.categoryId === 'string' && categoryIds.has(candidate.categoryId)
        ? candidate.categoryId
        : null
      if (customTitle || categoryId) items[publicationId] = { customTitle, categoryId }
    }
  }
  return {
    viewMode: value.viewMode === 'list' ? 'list' : 'grid',
    sortBy: value.sortBy === 'name' ? 'name' : 'importedAt',
    sortDirection: value.sortDirection === 'asc' ? 'asc' : 'desc',
    activeCategoryId: normalizeActiveCategory(value.activeCategoryId, categories),
    categories,
    items,
  }
}

function libraryPreferencesOf(value: LibraryManagementRecord): LibraryPreferences {
  return {
    viewMode: value.viewMode,
    sortBy: value.sortBy,
    sortDirection: value.sortDirection,
    activeCategoryId: value.activeCategoryId,
  }
}

function normalizeActiveCategory(value: unknown, categories: LibraryCategory[]): string {
  const candidate = typeof value === 'string' ? value : 'all'
  return candidate === 'all' || candidate === 'uncategorized' || categories.some((item) => item.id === candidate)
    ? candidate
    : 'all'
}

function normalizeLibraryName(value: string, label: string): string {
  const normalized = normalizeLibraryText(value, 100)
  if (!normalized) throw new Error(`${label}不能为空`)
  return normalized
}

function normalizeLibraryText(value: string, limit: number): string {
  return Array.from(value.trim().replace(/\s+/g, ' ')).slice(0, limit).join('')
}

function assertUniqueCategoryName(categories: LibraryCategory[], name: string, exceptId?: string): void {
  const folded = name.toLocaleLowerCase('zh-CN')
  if (categories.some((item) => item.id !== exceptId && item.name.toLocaleLowerCase('zh-CN') === folded)) {
    throw new Error('已存在同名分类')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value) || min))
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function clampFraction(value: number): number { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) }

function normalizeImportedAt(value?: string): string {
  if (value == null) return new Date().toISOString()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('刊物首次导入时间无效')
  return new Date(timestamp).toISOString()
}
