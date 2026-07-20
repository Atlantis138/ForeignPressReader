import type { DatabaseSync } from 'node:sqlite'
import type { ManualLearningState, ParsedPublicationPlan } from '../shared/types'
import type {
  PortableBookRecord,
  PortableDatasetKey,
  PortableDatasetRecord,
  PortableMergePolicy,
  PortableMergeResult,
  PortablePublicationLifecycleRecord,
  PortableReadingPositionRecord,
  PortableSettingRecord,
  PortableStudyLexemeResetRecord,
  PortableUserData,
} from '../core/portable-data'
import { compareVersionedRecord, PORTABLE_DATASET_KEYS } from '../core/portable-data'

type Row = Record<string, unknown>

function* mapRows<T extends PortableDatasetRecord>(
  rows: Iterable<Row>,
  mapper: (row: Row) => T,
): IterableIterator<T> {
  for (const row of rows) yield mapper(row)
}

export class PortableSqliteRepository {
  constructor(private readonly db: DatabaseSync) {}

  listPortableBooks(): PortableBookRecord[] {
    return (this.db.prepare(`
      SELECT p.id, p.hash, p.title,
        min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) AS imported_at,
        COALESCE(l.format_id, 'epub') AS format_id
      FROM publications p
      LEFT JOIN publication_lifecycle l ON l.publication_id=p.id
      WHERE l.state IS NULL OR l.state='present'
      ORDER BY p.imported_at
    `).all() as Row[])
      .map((row) => ({
        publicationId: String(row.id),
        hash: String(row.hash),
        title: String(row.title),
        formatId: String(row.format_id),
        importedAt: String(row.imported_at),
      }))
  }

  getParsedPublicationPlan(publicationId: string, assetPaths: string[]): ParsedPublicationPlan {
    const publication = this.db.prepare('SELECT * FROM publications WHERE id=?').get(publicationId) as Row | undefined
    if (!publication) throw new Error('未找到要打包的刊物')
    const sectionRows = this.db.prepare('SELECT * FROM sections WHERE publication_id=? ORDER BY position,id').all(publicationId) as Row[]
    const articleRows = this.db.prepare('SELECT * FROM articles WHERE publication_id=? ORDER BY position,id').all(publicationId) as Row[]
    const blockStatement = this.db.prepare('SELECT * FROM blocks WHERE article_id=? ORDER BY position,id')
    const articles = new Map<string, ParsedPublicationPlan['unsectionedArticles'][number]>()
    for (const row of articleRows) {
      const articleId = String(row.id)
      articles.set(articleId, {
        id: articleId,
        sourceKey: String(row.source_key),
        title: String(row.title),
        rubric: row.rubric == null ? null : String(row.rubric),
        publishedAt: row.published_at == null ? null : String(row.published_at),
        position: Number(row.position),
        sourceHref: String(row.source_href),
        blocks: (blockStatement.all(articleId) as Row[]).map((block) => ({
          id: String(block.id), sourceKey: String(block.source_key),
          type: block.type as ParsedPublicationPlan['unsectionedArticles'][number]['blocks'][number]['type'],
          position: Number(block.position), text: block.text == null ? null : String(block.text),
          html: block.html == null ? null : String(block.html),
          assetPath: block.asset_path == null ? null : String(block.asset_path),
          alt: block.alt == null ? null : String(block.alt),
        })),
      })
    }
    const sections = sectionRows.map((row) => ({
      id: String(row.id), sourceKey: String(row.source_key), title: String(row.title), position: Number(row.position),
      articles: articleRows.filter((article) => String(article.section_id ?? '') === String(row.id))
        .map((article) => articles.get(String(article.id))!),
    }))
    return {
      id: String(publication.id), hash: String(publication.hash), sourceKey: String(publication.source_key),
      profileId: String(publication.profile_id), title: String(publication.title),
      creator: publication.creator == null ? null : String(publication.creator),
      language: publication.language == null ? null : String(publication.language),
      coverPath: publication.cover_path == null ? null : String(publication.cover_path), sections,
      unsectionedArticles: articleRows.filter((article) => article.section_id == null)
        .map((article) => articles.get(String(article.id))!),
      assetPaths: [...assetPaths].sort(),
    }
  }

  exportPortableUserData(): PortableUserData {
    return Object.fromEntries(PORTABLE_DATASET_KEYS.map((key) => [
      key,
      [...this.iteratePortableDataset(key)],
    ])) as unknown as PortableUserData
  }

  iteratePortableDataset(dataset: PortableDatasetKey): Iterable<PortableDatasetRecord> {
    switch (dataset) {
      case 'publicationLifecycle': return mapRows(this.db.prepare(`
        SELECT publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id
        FROM publication_lifecycle ORDER BY publication_id
      `).iterate() as Iterable<Row>, (row): PortablePublicationLifecycleRecord => ({
        publicationId: String(row.publication_id), contentHash: String(row.content_hash),
        formatId: String(row.format_id), titleSnapshot: String(row.title_snapshot),
        state: String(row.state) as 'present' | 'deleted', changedAt: String(row.changed_at), deviceId: String(row.device_id),
      }))
      case 'settings': return mapRows(this.db.prepare(`
        SELECT key,value,updated_at,device_id FROM settings
        WHERE key IN ('reader.preferences','dictionary.preferences','study.preferences','speech.preferences','translation.preferences','library.management') ORDER BY key
      `).iterate() as Iterable<Row>, (row): PortableSettingRecord => ({
        key: String(row.key), value: String(row.value), updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
      case 'readingPositions': return mapRows(this.db.prepare(`
        SELECT publication_id,article_id,scroll_top,anchor_block_id,anchor_token_index,anchor_fraction,updated_at,device_id
        FROM reading_positions ORDER BY publication_id
      `).iterate() as Iterable<Row>, (row): PortableReadingPositionRecord => ({
        publicationId: String(row.publication_id), articleId: String(row.article_id), scrollTop: Number(row.scroll_top),
        anchorBlockId: row.anchor_block_id == null ? null : String(row.anchor_block_id),
        anchorTokenIndex: row.anchor_token_index == null ? null : Number(row.anchor_token_index),
        anchorFraction: Number(row.anchor_fraction ?? 0), updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
      case 'userLexemes': return mapRows(this.db.prepare('SELECT * FROM user_lexemes ORDER BY lexeme_key').iterate() as Iterable<Row>, (row) => ({
        lexemeKey: String(row.lexeme_key), lemmaSnapshot: String(row.lemma_snapshot),
        phoneticSnapshot: row.phonetic_snapshot == null ? null : String(row.phonetic_snapshot),
        briefMeaningsJson: String(row.brief_meanings_json), senseGroupsJson: String(row.sense_groups_json),
        bncRank: row.bnc_rank == null ? null : Number(row.bnc_rank), frequencyRank: row.frequency_rank == null ? null : Number(row.frequency_rank),
        manualState: String(row.manual_state) as ManualLearningState,
        manualFamiliarity: row.manual_familiarity == null ? null : Number(row.manual_familiarity),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at), deviceId: String(row.device_id),
        snapshotProvider: String(row.snapshot_provider) === 'baidu' ? 'baidu' as const : 'ecdict' as const,
        snapshotQuality: Number(row.snapshot_quality ?? 10),
      }))
      case 'lexemeExamples': return mapRows(this.db.prepare('SELECT * FROM lexeme_examples ORDER BY lexeme_key,position').iterate() as Iterable<Row>, (row) => ({
        exampleId: String(row.example_id), lexemeKey: String(row.lexeme_key), text: String(row.text),
        translationZh: row.translation_zh == null ? null : String(row.translation_zh),
        partOfSpeech: row.part_of_speech == null ? null : String(row.part_of_speech), definition: row.definition == null ? null : String(row.definition),
        providerId: String(row.provider_id) === 'baidu' ? 'baidu' as const : 'ecdict' as const, position: Number(row.position),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
      case 'vocabularySources': return mapRows(this.db.prepare('SELECT * FROM vocabulary_sources ORDER BY source_id').iterate() as Iterable<Row>, (row) => ({
        sourceId: String(row.source_id), lexemeKey: String(row.lexeme_key), sourceType: String(row.source_type), sourceRef: String(row.source_ref),
        active: Number(row.active) === 1, addedAt: String(row.added_at), removedAt: row.removed_at == null ? null : String(row.removed_at),
        updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
      case 'savedContexts': return mapRows(this.db.prepare('SELECT * FROM saved_contexts ORDER BY context_id').iterate() as Iterable<Row>, (row) => ({
        contextId: String(row.context_id), lexemeKey: String(row.lexeme_key), surface: String(row.surface),
        publicationId: row.publication_id == null ? null : String(row.publication_id), publicationTitle: String(row.publication_title_snapshot),
        articleId: row.article_id == null ? null : String(row.article_id), articleTitle: String(row.article_title_snapshot),
        blockId: row.block_id == null ? null : String(row.block_id), tokenIndex: Number(row.token_index), sentence: String(row.sentence_snapshot),
        paragraph: String(row.paragraph_snapshot), sentenceHash: String(row.sentence_hash), active: Number(row.active) === 1,
        savedAt: String(row.saved_at), removedAt: row.removed_at == null ? null : String(row.removed_at),
        updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
      case 'studyPlans': return mapRows(this.db.prepare('SELECT * FROM study_plans ORDER BY plan_id').iterate() as Iterable<Row>, portableStudyPlan)
      case 'studyPlanSources': return mapRows(this.db.prepare('SELECT source_id,plan_id,source_type,source_ref,active,added_at,removed_at,updated_at,device_id FROM study_plan_sources ORDER BY source_id').iterate() as Iterable<Row>, portableStudyPlanSource)
      case 'studyPlanOrigins': return mapRows(this.db.prepare('SELECT * FROM study_plan_lexeme_origins ORDER BY origin_id').iterate() as Iterable<Row>, portableStudyPlanOrigin)
      case 'studyPlanExclusions': return mapRows(this.db.prepare('SELECT * FROM study_plan_exclusions ORDER BY plan_id,lexeme_key').iterate() as Iterable<Row>, portableStudyPlanExclusion)
      case 'schedulerProfiles': return mapRows(this.db.prepare('SELECT * FROM scheduler_profiles ORDER BY profile_id').iterate() as Iterable<Row>, portableSchedulerProfile)
      case 'reviewCards': return mapRows(this.db.prepare('SELECT * FROM review_cards ORDER BY lexeme_key').iterate() as Iterable<Row>, portableReviewCard)
      case 'reviewEvents': return mapRows(this.db.prepare('SELECT event_id,command_id,lexeme_key,plan_id,answer,rating,profile_id,pre_card_json,post_card_json,log_json,reviewed_at,device_id FROM review_events ORDER BY event_id').iterate() as Iterable<Row>, portableReviewEvent)
      case 'reinforcementEvents': return mapRows(this.db.prepare('SELECT event_id,command_id,lexeme_key,plan_id,answer,consecutive_before,consecutive_after,created_at,device_id FROM reinforcement_events ORDER BY event_id').iterate() as Iterable<Row>, portableReinforcementEvent)
      case 'reviewSuspensions': return mapRows(this.db.prepare('SELECT * FROM review_suspensions ORDER BY lexeme_key').iterate() as Iterable<Row>, portableReviewSuspension)
      case 'studyProgressState': return mapRows(this.db.prepare('SELECT * FROM study_progress_state ORDER BY state_id').iterate() as Iterable<Row>, portableStudyProgressState)
      case 'studyLexemeResets': return mapRows(this.db.prepare('SELECT * FROM study_lexeme_resets ORDER BY lexeme_key').iterate() as Iterable<Row>, (row): PortableStudyLexemeResetRecord => ({
        lexemeKey: String(row.lexeme_key), resetAt: String(row.reset_at), updatedAt: String(row.updated_at), deviceId: String(row.device_id),
      }))
    }
  }

  mergePortableUserData(
    data: Pick<PortableUserData, 'settings' | 'readingPositions' | 'userLexemes' | 'vocabularySources' | 'savedContexts'>
      & Partial<Omit<PortableUserData, 'settings' | 'readingPositions' | 'userLexemes' | 'vocabularySources' | 'savedContexts'>>,
    policy: PortableMergePolicy = 'newer-wins',
    manageTransaction = true,
    finalizeStudy = true,
  ): PortableMergeResult {
    const result: PortableMergeResult = {
      publicationLifecycle: 0,
      settings: 0, readingPositions: 0,
      vocabulary: 0, vocabularySources: 0, savedContexts: 0, studyPlans: 0, reviewCards: 0, reviewEvents: 0, reinforcementEvents: 0, reviewSuspensions: 0, studyLexemeResets: 0,
    }
    if (manageTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const lifecycle of data.publicationLifecycle ?? []) if (this.mergePublicationLifecycle(lifecycle, policy)) result.publicationLifecycle++
      for (const setting of data.settings) if (this.mergeSetting(setting, policy)) result.settings++
      for (const position of data.readingPositions) if (this.mergeReadingPosition(position, policy)) result.readingPositions++
      for (const lexeme of data.userLexemes) if (this.mergeUserLexeme(lexeme, policy)) result.vocabulary++
      this.mergeStudyRows('lexeme_examples',['example_id'],(data.lexemeExamples??[]).map(example=>({example_id:example.exampleId,lexeme_key:example.lexemeKey,text:example.text,translation_zh:example.translationZh,part_of_speech:example.partOfSpeech,definition:example.definition,provider_id:example.providerId,position:example.position,created_at:example.createdAt,updated_at:example.updatedAt,device_id:example.deviceId})),true,policy)
      for (const source of data.vocabularySources) if (this.mergeVocabularySource(source, policy)) result.vocabularySources++
      for (const context of data.savedContexts) if (this.mergeSavedContext(context, policy)) result.savedContexts++
      result.studyPlans += this.mergeStudyRows('study_plans',['plan_id'],(data.studyPlans??[]).map(dbStudyPlan),true,policy)
      this.mergeStudyRows('study_plan_sources',['source_id'],(data.studyPlanSources??[]).map(dbStudyPlanSource),true,policy)
      this.mergeStudyRows('study_plan_lexeme_origins',['origin_id'],(data.studyPlanOrigins??[]).map(dbStudyPlanOrigin),true,policy)
      this.mergeStudyRows('study_plan_exclusions',['plan_id','lexeme_key'],(data.studyPlanExclusions??[]).map(dbStudyPlanExclusion),true,policy)
      this.mergeStudyRows('scheduler_profiles',['profile_id'],(data.schedulerProfiles??[]).map(dbSchedulerProfile),false,policy)
      this.mergeStudyRows('study_progress_state',['state_id'],(data.studyProgressState??[]).map(dbStudyProgressState),true,policy)
      result.studyLexemeResets += this.mergeStudyRows('study_lexeme_resets',['lexeme_key'],(data.studyLexemeResets??[]).map(dbStudyLexemeReset),true,policy)
      const reset = this.db.prepare("SELECT reset_at FROM study_progress_state WHERE state_id='global'").get() as Row | undefined
      const resetAt = reset?.reset_at == null ? '' : String(reset.reset_at)
      if (resetAt) {
        this.db.prepare('DELETE FROM review_events WHERE reviewed_at<=?').run(resetAt)
        this.db.prepare('DELETE FROM reinforcement_events WHERE created_at<=?').run(resetAt)
        this.db.prepare('DELETE FROM review_cards WHERE updated_at<=?').run(resetAt)
      }
      const selectiveResets = new Map((this.db.prepare('SELECT lexeme_key,reset_at FROM study_lexeme_resets').all() as Row[])
        .map((row) => [String(row.lexeme_key), String(row.reset_at)]))
      for (const [lexemeKey, lexemeResetAt] of selectiveResets) this.applyLexemeReset(lexemeKey, lexemeResetAt)
      result.reviewCards += this.mergeStudyRows('review_cards',['lexeme_key'],(data.reviewCards??[]).filter((row)=>row.updatedAt>maxReset(resetAt, selectiveResets.get(row.lexemeKey))).map(dbReviewCard),true,policy)
      result.reviewEvents += this.mergeStudyRows('review_events',['event_id'],(data.reviewEvents??[]).filter((row)=>row.reviewedAt>maxReset(resetAt, selectiveResets.get(row.lexemeKey))).map(dbReviewEvent),false,policy)
      result.reinforcementEvents += this.mergeStudyRows('reinforcement_events',['event_id'],(data.reinforcementEvents??[]).filter((row)=>row.createdAt>maxReset(resetAt, selectiveResets.get(row.lexemeKey))).map(dbReinforcementEvent),false,policy)
      result.reviewSuspensions += this.mergeStudyRows('review_suspensions',['lexeme_key'],(data.reviewSuspensions??[]).filter((row)=>row.updatedAt>maxReset(resetAt, selectiveResets.get(row.lexemeKey))).map(dbReviewSuspension),true,policy)
      if (finalizeStudy && resetAt) this.db.exec('DELETE FROM scheduler_profiles WHERE NOT EXISTS(SELECT 1 FROM review_events WHERE review_events.profile_id=scheduler_profiles.profile_id)')
      if (manageTransaction) this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (manageTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  beginPortableMerge(): void { this.db.exec('BEGIN IMMEDIATE') }
  commitPortableMerge(): void { this.db.exec('COMMIT') }
  rollbackPortableMerge(): void { this.db.exec('ROLLBACK') }

  private mergePublicationLifecycle(record: PortablePublicationLifecycleRecord, policy: PortableMergePolicy): boolean {
    const current = this.db.prepare('SELECT * FROM publication_lifecycle WHERE publication_id=?').get(record.publicationId) as Row | undefined
    if (current && policy === 'newer-wins' && compareVersionedRecord({ updatedAt: record.changedAt, deviceId: record.deviceId }, {
      updatedAt: String(current.changed_at), deviceId: String(current.device_id),
    }) <= 0) return false
    if (current && String(current.content_hash) === record.contentHash && String(current.format_id) === record.formatId
      && String(current.title_snapshot) === record.titleSnapshot && String(current.state) === record.state
      && String(current.changed_at) === record.changedAt && String(current.device_id) === record.deviceId) return false
    if (record.state === 'present' && !this.db.prepare('SELECT 1 FROM publications WHERE id=? AND hash=?').get(record.publicationId, record.contentHash)) {
      throw new Error(`刊物源文件尚未导入：${record.titleSnapshot}`)
    }
    this.db.prepare(`
      INSERT INTO publication_lifecycle(publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(publication_id) DO UPDATE SET content_hash=excluded.content_hash,format_id=excluded.format_id,
        title_snapshot=excluded.title_snapshot,state=excluded.state,changed_at=excluded.changed_at,device_id=excluded.device_id
    `).run(record.publicationId, record.contentHash, record.formatId, record.titleSnapshot, record.state, record.changedAt, record.deviceId)
    if (record.state === 'present') {
      this.db.prepare(`
        UPDATE publications SET imported_at=min(imported_at, ?)
        WHERE id=? AND hash=?
      `).run(record.changedAt, record.publicationId, record.contentHash)
    }
    if (record.state === 'deleted') this.db.prepare('DELETE FROM publications WHERE id=?').run(record.publicationId)
    return true
  }

  private mergeSetting(record: PortableSettingRecord, policy: PortableMergePolicy): boolean {
    if (!['reader.preferences', 'dictionary.preferences', 'study.preferences', 'speech.preferences', 'translation.preferences', 'library.management'].includes(record.key)) return false
    const current = this.db.prepare('SELECT value,updated_at,device_id FROM settings WHERE key = ?').get(record.key) as Row | undefined
    if (current && String(current.value) === record.value && String(current.updated_at) === record.updatedAt && String(current.device_id) === record.deviceId) return false
    if (current && policy === 'newer-wins' && compareVersionedRecord(record, {
      updatedAt: String(current.updated_at), deviceId: String(current.device_id),
    }) <= 0) return false
    JSON.parse(record.value)
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at, device_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, device_id=excluded.device_id
    `).run(record.key, record.value, record.updatedAt, record.deviceId)
    return true
  }

  private mergeReadingPosition(record: PortableReadingPositionRecord, policy: PortableMergePolicy): boolean {
    const valid = this.db.prepare(`
      SELECT 1 FROM articles WHERE id = ? AND publication_id = ?
    `).get(record.articleId, record.publicationId)
    if (!valid) return false
    const current = this.db.prepare(`
      SELECT * FROM reading_positions WHERE publication_id = ?
    `).get(record.publicationId) as Row | undefined
    if (current && sameRawRecord({publication_id:record.publicationId,article_id:record.articleId,scroll_top:Math.max(0,record.scrollTop),
      anchor_block_id:record.anchorBlockId,anchor_token_index:record.anchorTokenIndex,anchor_fraction:clampFraction(record.anchorFraction),updated_at:record.updatedAt,device_id:record.deviceId},current)) return false
    if (current && policy === 'newer-wins' && compareVersionedRecord(record, {
      updatedAt: String(current.updated_at), deviceId: String(current.device_id),
    }) <= 0) return false
    this.db.prepare(`
      INSERT INTO reading_positions (publication_id, article_id, scroll_top, anchor_block_id, anchor_token_index, anchor_fraction, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id) DO UPDATE SET article_id=excluded.article_id,
        scroll_top=excluded.scroll_top,anchor_block_id=excluded.anchor_block_id,anchor_token_index=excluded.anchor_token_index,
        anchor_fraction=excluded.anchor_fraction,updated_at=excluded.updated_at, device_id=excluded.device_id
    `).run(record.publicationId, record.articleId, Math.max(0, record.scrollTop), record.anchorBlockId,
      record.anchorTokenIndex, clampFraction(record.anchorFraction), record.updatedAt, record.deviceId)
    return true
  }

  private mergeUserLexeme(record: PortableUserData['userLexemes'][number], policy: PortableMergePolicy): boolean {
    const current = this.db.prepare('SELECT * FROM user_lexemes WHERE lexeme_key=?')
      .get(record.lexemeKey) as Row | undefined
    if (current && sameRawRecord({lexeme_key:record.lexemeKey,lemma_snapshot:record.lemmaSnapshot,phonetic_snapshot:record.phoneticSnapshot,
      brief_meanings_json:record.briefMeaningsJson,sense_groups_json:record.senseGroupsJson,bnc_rank:record.bncRank,frequency_rank:record.frequencyRank,
      manual_state:record.manualState,manual_familiarity:record.manualFamiliarity,created_at:record.createdAt,updated_at:record.updatedAt,device_id:record.deviceId},current)) return false
    if (current && policy === 'newer-wins' && compareVersionedRecord(record, {
      updatedAt: String(current.updated_at), deviceId: String(current.device_id),
    }) <= 0) return false
    JSON.parse(record.briefMeaningsJson); JSON.parse(record.senseGroupsJson)
    this.db.prepare(`
      INSERT INTO user_lexemes
        (lexeme_key, lemma_snapshot, phonetic_snapshot, brief_meanings_json, sense_groups_json,bnc_rank,frequency_rank,manual_state,
         manual_familiarity, created_at, updated_at, device_id,snapshot_provider,snapshot_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lexeme_key) DO UPDATE SET lemma_snapshot=excluded.lemma_snapshot,
        phonetic_snapshot=excluded.phonetic_snapshot, brief_meanings_json=excluded.brief_meanings_json,
        sense_groups_json=excluded.sense_groups_json,bnc_rank=excluded.bnc_rank,frequency_rank=excluded.frequency_rank,
        manual_state=excluded.manual_state, manual_familiarity=excluded.manual_familiarity,
        created_at=min(user_lexemes.created_at, excluded.created_at),
        updated_at=excluded.updated_at, device_id=excluded.device_id,
        snapshot_provider=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality THEN excluded.snapshot_provider ELSE user_lexemes.snapshot_provider END,
        snapshot_quality=max(user_lexemes.snapshot_quality,excluded.snapshot_quality)
    `).run(
      record.lexemeKey, record.lemmaSnapshot, record.phoneticSnapshot, record.briefMeaningsJson,record.senseGroupsJson,record.bncRank,record.frequencyRank,
      record.manualState, record.manualFamiliarity, record.createdAt, record.updatedAt, record.deviceId,
      record.snapshotProvider??'ecdict',record.snapshotQuality??10,
    )
    return true
  }

  private mergeStudyRows(table: string, keys: string[], records: Array<Record<string,string|number|null>>, lww: boolean, policy: PortableMergePolicy): number {
    if (!['study_plans','study_plan_sources','study_plan_lexeme_origins','study_plan_exclusions','scheduler_profiles','review_cards','review_events','reinforcement_events','review_suspensions','study_progress_state','study_lexeme_resets','lexeme_examples'].includes(table)) throw new Error('无效的学习备份表')
    let merged=0
    for(const record of records){
      const columns=Object.keys(record)
      if(!keys.every((key)=>columns.includes(key))||columns.some((key)=>!/^[a-z_]+$/.test(key))) throw new Error('学习备份记录无效')
      const current=this.db.prepare(`SELECT * FROM ${table} WHERE ${keys.map((key)=>`${key}=?`).join(' AND ')}`).get(...keys.map((key)=>record[key])) as Row|undefined
      if(current && sameRawRecord(record,current)) continue
      if(current&&(!lww || (policy === 'newer-wins' && compareRawVersion(record,current)<=0))) {
        if (!lww && !sameRawRecord(record,current)) throw new Error(`不可变学习记录冲突：${table}`)
        continue
      }
      const update=columns.filter((key)=>!keys.includes(key)).map((key)=>`${key}=excluded.${key}`).join(',')
      this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(${keys.join(',')}) DO ${update?`UPDATE SET ${update}`:'NOTHING'}`)
        .run(...columns.map((key)=>record[key]))
      merged++
    }
    return merged
  }

  private mergeVocabularySource(record: PortableUserData['vocabularySources'][number], policy: PortableMergePolicy): boolean {
    if (!this.db.prepare('SELECT 1 FROM user_lexemes WHERE lexeme_key=?').get(record.lexemeKey)) return false
    const current = this.db.prepare('SELECT * FROM vocabulary_sources WHERE source_id=?')
      .get(record.sourceId) as Row | undefined
    if (current && sameRawRecord({source_id:record.sourceId,lexeme_key:record.lexemeKey,source_type:record.sourceType,source_ref:record.sourceRef,
      active:record.active?1:0,added_at:record.addedAt,removed_at:record.removedAt,updated_at:record.updatedAt,device_id:record.deviceId},current)) return false
    if (current && policy === 'newer-wins' && compareVersionedRecord(record, {
      updatedAt: String(current.updated_at), deviceId: String(current.device_id),
    }) <= 0) return false
    this.db.prepare(`
      INSERT INTO vocabulary_sources
        (source_id, lexeme_key, source_type, source_ref, active, added_at, removed_at, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET active=excluded.active, removed_at=excluded.removed_at,
        updated_at=excluded.updated_at, device_id=excluded.device_id
    `).run(
      record.sourceId, record.lexemeKey, record.sourceType, record.sourceRef, record.active ? 1 : 0,
      record.addedAt, record.removedAt, record.updatedAt, record.deviceId,
    )
    return true
  }

  private mergeSavedContext(record: PortableUserData['savedContexts'][number], policy: PortableMergePolicy): boolean {
    if (!this.db.prepare('SELECT 1 FROM user_lexemes WHERE lexeme_key=?').get(record.lexemeKey)) return false
    const current = this.db.prepare('SELECT * FROM saved_contexts WHERE context_id=?')
      .get(record.contextId) as Row | undefined
    if (current && policy === 'newer-wins' && compareVersionedRecord(record, {
      updatedAt: String(current.updated_at), deviceId: String(current.device_id),
    }) <= 0) return false
    const publicationId = record.publicationId && this.db.prepare('SELECT 1 FROM publications WHERE id = ?').get(record.publicationId)
      ? record.publicationId : null
    const articleId = record.articleId && this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(record.articleId)
      ? record.articleId : null
    const blockId = record.blockId && this.db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(record.blockId)
      ? record.blockId : null
    if (current && sameRawRecord({context_id:record.contextId,lexeme_key:record.lexemeKey,surface:record.surface,publication_id:publicationId,
      publication_title_snapshot:record.publicationTitle,article_id:articleId,article_title_snapshot:record.articleTitle,block_id:blockId,
      token_index:record.tokenIndex,sentence_snapshot:record.sentence,paragraph_snapshot:record.paragraph,sentence_hash:record.sentenceHash,
      active:record.active?1:0,saved_at:record.savedAt,removed_at:record.removedAt,updated_at:record.updatedAt,device_id:record.deviceId},current)) return false
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
      record.contextId, record.lexemeKey, record.surface, publicationId, record.publicationTitle,
      articleId, record.articleTitle, blockId, record.tokenIndex, record.sentence, record.paragraph,
      record.sentenceHash, record.active ? 1 : 0, record.savedAt, record.removedAt,
      record.updatedAt, record.deviceId,
    )
    return true
  }

  private applyLexemeReset(lexemeKey: string, resetAt: string): void {
    this.db.prepare('DELETE FROM review_events WHERE lexeme_key=? AND reviewed_at<=?').run(lexemeKey, resetAt)
    this.db.prepare('DELETE FROM reinforcement_events WHERE lexeme_key=? AND created_at<=?').run(lexemeKey, resetAt)
    this.db.prepare('DELETE FROM review_cards WHERE lexeme_key=? AND updated_at<=?').run(lexemeKey, resetAt)
    this.db.prepare('DELETE FROM review_suspensions WHERE lexeme_key=? AND updated_at<=?').run(lexemeKey, resetAt)
  }
}

function compareRawVersion(incoming: Record<string,string|number|null>, current: Row): number {
  const incomingTime=String(incoming.updated_at??incoming.reviewed_at??incoming.created_at??'')
  const currentTime=String(current.updated_at??current.reviewed_at??current.created_at??'')
  return compareVersionedRecord(
    { updatedAt: incomingTime, deviceId: String(incoming.device_id ?? '') },
    { updatedAt: currentTime, deviceId: String(current.device_id ?? '') },
  )
}

function sameRawRecord(incoming: Record<string,string|number|null>, current: Row): boolean {
  return Object.entries(incoming).every(([key, value]) => (value == null ? current[key] == null : String(value) === String(current[key])))
}

function clampFraction(value: number): number { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) }
function maxReset(globalReset: string, selectiveReset?: string): string { return globalReset > (selectiveReset ?? '') ? globalReset : (selectiveReset ?? '') }

const nullableString = (value: unknown): string | null => value == null ? null : String(value)

function portableStudyPlan(row: Row): PortableUserData['studyPlans'][number] { return {
  planId:String(row.plan_id),name:String(row.name),status:String(row.status) as PortableUserData['studyPlans'][number]['status'],
  dailyNewLimit:Number(row.daily_new_limit),dailyReviewLimit:Number(row.daily_review_limit),
  newOrder:String(row.new_order) as PortableUserData['studyPlans'][number]['newOrder'],createdAt:String(row.created_at),
  updatedAt:String(row.updated_at),deviceId:String(row.device_id),deletedAt:nullableString(row.deleted_at),
} }
function dbStudyPlan(row: PortableUserData['studyPlans'][number]): Record<string,string|number|null> { return {
  plan_id:row.planId,name:row.name,status:row.status,daily_new_limit:row.dailyNewLimit,daily_review_limit:row.dailyReviewLimit,
  new_order:row.newOrder,created_at:row.createdAt,updated_at:row.updatedAt,device_id:row.deviceId,deleted_at:row.deletedAt,
} }
function portableStudyPlanSource(row:Row):PortableUserData['studyPlanSources'][number]{return{
  sourceId:String(row.source_id),planId:String(row.plan_id),sourceType:String(row.source_type) as PortableUserData['studyPlanSources'][number]['sourceType'],
  sourceRef:String(row.source_ref),active:Number(row.active)===1,addedAt:String(row.added_at),removedAt:nullableString(row.removed_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbStudyPlanSource(row:PortableUserData['studyPlanSources'][number]):Record<string,string|number|null>{return{
  source_id:row.sourceId,plan_id:row.planId,source_type:row.sourceType,source_ref:row.sourceRef,active:row.active?1:0,added_at:row.addedAt,removed_at:row.removedAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function portableStudyPlanOrigin(row:Row):PortableUserData['studyPlanOrigins'][number]{return{
  originId:String(row.origin_id),planId:String(row.plan_id),planSourceId:String(row.plan_source_id),lexemeKey:String(row.lexeme_key),active:Number(row.active)===1,
  discoveredAt:String(row.discovered_at),removedAt:nullableString(row.removed_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbStudyPlanOrigin(row:PortableUserData['studyPlanOrigins'][number]):Record<string,string|number|null>{return{
  origin_id:row.originId,plan_id:row.planId,plan_source_id:row.planSourceId,lexeme_key:row.lexemeKey,active:row.active?1:0,discovered_at:row.discoveredAt,removed_at:row.removedAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function portableStudyPlanExclusion(row:Row):PortableUserData['studyPlanExclusions'][number]{return{
  planId:String(row.plan_id),lexemeKey:String(row.lexeme_key),excluded:Number(row.excluded)===1,excludedAt:nullableString(row.excluded_at),restoredAt:nullableString(row.restored_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbStudyPlanExclusion(row:PortableUserData['studyPlanExclusions'][number]):Record<string,string|number|null>{return{
  plan_id:row.planId,lexeme_key:row.lexemeKey,excluded:row.excluded?1:0,excluded_at:row.excludedAt,restored_at:row.restoredAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function portableSchedulerProfile(row:Row):PortableUserData['schedulerProfiles'][number]{return{
  profileId:String(row.profile_id),fsrsVersion:String(row.fsrs_version),parametersJson:String(row.parameters_json),parametersHash:String(row.parameters_hash),createdAt:String(row.created_at),
}}
function dbSchedulerProfile(row:PortableUserData['schedulerProfiles'][number]):Record<string,string|number|null>{return{
  profile_id:row.profileId,fsrs_version:row.fsrsVersion,parameters_json:row.parametersJson,parameters_hash:row.parametersHash,created_at:row.createdAt,
}}
function portableReviewCard(row:Row):PortableUserData['reviewCards'][number]{return{
  lexemeKey:String(row.lexeme_key),dueAt:String(row.due_at),stability:Number(row.stability),difficulty:Number(row.difficulty),elapsedDays:Number(row.elapsed_days),scheduledDays:Number(row.scheduled_days),learningSteps:Number(row.learning_steps),reps:Number(row.reps),lapses:Number(row.lapses),state:Number(row.state),lastReviewAt:nullableString(row.last_review_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbReviewCard(row:PortableUserData['reviewCards'][number]):Record<string,string|number|null>{return{
  lexeme_key:row.lexemeKey,due_at:row.dueAt,stability:row.stability,difficulty:row.difficulty,elapsed_days:row.elapsedDays,scheduled_days:row.scheduledDays,learning_steps:row.learningSteps,reps:row.reps,lapses:row.lapses,state:row.state,last_review_at:row.lastReviewAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function portableReviewEvent(row:Row):PortableUserData['reviewEvents'][number]{return{
  eventId:String(row.event_id),commandId:String(row.command_id),lexemeKey:String(row.lexeme_key),planId:nullableString(row.plan_id),answer:String(row.answer) as 'known'|'unknown',rating:Number(row.rating),profileId:String(row.profile_id),preCardJson:String(row.pre_card_json),postCardJson:String(row.post_card_json),logJson:String(row.log_json),reviewedAt:String(row.reviewed_at),deviceId:String(row.device_id),
}}
function dbReviewEvent(row:PortableUserData['reviewEvents'][number]):Record<string,string|number|null>{return{
  event_id:row.eventId,command_id:row.commandId,lexeme_key:row.lexemeKey,plan_id:row.planId,answer:row.answer,rating:row.rating,profile_id:row.profileId,pre_card_json:row.preCardJson,post_card_json:row.postCardJson,log_json:row.logJson,reviewed_at:row.reviewedAt,device_id:row.deviceId,
}}
function portableReinforcementEvent(row:Row):PortableUserData['reinforcementEvents'][number]{return{
  eventId:String(row.event_id),commandId:String(row.command_id),lexemeKey:String(row.lexeme_key),planId:nullableString(row.plan_id),answer:String(row.answer) as 'known'|'unknown'|'too_easy',consecutiveBefore:Number(row.consecutive_before),consecutiveAfter:Number(row.consecutive_after),createdAt:String(row.created_at),deviceId:String(row.device_id),
}}
function dbReinforcementEvent(row:PortableUserData['reinforcementEvents'][number]):Record<string,string|number|null>{return{
  event_id:row.eventId,command_id:row.commandId,lexeme_key:row.lexemeKey,plan_id:row.planId,answer:row.answer,consecutive_before:row.consecutiveBefore,consecutive_after:row.consecutiveAfter,created_at:row.createdAt,device_id:row.deviceId,
}}
function portableReviewSuspension(row:Row):PortableUserData['reviewSuspensions'][number]{return{
  lexemeKey:String(row.lexeme_key),active:Number(row.active)===1,reason:String(row.reason),suspendedAt:String(row.suspended_at),restoredAt:nullableString(row.restored_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbReviewSuspension(row:PortableUserData['reviewSuspensions'][number]):Record<string,string|number|null>{return{
  lexeme_key:row.lexemeKey,active:row.active?1:0,reason:row.reason,suspended_at:row.suspendedAt,restored_at:row.restoredAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function portableStudyProgressState(row:Row):PortableUserData['studyProgressState'][number]{return{
  stateId:'global',resetAt:nullableString(row.reset_at),updatedAt:String(row.updated_at),deviceId:String(row.device_id),
}}
function dbStudyProgressState(row:PortableUserData['studyProgressState'][number]):Record<string,string|number|null>{return{
  state_id:row.stateId,reset_at:row.resetAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
function dbStudyLexemeReset(row:PortableUserData['studyLexemeResets'][number]):Record<string,string|number|null>{return{
  lexeme_key:row.lexemeKey,reset_at:row.resetAt,updated_at:row.updatedAt,device_id:row.deviceId,
}}
