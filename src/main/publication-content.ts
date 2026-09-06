import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

export const CONTENT_DIGEST_QUERIES = [
  'SELECT id,source_key,title,position FROM sections WHERE publication_id=? ORDER BY id',
  'SELECT id,section_id,source_key,title,rubric,published_at,position,source_href FROM articles WHERE publication_id=? ORDER BY id',
  'SELECT b.id,b.article_id,b.source_key,b.type,b.position,b.text,b.html,b.asset_path,b.alt FROM blocks b JOIN articles a ON a.id=b.article_id WHERE a.publication_id=? ORDER BY b.id',
] as const

/** v4 compares parsed content, so a repaired edition can reach a device with the same EPUB hash. */
export function publicationContentHash(
  database: DatabaseSync,
  publicationId: string,
): string {
  const key = `local.publication-digest.${publicationId}`
  const cached = database
    .prepare('SELECT value FROM settings WHERE key=?')
    .get(key)
  if (typeof cached?.value === 'string' && /^[a-f0-9]{64}$/.test(cached.value))
    return cached.value
  const rows = CONTENT_DIGEST_QUERIES.map((query) =>
    database
      .prepare(query)
      .all(publicationId)
      .map((row) => Object.values(row)),
  )
  const hash = createHash('sha256')
    .update(JSON.stringify([publicationId, ...rows]))
    .digest('hex')
  database
    .prepare(
      'INSERT OR REPLACE INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)',
    )
    .run(key, hash, new Date().toISOString(), 'local-cache')
  return hash
}
