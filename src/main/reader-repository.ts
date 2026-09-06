import { canonicalJson } from '../core/canonical-json'
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  validateReaderRecord,
  type ReaderRecord,
  type SavedTranslationSegment,
} from '../core/reader-records'
import type {
  ArticleReadingChange,
  ArticleReadingData,
  ArticleSearchPage,
  ArticleSearchQuery,
} from '../shared/reader-types'
import type { ReadingPositionSnapshot } from '../shared/types'

type Row = Record<string, unknown>
export class ReaderRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deviceId: string,
  ) {}

  write(
    publicationId: string,
    articleId: string,
    kind: ReaderRecord['kind'],
    value: unknown,
    recordId = `${kind}:${articleId}`,
    updatedAt = new Date().toISOString(),
  ): void {
    const record: ReaderRecord = {
      recordId,
      publicationId,
      articleId,
      kind,
      payload: canonicalJson(value),
      updatedAt,
      deviceId: this.deviceId,
    }
    validateReaderRecord(record)
    this.db
      .prepare(
        `INSERT INTO reader_records(record_id,publication_id,article_id,kind,payload,updated_at,device_id)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,device_id=excluded.device_id
      WHERE reader_records.payload<>excluded.payload`,
      )
      .run(
        recordId,
        publicationId,
        articleId,
        kind,
        record.payload,
        updatedAt,
        this.deviceId,
      )
  }

  position(articleId: string): ReadingPositionSnapshot | null {
    return this.value(`position:${articleId}`) as ReadingPositionSnapshot | null
  }

  private value(recordId: string): unknown {
    const row = this.db
      .prepare('SELECT payload FROM reader_records WHERE record_id=?')
      .get(recordId) as Row | undefined
    return row ? JSON.parse(String(row.payload)) : null
  }

  private publicationId(articleId: string): string {
    const row = this.db
      .prepare('SELECT publication_id FROM articles WHERE id=?')
      .get(articleId) as Row | undefined
    if (!row) throw new Error('未找到该文章')
    return String(row.publication_id)
  }

  get(articleId: string): ArticleReadingData {
    this.publicationId(articleId)
    const versions = this.db
      .prepare(
        `SELECT json_extract(payload,'$.versionId') AS id, min(updated_at) AS created_at,
      json_group_array(DISTINCT json_extract(payload,'$.model')) AS models, count(*) AS segments
      FROM reader_records WHERE article_id=? AND kind='translation'
      GROUP BY json_extract(payload,'$.versionId') ORDER BY created_at DESC,id`,
      )
      .all(articleId) as Row[]
    return {
      bookmarked: this.value(`bookmark:${articleId}`) === true,
      read: this.value(`read:${articleId}`) === true,
      selectedVersionId: this.value(`translation-selection:${articleId}`) as
        | string
        | null,
      versions: versions.map((row) => ({
        id: String(row.id),
        createdAt: String(row.created_at),
        models: JSON.parse(String(row.models)),
        segmentCount: Number(row.segments),
      })),
    }
  }

  change(articleId: string, change: ArticleReadingChange): ArticleReadingData {
    const publicationId = this.publicationId(articleId)
    if (change.kind === 'preserve-translation')
      this.preserveTranslations(articleId)
    else {
      if (
        change.kind === 'translation-selection' &&
        change.value !== null &&
        !this.get(articleId).versions.some(
          (version) => version.id === change.value,
        )
      )
        throw new Error('未找到保留的译文版本')
      this.write(publicationId, articleId, change.kind, change.value)
    }
    return this.get(articleId)
  }

  selectedTranslations(
    articleId: string,
  ): Map<string, SavedTranslationSegment> | null {
    const selected = this.value(`translation-selection:${articleId}`)
    if (typeof selected !== 'string') return null
    const rows = this.db
      .prepare(
        `SELECT payload FROM reader_records WHERE article_id=? AND kind='translation' AND json_extract(payload,'$.versionId')=?`,
      )
      .all(articleId, selected) as Row[]
    return new Map(
      rows.map((row) => {
        const segment = JSON.parse(
          String(row.payload),
        ) as SavedTranslationSegment
        return [segment.blockId, segment]
      }),
    )
  }

  preserveTranslations(articleId: string): string | null {
    const publicationId = this.publicationId(articleId)
    const rows = this.db
      .prepare(
        `SELECT b.id,b.text AS source,t.source_hash,t.model,t.prompt_version,t.text
      FROM blocks b JOIN translations t ON t.rowid=(SELECT t2.rowid FROM translations t2 WHERE t2.block_id=b.id
      AND t2.target_language='zh-CN' ORDER BY t2.created_at DESC,t2.model,t2.prompt_version LIMIT 1)
      WHERE b.article_id=? ORDER BY b.id`,
      )
      .all(articleId) as Row[]
    const segments = rows
      .filter(
        (row) =>
          createHash('sha256').update(String(row.source)).digest('hex') ===
          row.source_hash,
      )
      .map((row) => [
        String(row.id),
        String(row.source_hash),
        String(row.model),
        String(row.prompt_version),
        String(row.text),
      ])
    if (!segments.length) return null
    const versionId = createHash('sha256')
      .update(JSON.stringify([articleId, segments]))
      .digest('hex')
    const timestamp = new Date().toISOString()
    this.db.exec('SAVEPOINT preserve_translation')
    try {
      for (const [
        blockId,
        sourceHash,
        model,
        promptVersion,
        text,
      ] of segments) {
        const recordId = `translation:${versionId}:${blockId}`
        if (
          !this.db
            .prepare('SELECT 1 FROM reader_records WHERE record_id=?')
            .get(recordId)
        ) {
          this.write(
            publicationId,
            articleId,
            'translation',
            { versionId, blockId, sourceHash, model, promptVersion, text },
            recordId,
            timestamp,
          )
        }
      }
      this.db.exec('RELEASE preserve_translation')
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO preserve_translation; RELEASE preserve_translation',
      )
      throw error
    }
    return versionId
  }

  search(query: ArticleSearchQuery): ArticleSearchPage {
    if (
      !query ||
      typeof query.text !== 'string' ||
      query.text.length > 500 ||
      !['all', 'bookmarked', 'read', 'unread'].includes(query.filter) ||
      !Number.isSafeInteger(query.offset) ||
      query.offset < 0 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    )
      throw new Error('文章搜索参数无效')
    const tokens = query.text.trim().split(/\s+/u).filter(Boolean)
    const match = tokens
      .map((token) => `"${token.replaceAll('"', '""')}"*`)
      .join(' AND ')
    const bookmark =
      "EXISTS(SELECT 1 FROM reader_records r WHERE r.record_id='bookmark:'||a.id AND r.payload='true')"
    const read =
      "EXISTS(SELECT 1 FROM reader_records r WHERE r.record_id='read:'||a.id AND r.payload='true')"
    const filter =
      query.filter === 'bookmarked'
        ? bookmark
        : query.filter === 'read'
          ? read
          : query.filter === 'unread'
            ? `NOT ${read}`
            : '1'
    const where = `WHERE ${filter} ${tokens.length ? `AND (a.title LIKE ? ESCAPE '\\' OR a.id IN (SELECT b.article_id FROM reader_search JOIN blocks b ON b.rowid=reader_search.rowid WHERE reader_search MATCH ?))` : ''}`
    const parameters = tokens.length
      ? [`%${query.text.trim().replace(/[\\%_]/g, '\\$&')}%`, match]
      : []
    const total = Number(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM articles a ${where}`)
          .get(...parameters) as Row
      ).n,
    )
    const rows = this.db
      .prepare(
        `SELECT a.id,a.publication_id,a.title,p.title AS publication_title,${bookmark} AS bookmarked,${read} AS has_read,
      COALESCE((SELECT substr(b.text,1,220) FROM blocks b WHERE b.article_id=a.id AND b.text IS NOT NULL AND b.type<>'heading' ORDER BY b.position LIMIT 1),'') AS excerpt
      FROM articles a JOIN publications p ON p.id=a.publication_id ${where} ORDER BY p.imported_at DESC,a.position,a.id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, query.limit, query.offset) as Row[]
    return {
      items: rows.map((row) => ({
        articleId: String(row.id),
        publicationId: String(row.publication_id),
        title: String(row.title),
        publicationTitle: String(row.publication_title),
        excerpt: String(row.excerpt),
        bookmarked: Boolean(row.bookmarked),
        read: Boolean(row.has_read),
      })),
      total,
      offset: query.offset,
      limit: query.limit,
    }
  }
}
