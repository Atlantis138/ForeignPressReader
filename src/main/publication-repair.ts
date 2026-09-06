import { publicationContentHash } from './publication-content'
import type { DatabaseSync } from 'node:sqlite'
import type { ParsedPublicationPlan } from '../shared/types'

/** Add newly understood content without deleting IDs referenced by user data. */
export function repairPublication(
  database: DatabaseSync,
  plan: ParsedPublicationPlan,
  deviceId: string,
): boolean {
  const current = database
    .prepare('SELECT hash FROM publications WHERE id=?')
    .get(plan.id)
  if (!current || current.hash !== plan.hash)
    throw new Error('重新解析必须使用原来的同一份 EPUB')
  const before = publicationContentHash(database, plan.id)
  let added = 0
  const checkIdentity = (
    table: 'sections' | 'articles' | 'blocks',
    id: string,
    parent: string,
    parentColumn: 'publication_id' | 'article_id',
    sourceKey: string,
  ) => {
    const row = database
      .prepare(`SELECT ${parentColumn},source_key FROM ${table} WHERE id=?`)
      .get(id)
    if (row && (row[parentColumn] !== parent || row.source_key !== sourceKey))
      throw new Error('重新解析后的内容身份冲突，已保留原数据')
    if (!row) added++
  }
  database.exec('SAVEPOINT repair_publication')
  try {
    const insertArticle = (
      article: ParsedPublicationPlan['unsectionedArticles'][number],
      sectionId: string | null,
    ) => {
      checkIdentity(
        'articles',
        article.id,
        plan.id,
        'publication_id',
        article.sourceKey,
      )
      database
        .prepare(
          `INSERT INTO articles(id,publication_id,section_id,source_key,title,rubric,published_at,position,source_href)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,section_id=excluded.section_id,title=excluded.title,rubric=excluded.rubric`,
        )
        .run(
          article.id,
          plan.id,
          sectionId,
          article.sourceKey,
          article.title,
          article.rubric,
          article.publishedAt,
          article.position,
          article.sourceHref,
        )
      for (const block of article.blocks) {
        checkIdentity(
          'blocks',
          block.id,
          article.id,
          'article_id',
          block.sourceKey,
        )
        const existing = database
          .prepare('SELECT text FROM blocks WHERE id=?')
          .get(block.id)
        if (existing && existing.text !== block.text)
          throw new Error('重新解析后的原文身份冲突，已保留原数据')
        database
          .prepare(
            `INSERT INTO blocks(id,article_id,source_key,type,position,text,html,asset_path,alt) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET position=excluded.position`,
          )
          .run(
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
    for (const section of plan.sections) {
      checkIdentity(
        'sections',
        section.id,
        plan.id,
        'publication_id',
        section.sourceKey,
      )
      database
        .prepare(
          'INSERT INTO sections(id,publication_id,source_key,title,position) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,title=excluded.title',
        )
        .run(
          section.id,
          plan.id,
          section.sourceKey,
          section.title,
          section.position,
        )
      for (const article of section.articles) insertArticle(article, section.id)
    }
    for (const article of plan.unsectionedArticles) insertArticle(article, null)
    database
      .prepare(
        `UPDATE publications SET article_count=(SELECT count(*) FROM articles WHERE publication_id=?),section_count=(SELECT count(*) FROM sections WHERE publication_id=?) WHERE id=?`,
      )
      .run(plan.id, plan.id, plan.id)
    const changed = added > 0 || publicationContentHash(database, plan.id) !== before
    if (changed)
      database
        .prepare(
          'UPDATE publication_lifecycle SET changed_at=?,device_id=? WHERE publication_id=?',
        )
        .run(new Date().toISOString(), deviceId, plan.id)
    database.exec('RELEASE repair_publication')
    return changed
  } catch (error) {
    database.exec('ROLLBACK TO repair_publication; RELEASE repair_publication')
    throw error
  }
}
