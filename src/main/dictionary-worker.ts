import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'csv-parse'
import { normalizeEnglishWord } from '../shared/word-utils'
import { chineseSearchTokens, createLexemeKey } from '../core/lexicon/identity'
import { ECDICT_COMMIT } from './dictionary-source'

interface WorkerInput {
  mode: 'local'
  profile?: 'standard' | 'full'
  stagingRoot: string
  csvPath?: string
  lemmaPath?: string
}

const COLLECTIONS: Record<string, string> = {
  zk: '中考', gk: '高考', cet4: '大学英语四级', cet6: '大学英语六级',
  ky: '考研英语', toefl: '托福', ielts: '雅思', gre: 'GRE',
}
const hasher = { sha256: (value: string) => crypto.createHash('sha256').update(value).digest('hex') }
const input = workerData as WorkerInput

void run().catch((error) => parentPort?.postMessage({
  type: 'error', message: error instanceof Error ? error.message : '词典安装失败',
}))

async function run(): Promise<void> {
  fs.mkdirSync(input.stagingRoot, { recursive: true })
  if (!input.csvPath || !fs.existsSync(input.csvPath)) throw new Error('未找到 ecdict.csv')
  const profile = input.profile ?? 'standard'
  const basePath = path.join(input.stagingRoot, 'ecdict-base.sqlite')
  const fullPath = path.join(input.stagingRoot, 'ecdict-full.sqlite')
  const base = new DatabaseSync(basePath)
  const full = profile === 'full' ? new DatabaseSync(fullPath) : null
  let closed = false
  try {
    createBaseSchema(base)
    if (full) createFullSchema(full)
    const insertCollection = base.prepare('INSERT INTO collections (id,tag,name) VALUES (?,?,?)')
    for (const [tag, name] of Object.entries(COLLECTIONS)) insertCollection.run(`ecdict:${tag}`, tag, name)
    const insertLexeme = base.prepare(`INSERT INTO lexemes(lexeme_key,language,lemma,normalized,phonetic,collins,oxford,bnc,frq)
      VALUES(?,'en',?,?,?,?,?,?,?) ON CONFLICT(lexeme_key) DO UPDATE SET
      phonetic=COALESCE(lexemes.phonetic,excluded.phonetic),collins=max(COALESCE(lexemes.collins,0),COALESCE(excluded.collins,0)),
      oxford=max(lexemes.oxford,excluded.oxford),bnc=min(COALESCE(lexemes.bnc,excluded.bnc),COALESCE(excluded.bnc,lexemes.bnc)),
      frq=min(COALESCE(lexemes.frq,excluded.frq),COALESCE(excluded.frq,lexemes.frq))`)
    const selectLexeme = base.prepare('SELECT lexeme_id FROM lexemes WHERE lexeme_key=?')
    const insertEntry = base.prepare(`INSERT INTO entries(lexeme_id,word,phonetic,translation,pos,tag,bnc,frq)
      VALUES(?,?,?,?,?,?,?,?)`)
    const insertFull = full?.prepare('INSERT INTO full_entries(entry_id,lexeme_key,definition,detail) VALUES(?,?,?,?)')
    const insertExtraLexeme=full?.prepare(`INSERT INTO extra_lexemes(lexeme_key,lemma,normalized,phonetic,collins,oxford,bnc,frq) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(lexeme_key) DO UPDATE SET phonetic=COALESCE(extra_lexemes.phonetic,excluded.phonetic)`)
    const insertExtraEntry=full?.prepare('INSERT INTO extra_entries(lexeme_key,word,phonetic,translation,pos,tag,bnc,frq,definition,detail) VALUES(?,?,?,?,?,?,?,?,?,?)')
    const insertExtraForm=full?.prepare('INSERT OR IGNORE INTO extra_forms(form,lexeme_key,lemma,relation) VALUES(?,?,?,?)')
    const insertForm = base.prepare('INSERT OR IGNORE INTO forms(form,lexeme_id,lemma,relation) VALUES(?,?,?,?)')
    const insertTag = base.prepare('INSERT OR IGNORE INTO tags(lexeme_id,tag) VALUES(?,?)')
    const insertCollectionItem = base.prepare('INSERT OR IGNORE INTO collection_items(collection_id,lexeme_id) VALUES(?,?)')
    const insertFts = base.prepare('INSERT INTO entries_fts(rowid,cjk_tokens) VALUES(?,?)')
    let entryCount = 0
    let totalEntryCount = 0
    base.exec('BEGIN')
    full?.exec('BEGIN')
    const parser = fs.createReadStream(input.csvPath).pipe(parse({
      columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true,
    }))
    for await (const raw of parser) {
      const row = raw as Record<string, string>
      const word = String(row.word ?? '').trim()
      const normalized = normalizeEnglishWord(word)
      if (!normalized) continue
      const key = createLexemeKey(hasher, 'en', normalized)
      const collins = integerOrNull(row.collins), oxford = integerOrNull(row.oxford)
      const bnc = integerOrNull(row.bnc), frq = integerOrNull(row.frq)
      totalEntryCount++
      const standard=isStandardEntry(row,collins,oxford,bnc,frq)
      if(!standard){
        if(full){insertExtraLexeme?.run(key,word,normalized,nullIfEmpty(row.phonetic),collins,oxford??0,bnc,frq)
          insertExtraEntry?.run(key,word,nullIfEmpty(row.phonetic),nullIfEmpty(row.translation),nullIfEmpty(row.pos),nullIfEmpty(row.tag),bnc,frq,nullIfEmpty(row.definition),nullIfEmpty(row.detail))
          for(const form of exchangeForms(row.exchange))insertExtraForm?.run(normalizeEnglishWord(form),key,normalized,'exchange')}
        if(totalEntryCount%5_000===0){base.exec('COMMIT; BEGIN');full?.exec('COMMIT; BEGIN');progress('indexing-entries',totalEntryCount)}
        continue
      }
      insertLexeme.run(key, word, normalized, nullIfEmpty(row.phonetic), collins, oxford ?? 0, bnc, frq)
      const lexemeId = Number((selectLexeme.get(key) as { lexeme_id: number }).lexeme_id)
      const result = insertEntry.run(lexemeId, word, nullIfEmpty(row.phonetic), nullIfEmpty(row.translation),
        nullIfEmpty(row.pos), nullIfEmpty(row.tag), bnc, frq)
      const entryId = Number(result.lastInsertRowid)
      insertFull?.run(entryId, key, nullIfEmpty(row.definition), nullIfEmpty(row.detail))
      insertFts.run(entryId, chineseSearchTokens(row.translation ?? ''))
      for (const tag of String(row.tag ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
        insertTag.run(lexemeId, tag)
        if (COLLECTIONS[tag]) insertCollectionItem.run(`ecdict:${tag}`, lexemeId)
      }
      for (const form of exchangeForms(row.exchange)) {
        insertForm.run(normalizeEnglishWord(form), lexemeId, normalized, 'exchange')
      }
      entryCount++
      if (totalEntryCount % 5_000 === 0) {
        base.exec('COMMIT; BEGIN'); full?.exec('COMMIT; BEGIN')
        progress('indexing-entries', totalEntryCount)
      }
    }
    base.exec('COMMIT'); full?.exec('COMMIT')
    if (input.lemmaPath && fs.existsSync(input.lemmaPath)) {
      base.exec('BEGIN')
      let processed = 0
      for (const line of fs.readFileSync(input.lemmaPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^(.+?)\/\d+\s*->\s*(.+)$/)
        if (!match) continue
        const lemma = normalizeEnglishWord(match[1])
        const lexeme = selectLexeme.get(createLexemeKey(hasher, 'en', lemma)) as { lexeme_id: number } | undefined
        const extraKey=createLexemeKey(hasher,'en',lemma)
        if (!lexeme && !full?.prepare('SELECT 1 FROM extra_lexemes WHERE lexeme_key=?').get(extraKey)) continue
        for (const form of match[2].split(',')) {
          const normalized = normalizeEnglishWord(form)
          if (normalized && normalized !== lemma) {
            if(lexeme)insertForm.run(normalized, lexeme.lexeme_id, lemma, 'lemma-db')
            else insertExtraForm?.run(normalized,extraKey,lemma,'lemma-db')
          }
        }
        if (++processed % 5_000 === 0) { base.exec('COMMIT; BEGIN'); progress('indexing-forms', entryCount) }
      }
      base.exec('COMMIT')
    }
    progress('finalizing', entryCount)
    finalizeBase(base)
    const actualForms = Number((base.prepare('SELECT COUNT(*) count FROM forms').get() as { count: number }).count)
    const mapHash = lexemeMapHash(base)
    writeMetadata(base, {
      provider: 'ecdict', schemaVersion: '4', indexProfile: 'standard-v1', datasetRevision: ECDICT_COMMIT,
      lexemeMapHash: mapHash, version: ECDICT_COMMIT.slice(0, 12), commit: ECDICT_COMMIT,
      entryCount: String(entryCount), formCount: String(actualForms), installedAt: new Date().toISOString(),
      source: 'https://github.com/skywind3000/ECDICT', license: 'MIT',
    })
    if (full) {
      full.exec('CREATE INDEX idx_full_entries_lexeme ON full_entries(lexeme_key); CREATE INDEX idx_extra_entries_lexeme ON extra_entries(lexeme_key); CREATE INDEX idx_extra_forms_form ON extra_forms(form); ANALYZE;')
      const fullForms=actualForms+Number((full.prepare('SELECT COUNT(*) count FROM extra_forms').get() as {count:number}).count)
      writeMetadata(full, {
        provider: 'ecdict', schemaVersion: '1', indexProfile: 'full-extension-v1', datasetRevision: ECDICT_COMMIT,
        lexemeMapHash: mapHash, version: ECDICT_COMMIT.slice(0, 12), commit: ECDICT_COMMIT,
        entryCount: String(totalEntryCount), formCount: String(fullForms), installedAt: new Date().toISOString(),
      })
      full.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    base.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    base.close(); full?.close(); closed = true
    parentPort?.postMessage({ type: 'done', basePath, fullPath: full ? fullPath : null, entryCount, totalEntryCount, formCount: actualForms, lexemeMapHash: mapHash })
  } finally {
    if (!closed) { try { base.close() } catch {}; try { full?.close() } catch {} }
  }
}

function createBaseSchema(db: DatabaseSync): void { db.exec(`
  PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
  CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE lexemes(lexeme_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL UNIQUE,language TEXT NOT NULL,
    lemma TEXT NOT NULL COLLATE NOCASE,normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,phonetic TEXT,collins INTEGER,
    oxford INTEGER NOT NULL DEFAULT 0,bnc INTEGER,frq INTEGER);
  CREATE TABLE entries(entry_id INTEGER PRIMARY KEY,lexeme_id INTEGER NOT NULL,word TEXT NOT NULL COLLATE NOCASE,
    phonetic TEXT,translation TEXT,pos TEXT,tag TEXT,bnc INTEGER,frq INTEGER);
  CREATE TABLE forms(form TEXT NOT NULL COLLATE NOCASE,lexeme_id INTEGER NOT NULL,lemma TEXT NOT NULL COLLATE NOCASE,
    relation TEXT NOT NULL,PRIMARY KEY(form,lexeme_id)) WITHOUT ROWID;
  CREATE TABLE tags(lexeme_id INTEGER NOT NULL,tag TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(lexeme_id,tag)) WITHOUT ROWID;
  CREATE TABLE collections(id TEXT PRIMARY KEY,tag TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL);
  CREATE TABLE collection_items(collection_id TEXT NOT NULL,lexeme_id INTEGER NOT NULL,PRIMARY KEY(collection_id,lexeme_id)) WITHOUT ROWID;
  CREATE VIRTUAL TABLE entries_fts USING fts5(cjk_tokens,content='',columnsize=0,tokenize='unicode61 remove_diacritics 2');
`) }
function createFullSchema(db: DatabaseSync): void { db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
  CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE full_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL,definition TEXT,detail TEXT);
  CREATE TABLE extra_lexemes(lexeme_key TEXT PRIMARY KEY,lemma TEXT NOT NULL COLLATE NOCASE,normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,phonetic TEXT,collins INTEGER,oxford INTEGER,bnc INTEGER,frq INTEGER);
  CREATE TABLE extra_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL,word TEXT NOT NULL,phonetic TEXT,translation TEXT,pos TEXT,tag TEXT,bnc INTEGER,frq INTEGER,definition TEXT,detail TEXT);
  CREATE TABLE extra_forms(form TEXT NOT NULL COLLATE NOCASE,lexeme_key TEXT NOT NULL,lemma TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(form,lexeme_key)) WITHOUT ROWID;`) }
function finalizeBase(db: DatabaseSync): void { db.exec(`CREATE INDEX idx_entries_lexeme ON entries(lexeme_id);
  CREATE INDEX idx_lexemes_frequency ON lexemes(frq,bnc,lemma); CREATE INDEX idx_tags_tag ON tags(tag,lexeme_id);
  CREATE INDEX idx_collection_items_lexeme ON collection_items(lexeme_id); ANALYZE;`) }
function lexemeMapHash(db: DatabaseSync): string { const hash = crypto.createHash('sha256')
  for (const row of db.prepare('SELECT lexeme_id,normalized FROM lexemes ORDER BY lexeme_id').iterate() as Iterable<{lexeme_id:number;normalized:string}>) hash.update(`${row.lexeme_id}\u001f${row.normalized}\n`)
  return hash.digest('hex') }
function writeMetadata(db: DatabaseSync, values: Record<string,string>): void { const statement = db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)'); for (const item of Object.entries(values)) statement.run(...item) }
function progress(stage: 'indexing-entries'|'indexing-forms'|'finalizing', indexedEntries: number): void { parentPort?.postMessage({ type:'progress',stage,downloadedBytes:0,totalBytes:0,indexedEntries }) }
function nullIfEmpty(value: unknown): string | null { const text=String(value??'').trim(); return text||null }
function integerOrNull(value: unknown): number | null { const n=Number(value); return Number.isFinite(n)&&String(value??'').trim()!==''?Math.trunc(n):null }
function exchangeForms(value: unknown): string[] { return String(value??'').split('/').flatMap(part=>{const i=part.indexOf(':');return i>=0?part.slice(i+1).split(','):[]}).map(v=>v.trim()).filter(Boolean) }
function isStandardEntry(row:Record<string,string>,collins:number|null,oxford:number|null,bnc:number|null,frq:number|null):boolean{
  return Boolean(String(row.tag??'').trim())||Boolean(oxford)||Boolean(collins)||(bnc!=null&&bnc>0&&bnc<=100_000)||(frq!=null&&frq>0&&frq<=100_000)
}
