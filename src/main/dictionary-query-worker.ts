import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import type {
  DictionaryCollection,
  DictionaryEntryResult,
  DictionarySearchItem,
  DictionarySearchQuery,
  LexemeCandidate,
  LexemeDetail,
} from '../shared/types'
import { chineseSearchTokens } from '../core/lexicon/identity'
import { conservativeLemmaCandidates, normalizeEnglishWord } from '../shared/word-utils'

type Row = Record<string, unknown>
type Request = { id: number; operation: string; payload?: any }

const paths = workerData as { basePath?: string; fullPath?: string | null; databasePath?: string }
const db = new DatabaseSync(String(paths.basePath ?? paths.databasePath), { readOnly: true })
const full = openCompatibleFull(paths.fullPath)

parentPort?.on('message', (request: Request) => {
  try {
    let result: unknown
    if (request.operation === 'search') result = search(request.payload as DictionarySearchQuery)
    else if (request.operation === 'getLexeme') result = getLexeme(String(request.payload))
    else if (request.operation === 'listCollections') result = listCollections()
    else if (request.operation === 'listCollectionMembers') result = listCollectionMembers(request.payload)
    else if (request.operation === 'resolve') result = resolve(String(request.payload))
    else if (request.operation === 'version') result = metadata('version')
    else if (request.operation === 'profile') result = full ? 'full' : 'standard'
    else if (request.operation === 'close') { full?.close(); db.close(); result = null }
    else throw new Error('未知词典查询操作')
    parentPort?.postMessage({ id: request.id, result })
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : '词典查询失败' })
  }
})

function search(query: DictionarySearchQuery) {
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 50))
  const offset = Math.max(0, Number(query.offset) || 0)
  const text = String(query.text ?? '').normalize('NFKC').trim()
  const where: string[] = []
  const params: Array<string | number> = []
  const chinese = /[\p{Script=Han}]/u.test(text)
  if (text) {
    if (chinese) {
      const ftsQuery = chineseSearchTokens(text).split(/\s+/).filter(Boolean).map(quoteFts).join(' AND ')
      where.push(`l.lexeme_id IN (
        SELECT e.lexeme_id FROM entries_fts JOIN entries e ON e.entry_id=entries_fts.rowid
        WHERE entries_fts MATCH ?
      )`)
      params.push(ftsQuery)
    } else {
      const normalized = normalizeEnglishWord(text)
      where.push(`(l.normalized = ? OR l.normalized LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM forms f WHERE f.lexeme_id=l.lexeme_id AND f.form = ? COLLATE NOCASE))`)
      params.push(normalized, `${escapeLike(normalized)}%`, normalized)
    }
  }
  const tags = [...new Set((query.tags ?? []).map((tag) => String(tag).toLowerCase()).filter(Boolean))]
  if (tags.length) {
    const placeholders = tags.map(() => '?').join(',')
    if (query.tagMatch === 'all') {
      where.push(`(SELECT COUNT(DISTINCT t.tag) FROM tags t WHERE t.lexeme_id=l.lexeme_id AND t.tag IN (${placeholders})) = ?`)
      params.push(...tags, tags.length)
    } else {
      where.push(`EXISTS (SELECT 1 FROM tags t WHERE t.lexeme_id=l.lexeme_id AND t.tag IN (${placeholders}))`)
      params.push(...tags)
    }
  }
  if (query.oxfordOnly) where.push('l.oxford > 0')
  if (query.collinsMin != null) { where.push('l.collins >= ?'); params.push(query.collinsMin) }
  if (query.bncMax != null) { where.push('l.bnc > 0 AND l.bnc <= ?'); params.push(query.bncMax) }
  if (query.contemporaryMax != null) { where.push('l.frq > 0 AND l.frq <= ?'); params.push(query.contemporaryMax) }
  const condition = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const normalizedText = normalizeEnglishWord(text)
  const relevance = text && !chinese
    ? `CASE WHEN l.normalized = '${sqlLiteral(normalizedText)}' THEN 0
        WHEN EXISTS (SELECT 1 FROM forms f WHERE f.lexeme_id=l.lexeme_id AND f.form='${sqlLiteral(normalizedText)}' COLLATE NOCASE) THEN 1 ELSE 2 END`
    : '(CASE WHEN 1=1 THEN 0 ELSE 1 END)'
  const order = query.sort === 'alphabetical' ? 'l.lemma COLLATE NOCASE'
    : query.sort === 'frequency' ? 'COALESCE(NULLIF(l.frq,0), NULLIF(l.bnc,0), 99999999), l.lemma COLLATE NOCASE'
      : `${relevance}, COALESCE(NULLIF(l.frq,0), NULLIF(l.bnc,0), 99999999), l.lemma COLLATE NOCASE`
  const total = db.prepare(`SELECT COUNT(*) AS count FROM lexemes l ${condition}`).get(...params) as Row
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT group_concat(tag, ' ') FROM tags t WHERE t.lexeme_id=l.lexeme_id) AS tags,
      (SELECT translation FROM entries e WHERE e.lexeme_id=l.lexeme_id ORDER BY e.entry_id LIMIT 1) AS translation,
      CASE WHEN ? <> '' AND EXISTS (SELECT 1 FROM forms f WHERE f.lexeme_id=l.lexeme_id AND f.form=? COLLATE NOCASE)
        THEN 'form' ELSE ${chinese ? "'translation'" : text ? "'lemma'" : "'filter'"} END AS matched_by
    FROM lexemes l ${condition} ORDER BY ${order} LIMIT ? OFFSET ?
  `).all(normalizedText, normalizedText, ...params, limit, offset) as Row[]
  return { items: rows.map(mapSearchItem), total: Number(total.count), offset, limit }
}

function getLexeme(key: string): LexemeDetail {
  const row = db.prepare(`
    SELECT l.*, (SELECT group_concat(tag, ' ') FROM tags t WHERE t.lexeme_id=l.lexeme_id) AS tags,
      (SELECT translation FROM entries e WHERE e.lexeme_id=l.lexeme_id ORDER BY e.entry_id LIMIT 1) AS translation
    FROM lexemes l WHERE l.lexeme_key=?
  `).get(key) as Row | undefined
  if (!row) return getExtraLexeme(key)
  const lexemeId = Number(row.lexeme_id)
  const entries = (db.prepare('SELECT * FROM entries WHERE lexeme_id=? ORDER BY entry_id').all(lexemeId) as Row[]).map((entry) => {
    const extra = full?.prepare('SELECT definition,detail FROM full_entries WHERE entry_id=? AND lexeme_key=?').get(Number(entry.entry_id), key) as Row | undefined
    return mapEntry({ ...entry, definition: extra?.definition, detail: extra?.detail })
  })
  const forms = (db.prepare('SELECT form FROM forms WHERE lexeme_id=? ORDER BY form').all(lexemeId) as Row[]).map((item) => String(item.form))
  const collections = (db.prepare(`
    SELECT c.id, c.tag, c.name, (SELECT COUNT(*) FROM collection_items x WHERE x.collection_id=c.id) AS count
    FROM collections c JOIN collection_items i ON i.collection_id=c.id WHERE i.lexeme_id=? ORDER BY c.name
  `).all(lexemeId) as Row[]).map(mapCollection)
  return { ...mapSearchItem({ ...row, matched_by: 'lemma' }), entries, forms, collections,
    providerId: 'ecdict' as const, examples: [], similarWords: [] }
}

function listCollections(): DictionaryCollection[] {
  return (db.prepare(`
    SELECT c.id, c.tag, c.name, COUNT(i.lexeme_id) AS count FROM collections c
    JOIN collection_items i ON i.collection_id=c.id GROUP BY c.id HAVING count > 0 ORDER BY c.name
  `).all() as Row[]).map(mapCollection)
}

function listCollectionMembers(payload: { tag: string; offset: number; limit: number }) {
  const tag = String(payload.tag ?? '').toLowerCase()
  const offset = Math.max(0, Number(payload.offset) || 0)
  const limit = Math.min(1000, Math.max(1, Number(payload.limit) || 500))
  const collection = db.prepare('SELECT id FROM collections WHERE tag=? COLLATE NOCASE').get(tag) as Row | undefined
  if (!collection) return { items: [], total: 0, offset, limit }
  const total = db.prepare('SELECT COUNT(*) AS count FROM collection_items WHERE collection_id=?')
    .get(String(collection.id)) as Row
  const rows = db.prepare(`
    WITH page AS (
      SELECT l.lexeme_id FROM collection_items i JOIN lexemes l ON l.lexeme_id=i.lexeme_id
      WHERE i.collection_id=?
      ORDER BY COALESCE(NULLIF(l.frq,0),NULLIF(l.bnc,0),99999999), l.lemma COLLATE NOCASE
      LIMIT ? OFFSET ?
    )
    SELECT l.*,
      e.entry_id AS entry_id, e.word AS entry_word, e.phonetic AS entry_phonetic,
      e.translation AS entry_translation,
      e.pos AS entry_pos, e.tag AS entry_tag, e.bnc AS entry_bnc,
      e.frq AS entry_frq
    FROM page p JOIN lexemes l ON l.lexeme_id=p.lexeme_id
    LEFT JOIN entries e ON e.lexeme_id=l.lexeme_id
    ORDER BY COALESCE(NULLIF(l.frq,0),NULLIF(l.bnc,0),99999999), l.lemma COLLATE NOCASE, e.entry_id
  `).all(String(collection.id), limit, offset) as Row[]
  const grouped = new Map<string, { lexeme: Row; entries: DictionaryEntryResult[] }>()
  for (const row of rows) {
    const key = String(row.lexeme_key)
    if (!grouped.has(key)) grouped.set(key, { lexeme: row, entries: [] })
    if (row.entry_id != null) grouped.get(key)!.entries.push(mapEntry({
      word: row.entry_word, phonetic: row.entry_phonetic,
      translation: row.entry_translation, definition: null,
      pos: row.entry_pos, tag: row.entry_tag, bnc: row.entry_bnc,
      frq: row.entry_frq, exchange: null,
    }))
  }
  return {
    items: [...grouped.values()].map(({ lexeme, entries }) => {
      const summary = mapSearchItem({
        ...lexeme,
        translation: entries[0]?.senses.flatMap((sense) => sense.translations).join('\n') ?? '',
        matched_by: 'filter',
      })
      return {
        lexemeKey: summary.lexemeKey, lemma: summary.lemma, phonetic: summary.phonetic,
        briefMeanings: summary.briefMeanings,
        senses: entries.flatMap((entry) => entry.senses),
        bnc: summary.frequency.bnc, frequency: summary.frequency.contemporary,
      }
    }),
    total: Number(total.count), offset, limit,
  }
}

function resolve(surface: string): LexemeCandidate[] {
  const normalized = normalizeEnglishWord(surface)
  const candidates = new Map<string, { relation: LexemeCandidate['relation']; confidence: number }>()
  const exact = db.prepare('SELECT lexeme_key FROM lexemes WHERE normalized=? COLLATE NOCASE').get(normalized) as Row | undefined
  if (exact) candidates.set(String(exact.lexeme_key), { relation: 'exact', confidence: 1 })
  for (const row of db.prepare('SELECT l.lexeme_key FROM forms f JOIN lexemes l ON l.lexeme_id=f.lexeme_id WHERE f.form=? COLLATE NOCASE LIMIT 12').all(normalized) as Row[]) {
    const key = String(row.lexeme_key)
    if (!candidates.has(key)) candidates.set(key, { relation: 'inflection', confidence: .82 })
  }
  for (const lemma of conservativeLemmaCandidates(normalized)) {
    const row = db.prepare('SELECT lexeme_key FROM lexemes WHERE normalized=? COLLATE NOCASE').get(lemma) as Row | undefined
    if (row && !candidates.has(String(row.lexeme_key))) {
      candidates.set(String(row.lexeme_key), { relation: 'heuristic', confidence: .55 })
    }
  }
  if(full){
    const exactExtra=full.prepare('SELECT lexeme_key FROM extra_lexemes WHERE normalized=? COLLATE NOCASE').get(normalized) as Row|undefined
    if(exactExtra)candidates.set(String(exactExtra.lexeme_key),{relation:'exact',confidence:1})
    for(const row of full.prepare('SELECT lexeme_key FROM extra_forms WHERE form=? COLLATE NOCASE LIMIT 12').all(normalized) as Row[]){const key=String(row.lexeme_key);if(!candidates.has(key))candidates.set(key,{relation:'inflection',confidence:.82})}
  }
  return [...candidates.entries()].map(([key, resolution]) => {
    const detail = getLexeme(key)
    return {
      lexemeKey: key, lemma: detail.lemma, relation: resolution.relation,
      confidence: resolution.confidence, phonetic: detail.phonetic, briefMeanings: detail.briefMeanings,
    }
  }).sort((left, right) => right.confidence - left.confidence || left.lemma.localeCompare(right.lemma))
}

function getExtraLexeme(key:string):LexemeDetail{
  if(!full)throw new Error('未找到该词条')
  const row=full.prepare(`SELECT x.*,(SELECT tag FROM extra_entries e WHERE e.lexeme_key=x.lexeme_key LIMIT 1) tags,
    (SELECT translation FROM extra_entries e WHERE e.lexeme_key=x.lexeme_key LIMIT 1) translation FROM extra_lexemes x WHERE lexeme_key=?`).get(key) as Row|undefined
  if(!row)throw new Error('未找到该词条')
  const entries=(full.prepare('SELECT * FROM extra_entries WHERE lexeme_key=? ORDER BY entry_id').all(key) as Row[]).map(mapEntry)
  const forms=(full.prepare('SELECT form FROM extra_forms WHERE lexeme_key=? ORDER BY form').all(key) as Row[]).map(item=>String(item.form))
  return{...mapSearchItem({...row,matched_by:'lemma'}),entries,forms,collections:[],providerId:'ecdict',examples:[],similarWords:[]}
}

function mapSearchItem(row: Row): DictionarySearchItem {
  return {
    lexemeKey: String(row.lexeme_key), lemma: String(row.lemma),
    phonetic: row.phonetic == null ? null : String(row.phonetic),
    briefMeanings: splitLines(row.translation).slice(0, 3),
    tags: String(row.tags ?? '').split(/\s+/).filter(Boolean),
    collins: numberOrNull(row.collins), oxford: Number(row.oxford ?? 0) > 0,
    frequency: { bnc: numberOrNull(row.bnc), contemporary: numberOrNull(row.frq) },
    matchedBy: String(row.matched_by ?? 'lemma') as DictionarySearchItem['matchedBy'],
  }
}

function mapEntry(row: Row): DictionaryEntryResult {
  return {
    word: String(row.word), phonetic: row.phonetic == null ? null : String(row.phonetic),
    senses: groupSenses(row.translation, row.definition), positionWeights: row.pos == null ? null : String(row.pos),
    tags: String(row.tag ?? '').split(/\s+/).filter(Boolean),
    frequency: { bnc: numberOrNull(row.bnc), contemporary: numberOrNull(row.frq) },
    exchanges: String(row.exchange ?? '').split('/').map((item) => item.trim()).filter(Boolean),
  }
}

function groupSenses(translation: unknown, definition: unknown) {
  const groups = new Map<string, { partOfSpeech: string; translations: string[]; definitions: string[] }>()
  const ensure = (pos: string) => {
    if (!groups.has(pos)) groups.set(pos, { partOfSpeech: pos, translations: [], definitions: [] })
    return groups.get(pos)!
  }
  let previous: string | null = null
  for (const line of splitLines(translation)) {
    const parsed = parsePosLine(line)
    const pos: string = parsed.pos ?? previous ?? '其他'
    if (!ensure(pos).translations.includes(parsed.text)) ensure(pos).translations.push(parsed.text)
    previous = pos
  }
  previous = null
  for (const line of splitLines(definition)) {
    const parsed = parsePosLine(line)
    const pos: string = parsed.pos ?? previous ?? (groups.size === 1 ? [...groups.keys()][0] : '其他')
    if (!ensure(pos).definitions.includes(parsed.text)) ensure(pos).definitions.push(parsed.text)
    previous = pos
  }
  return [...groups.values()]
}

function parsePosLine(line: string): { pos: string | null; text: string } {
  const match = line.match(/^([a-z][a-z-]{0,10})(?:\.\s*|\s+)(.+)$/i)
  if (!match) return { pos: null, text: line.trim() }
  const labels: Record<string, string> = {
    n: '名词 · n.', noun: '名词 · n.', v: '动词 · v.', verb: '动词 · v.',
    vt: '及物动词 · vt.', vi: '不及物动词 · vi.', a: '形容词 · adj.', s: '形容词 · adj.',
    j: '形容词 · adj.', adj: '形容词 · adj.', r: '副词 · adv.', d: '副词 · adv.',
    adv: '副词 · adv.', p: '介词 · prep.', prep: '介词 · prep.', c: '连词 · conj.',
    conj: '连词 · conj.', pron: '代词 · pron.', num: '数词 · num.', art: '冠词 · art.', aux: '助动词 · aux.',
  }
  const code = match[1].toLowerCase()
  return { pos: labels[code] ?? `其他 · ${code}`, text: match[2].trim() }
}

function mapCollection(row: Row): DictionaryCollection {
  return { id: String(row.id), tag: String(row.tag), name: String(row.name), count: Number(row.count) }
}
function metadata(key: string): string {
  return String((db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as Row | undefined)?.value ?? 'unknown')
}
function openCompatibleFull(fullPath: string | null | undefined): DatabaseSync | null {
  if (!fullPath) return null
  try {
    const candidate = new DatabaseSync(fullPath, { readOnly: true })
    const value = (source: DatabaseSync, key: string) => String((source.prepare('SELECT value FROM metadata WHERE key=?').get(key) as Row|undefined)?.value ?? '')
    if (value(candidate, 'schemaVersion') !== '1' || value(candidate, 'datasetRevision') !== value(db, 'datasetRevision')
      || value(candidate, 'lexemeMapHash') !== value(db, 'lexemeMapHash')) { candidate.close(); return null }
    return candidate
  } catch { return null }
}
function splitLines(value: unknown): string[] { return String(value ?? '').split(/\\n|\r?\n/).map((x) => x.trim()).filter(Boolean) }
function numberOrNull(value: unknown): number | null { const n = Number(value); return value == null || !Number.isFinite(n) || n <= 0 ? null : n }
function quoteFts(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (character) => `\\${character}`) }
function sqlLiteral(value: string): string { return value.replaceAll("'", "''") }
