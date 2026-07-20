import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { DictionaryService, groupSenses } from '../src/main/dictionary-service'
import { DictionaryQueryClient } from '../src/main/dictionary-query-client'
import { VocabularyService } from '../src/main/vocabulary-service'
import { SqliteVocabularyRepository } from '../src/main/vocabulary-repository'
import { vocabularySourceIdentity } from '../src/main/migrations'
import type { ParsedPublication } from '../src/shared/types'

const nodeRequire = createRequire(import.meta.url)
const noNetwork = {
  fetch: async (): Promise<Response> => { throw new Error('unexpected network request') },
}

const roots: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('dictionary feature', () => {
  it('normalizes ECDICT part-of-speech aliases and domain translations', () => {
    const federal = groupSenses(
      'a. 联邦的, 联合的, 同盟的\n[法] 联邦的, 联邦制的, 联盟的',
      'n. a member of the Union Army\nn. any federal law-enforcement officer\ns. national government\na. central government',
    )
    expect(federal.map((sense) => sense.partOfSpeech)).toEqual(['形容词 · adj.', '名词 · n.'])
    expect(federal[0].translations).toContain('[法] 联邦的, 联邦制的, 联盟的')
    expect(federal[0].definitions).toEqual(['national government', 'central government'])
    expect(federal[1].definitions).toHaveLength(2)

    const earthquake = groupSenses('n. 地震', 'n shaking and vibration\nn a disruptive disturbance')
    expect(earthquake).toEqual([{
      partOfSpeech: '名词 · n.',
      translations: ['地震'],
      definitions: ['shaking and vibration', 'a disruptive disturbance'],
    }])
  })
  it('rejects an unrecognized pre-formal database generation', async () => {
    const root = temporaryRoot()
    const file = path.join(root, 'reader.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE publications (id TEXT PRIMARY KEY, hash TEXT UNIQUE, title TEXT, creator TEXT, language TEXT, cover_path TEXT, source_path TEXT, imported_at TEXT, article_count INTEGER, section_count INTEGER);
      CREATE TABLE sections (id TEXT PRIMARY KEY, publication_id TEXT REFERENCES publications(id), title TEXT, position INTEGER);
      CREATE TABLE articles (id TEXT PRIMARY KEY, publication_id TEXT REFERENCES publications(id), section_id TEXT, title TEXT, rubric TEXT, published_at TEXT, position INTEGER, source_href TEXT);
      CREATE TABLE blocks (id TEXT PRIMARY KEY, article_id TEXT REFERENCES articles(id), type TEXT, position INTEGER, text TEXT, html TEXT, asset_path TEXT, alt TEXT);
      CREATE TABLE translations (block_id TEXT, source_hash TEXT, target_language TEXT, model TEXT, prompt_version TEXT, text TEXT, created_at TEXT, PRIMARY KEY(block_id, source_hash, target_language, model, prompt_version));
      CREATE TABLE reading_positions (publication_id TEXT PRIMARY KEY, article_id TEXT, scroll_top REAL, updated_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO publications VALUES ('pub_legacy01','hash','Legacy',NULL,'en',NULL,'source.epub','2026-01-01',1,0);
      INSERT INTO articles VALUES ('article_legacy01','pub_legacy01',NULL,'Legacy article',NULL,NULL,0,'article.html');
      INSERT INTO blocks VALUES ('block_legacy01','article_legacy01','paragraph',0,'A legacy paragraph.','A legacy paragraph.',NULL,NULL);
      PRAGMA user_version = 1;
    `)
    legacy.close()
    await expect(SqliteApplicationRepository.open(root, 'test')).rejects.toThrow('不兼容')
  })

  it('creates the formal schema v1 dictionary and study baseline', async () => {
    const root = temporaryRoot()
    const file = path.join(root, 'reader.sqlite')
    const database = await SqliteApplicationRepository.open(root, 'test')
    expect(database.getSchemaStatus().schemaVersion).toBe(2)
    database.close()
    const fresh = new DatabaseSync(file, { readOnly: true })
    expect(fresh.prepare("SELECT value FROM app_metadata WHERE key='schema_generation'").get()).toEqual({ value: 'formal-v1' })
    expect(fresh.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('study_plans','review_cards','review_events','study_sessions','lexeme_examples')").get()).toEqual({ count: 5 })
    fresh.close()
  })

  it('builds layered dictionary schema v4 without duplicated FTS content tables', async () => {
    const fixture = await dictionaryFixture()
    const dictionaryPath = path.join(fixture.root, 'dictionaries', 'ecdict-base.sqlite')
    const db = new DatabaseSync(dictionaryPath, { readOnly: true })
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()).toEqual({ value: '4' })
      expect(db.prepare("SELECT value FROM metadata WHERE key='indexProfile'").get()).toEqual({ value: 'standard-v1' })
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('entries_fts_content','entries_fts_docsize')").get()).toEqual({ count: 0 })
      expect((db.prepare('PRAGMA table_info(lexemes)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['lexeme_id', 'lexeme_key', 'normalized']))
      expect((db.prepare('PRAGMA table_info(forms)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['form', 'lexeme_id', 'lemma', 'relation']))
      expect((db.prepare('PRAGMA table_info(forms)').all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('lexeme_key')
    } finally {
      db.close()
    }
  })

  it('reclaims an idle query worker and restarts it transparently', async () => {
    const fixture = await dictionaryFixture()
    const client = new DictionaryQueryClient(path.join(fixture.root, 'dictionaries', 'ecdict-base.sqlite'), 25)
    expect(client.isRunningForDiagnostics()).toBe(false)
    expect(await client.version()).toBeTruthy()
    expect(client.isRunningForDiagnostics()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.isRunningForDiagnostics()).toBe(false)
    expect(await client.version()).toBeTruthy()
    expect(client.isRunningForDiagnostics()).toBe(true)
    await client.close()
    expect(client.isRunningForDiagnostics()).toBe(false)
  })

  it('layers the full definition extension over the standard base without changing identity',async()=>{
    const fixture=await dictionaryFixture('full')
    const base=path.join(fixture.root,'dictionaries','ecdict-base.sqlite'),full=path.join(fixture.root,'dictionaries','ecdict-full.sqlite')
    const client=new DictionaryQueryClient(base,60_000,full)
    const detail=await client.getLexeme((await client.resolve('gave'))[0].lexemeKey)
    expect(await client.profile()).toBe('full')
    expect(detail.lemma).toBe('give')
    expect(detail.entries.flatMap(entry=>entry.senses).flatMap(sense=>sense.definitions)).toContain('transfer possession')
    const rare=await client.resolve('longtailrare')
    expect(rare).toHaveLength(1)
    expect((await client.getLexeme(rare[0].lexemeKey)).entries.flatMap(entry=>entry.senses).flatMap(sense=>sense.definitions)).toContain('deliberately rare fixture')
    await client.close()
    fs.rmSync(full,{force:true})
    const standard=new DictionaryQueryClient(base)
    expect(await standard.profile()).toBe('standard')
    expect((await standard.getLexeme(detail.lexemeKey)).entries.flatMap(entry=>entry.senses).flatMap(sense=>sense.definitions)).toEqual([])
    await standard.close()
  })

  it('rejects legacy dictionary schema v2 and asks for a compact reinstall', async () => {
    const root = temporaryRoot()
    fs.mkdirSync(path.join(root, 'dictionaries'), { recursive: true })
    const legacy = new DatabaseSync(path.join(root, 'dictionaries', 'ecdict.sqlite'))
    legacy.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schemaVersion','2'),('version','legacy'),('entryCount','1'),('formCount','0');")
    legacy.close()
    const database = await SqliteApplicationRepository.open(root, 'test')
    const service = new DictionaryService(database, {} as never, root, () => undefined, noNetwork)
    try {
      expect(service.getStatus()).toMatchObject({ installed: false, version: null, entryCount: 0 })
      expect(() => service.search({
        text: 'give', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
        bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 0, limit: 10,
      })).toThrow('标准学习包')
    } finally {
      await service.close()
      database.close()
    }
  })

  it('builds a local dictionary, resolves inflections and keeps ordinary lookups pure', async () => {
    const fixture = await dictionaryFixture()
    const database = await SqliteApplicationRepository.open(fixture.root, 'test')
    database.savePublication(parsedPublication())
    const service = new DictionaryService(database, {} as never, fixture.root, () => undefined, noNetwork)
    try {
      const before = database.exportPortableUserData()
      const gave = await service.lookup(request('gave', 1))
      const teeth = await service.lookup(request('teeth', 5))
      const ambiguous = await service.lookup(request('saw', 13))
      expect(gave.lemma).toBe('give')
      expect(gave.entries[0].senses[0].translations).toContain('给；给予')
      expect(teeth.lemma).toBe('tooth')
      expect(ambiguous.requiresSelection).toBe(true)
      expect(ambiguous.candidates.map((candidate) => candidate.lemma)).toEqual(expect.arrayContaining(['saw', 'see']))
      expect(database.exportPortableUserData()).toEqual(before)
    } finally {
      await service.close()
      database.close()
    }
  })

  it('keeps favorite and context state independent, idempotent and global across forms', async () => {
    const fixture = await dictionaryFixture()
    const database = await SqliteApplicationRepository.open(fixture.root, 'test')
    database.savePublication(parsedPublication())
    const dictionary = new DictionaryService(database, {} as never, fixture.root, () => undefined, noNetwork)
    const vocabulary = new VocabularyService(new SqliteVocabularyRepository(database), dictionary)
    try {
      const gaveRequest = request('gave', 1)
      const giveRequest = request('give', 10)
      const gave = await dictionary.lookup(gaveRequest)
      const give = await dictionary.lookup(giveRequest)
      expect(gave.lexemeKey).toBe(give.lexemeKey)
      const key = gave.lexemeKey!

      const favorite = await vocabulary.setFavorite(gaveRequest, key, true)
      expect(favorite).toMatchObject({ favorite: true, contextSaved: true, manualState: 'unrated' })
      await vocabulary.setFavorite(gaveRequest, key, true)
      expect(vocabulary.listFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(1)
      expect(vocabulary.listContexts(key).total).toBe(1)
      expect((await vocabulary.getReaderState(giveRequest, key)).favorite).toBe(true)

      const unfavorited = await vocabulary.setFavorite(gaveRequest, key, false)
      expect(unfavorited).toMatchObject({ favorite: false, contextSaved: true })
      expect(vocabulary.listFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(0)
      expect(vocabulary.listContexts(key).total).toBe(1)

      await vocabulary.setFavorite(gaveRequest, key, true)
      const contextRemoved = await vocabulary.setContextSaved(gaveRequest, key, false)
      expect(contextRemoved).toMatchObject({ favorite: true, contextSaved: false })
      expect(vocabulary.listContexts(key).total).toBe(0)

      await vocabulary.setFavorite(gaveRequest, key, false)
      const contextOnly = await vocabulary.setContextSaved(gaveRequest, key, true)
      expect(contextOnly).toMatchObject({ favorite: false, contextSaved: true })
      expect(vocabulary.listFavorites({ text: '', offset: 0, limit: 30 }).total).toBe(0)

      const sourceId = vocabularySourceIdentity(key, 'exam_collection', 'cet4')
      database.mergePortableUserData({
        settings: [], readingPositions: [], userLexemes: [], savedContexts: [],
        vocabularySources: [{
          sourceId, lexemeKey: key, sourceType: 'exam_collection', sourceRef: 'cet4', active: true,
          addedAt: '2026-07-07T00:00:00.000Z', removedAt: null,
          updatedAt: '2026-07-07T00:00:00.000Z', deviceId: 'test-device',
        }],
      })
      const portable = database.exportPortableUserData()
      expect(portable.userLexemes).toHaveLength(1)
      expect(portable.vocabularySources).toHaveLength(2)

      await expect(vocabulary.setFavorite({ ...gaveRequest, tokenIndex: 2 }, key, true)).rejects.toThrow()
      await expect(vocabulary.setFavorite(gaveRequest, 'lex_en_000000000000000000000000', true)).rejects.toThrow()

      await vocabulary.setFavorite(gaveRequest, key, true)
      await dictionary.remove()
      expect(vocabulary.listFavorites({ text: '', offset: 0, limit: 30 }).items[0])
        .toMatchObject({ lexemeKey: key, lemma: 'give' })

      database.deletePublication('pub_dictionary01')
      const retained = vocabulary.listContexts(key)
      expect(retained.items[0]).toMatchObject({ articleId: null, publicationId: null })
      expect(retained.items[0].sentence).toContain('gave')
    } finally {
      await dictionary.close()
      database.close()
    }
  })

  it('manually explains context and reuses the cached result', async () => {
    const fixture = await dictionaryFixture()
    const database = await SqliteApplicationRepository.open(fixture.root, 'test')
    database.savePublication(parsedPublication())
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        meaningZh: '给；递交',
        partOfSpeech: '动词',
        explanationZh: '此处表示把数据提供给读者。',
        phrase: null,
        confidence: 'high',
      }) } }] }), { status: 200 }))
    const service = new DictionaryService(
      database,
      { getApiKey: async () => 'test-key-context-not-real' } as never,
      fixture.root,
      () => undefined,
      { fetch: fetchMock },
    )

    const first = await service.explainContext(request('gave', 1))
    const second = await service.explainContext(request('gave', 1))
    expect(first.meaningZh).toBe('给；递交')
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await service.close()
    database.close()
  })

  it('searches by inflection, Chinese meaning and collection filters', async () => {
    const fixture = await dictionaryFixture()
    const database = await SqliteApplicationRepository.open(fixture.root, 'test')
    const service = new DictionaryService(database, {} as never, fixture.root, () => undefined, noNetwork)
    const base = {
      tags: [], tagMatch: 'any' as const, oxfordOnly: false, collinsMin: null,
      bncMax: null, contemporaryMax: null, sort: 'relevance' as const, offset: 0, limit: 30,
    }
    const form = await service.search({ ...base, text: 'gave' })
    expect(form.items[0].lemma).toBe('give')
    expect(form.items[0].matchedBy).toBe('form')
    const chinese = await service.search({ ...base, text: '焦虑' })
    expect(chinese.items.some((item) => item.lemma === 'anxious')).toBe(true)
    const collections = await service.listCollections()
    expect(collections.find((item) => item.tag === 'cet4')?.count).toBe(5)
    const members = await service.listCollectionMembers('cet4', 0, 2)
    expect(members).toMatchObject({ total: 5, offset: 0, limit: 2 })
    expect(members.items).toHaveLength(2)
    expect(members.items[0].briefMeanings.length).toBeGreaterThan(0)
    expect(members.items[0].senses.length).toBeGreaterThan(0)
    const filtered = await service.search({ ...base, text: '', tags: ['cet4'], collinsMin: 5 })
    expect(filtered.items.map((item) => item.lemma)).toEqual(expect.arrayContaining(['give', 'take']))
    await service.close()
    database.close()
  })

  it('merges Baidu meanings with local collections and frequency metadata', async () => {
    const fixture = await dictionaryFixture()
    const database = await SqliteApplicationRepository.open(fixture.root, 'test')
    database.saveDictionaryPreferences({
      ...database.getDictionaryPreferences(), lookupProviderId: 'baidu', translateExamples: false,
    })
    const dictionary = { word_result: { simple_means: {
      word_name: 'take', word_means: ['拿；取得'], exchange: { word_past: ['took'] }, tags: { core: ['百度考试标签'] },
      symbols: [{ ph_en: 'teɪk', parts: [{ part: 'v.', means: ['拿；取得'] }] }],
    }, edict: { item: [{ pos: 'verb', tr_group: [{ tr: ['get into one’s hands'], example: ['Can you take this bag from the table, please?'] }] }] } } }
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 2592000 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { trans_result: [{ src: 'take', dict: JSON.stringify(dictionary) }] } }), { status: 200 }))
    const service = new DictionaryService(database, {
      getApiKey: async () => 'test-baidu-key-not-real',
      status: async (id: string) => ({ configured: true, masked: id.endsWith('api-key') ? 'api-••••last' : 'secr••••last' }),
    } as never, fixture.root, () => undefined, { fetch })
    expect(await service.getCredentialStatus()).toEqual({
      configured: true,
      apiKey: { configured: true, masked: 'api-••••last' },
      secretKey: { configured: true, masked: 'secr••••last' },
    })
    const item = (await service.search({
      text: 'take', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
      bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 0, limit: 30,
    })).items[0]
    const detail = await service.getLexeme(item.lexemeKey)
    expect(detail.providerId).toBe('baidu')
    expect(detail.entries).toHaveLength(1)
    expect(detail.entries[0].senses[0].definitions).toEqual([])
    expect(detail.collections.map(collection => collection.tag)).toContain('cet4')
    expect(detail.tags).not.toContain('百度考试标签')
    expect(detail.collins).toBe(5)
    expect(detail.frequency.contemporary).not.toBeNull()
    expect(detail.forms).toEqual(expect.arrayContaining(['took']))
    await service.close()
    database.close()
  })

  it('cancels an active dictionary installation and settles its promise', async () => {
    const root = temporaryRoot()
    const csvPath = path.join(root, 'ecdict.csv')
    fs.writeFileSync(csvPath, 'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail\nword,,definition,释义,,,,,,,,\n', 'utf8')
    const { DictionaryInstaller } = nodeRequire(path.join(process.cwd(), 'dist-electron', 'main', 'dictionary-installer.js')) as typeof import('../src/main/dictionary-installer')
    const events: string[] = []
    const installer = new DictionaryInstaller(
      path.join(root, 'dictionaries'),
      (progress) => events.push(progress.stage),
      () => undefined,
      noNetwork,
    )
    const installing = installer.installFromLocal(csvPath)
    await installer.cancel()
    await expect(installing).rejects.toThrow('词典安装已取消')
    expect(events).toContain('cancelled')
    expect(installer.installing).toBe(false)
  })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-dictionary-'))
  roots.push(root)
  return root
}

async function dictionaryFixture(profile:'standard'|'full'='standard'): Promise<{ root: string }> {
  const root = temporaryRoot()
  const source = path.join(root, 'source-data')
  const staging = path.join(root, 'staging')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(path.join(root, 'dictionaries'), { recursive: true })
  const csv = [
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail',
    'give,gɪv,to transfer possession,v. 给；给予,v:100,5,1,cet4,100,80,p:gave/d:given/i:giving/3:gives,',
    'take,teɪk,to move something,v. 拿；取得,v:100,5,1,cet4,90,70,p:took/d:taken/i:taking/3:takes,',
    'tooth,tuːθ,a hard structure,n. 牙齿,n:100,3,1,cet4,1000,900,s:teeth,',
    'anxious,æŋkʃəs,worried or uneasy,adj. 焦虑的；渴望的,adj:100,4,1,cet4,1200,1100,,',
    'see,siː,to perceive,v. 看见,v:100,5,1,cet4,50,40,p:saw,',
    'saw,sɔː,a cutting tool,n. 锯,n:100,2,0,,3000,2800,,',
    'longtailrare,,a deliberately rare fixture,n. 稀有测试词,,,,,,,',
  ].join('\n')
  fs.writeFileSync(path.join(source, 'ecdict.csv'), csv, 'utf8')
  fs.writeFileSync(path.join(source, 'lemma.en.txt'), 'give/100 -> gave,given,giving,gives\ntake/100 -> took,taken,taking,takes\ntooth/100 -> teeth\nsee/100 -> saw,seen,seeing,sees\n', 'utf8')
  await runWorker({
    mode: 'local',
    profile,
    stagingRoot: staging,
    csvPath: path.join(source, 'ecdict.csv'),
    lemmaPath: path.join(source, 'lemma.en.txt'),
  })
  fs.renameSync(path.join(staging, 'ecdict-base.sqlite'), path.join(root, 'dictionaries', 'ecdict-base.sqlite'))
  if(profile==='full')fs.renameSync(path.join(staging,'ecdict-full.sqlite'),path.join(root,'dictionaries','ecdict-full.sqlite'))
  return { root }
}

function runWorker(workerData: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(process.cwd(), 'dist-electron', 'main', 'dictionary-worker.js'), { workerData })
    worker.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'done') resolve()
      if (message.type === 'error') reject(new Error(String(message.message)))
    })
    worker.on('error', reject)
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)) })
  })
}

function parsedPublication(): ParsedPublication {
  const text = 'He gave the readers better teeth and anxious figures. They give examples. They saw timber.'
  return {
    id: 'pub_dictionary01',
    hash: 'dictionary-fixture-hash',
    sourceKey: 'generic-epub:dictionary-fixture',
    profileId: 'generic-epub',
    title: 'Dictionary Fixture',
    creator: null,
    language: 'en',
    coverPath: null,
    sections: [],
    unsectionedArticles: [{
      id: 'article_dictionary01',
      sourceKey: 'article.html',
      title: 'Dictionary article',
      rubric: null,
      publishedAt: null,
      position: 0,
      sourceHref: 'article.html',
      blocks: [{
        id: 'block_dictionary01',
        sourceKey: 'paragraph:fixture:0',
        type: 'paragraph',
        position: 0,
        text,
        html: text,
        assetPath: null,
        alt: null,
      }],
    }],
    assets: new Map(),
  }
}

function request(surface: string, tokenIndex: number) {
  return { articleId: 'article_dictionary01', blockId: 'block_dictionary01', surface, tokenIndex }
}
