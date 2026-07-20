import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DictionaryEntryResult, DictionaryExample, LexemeDetail, LexemeKey } from '../shared/types'
import type { NetworkClient } from '../core/network-client'
import type { SecretStore } from './secret-store'

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'
const LOOKUP_URL = 'https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1'
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000
const NEGATIVE_TTL = 24 * 60 * 60 * 1000
const CACHE_LIMIT = 64 * 1024 * 1024
type Json = Record<string, any>

export class BaiduDictionaryProvider {
  private token: { value: string; expiresAt: number } | null = null
  private readonly cache: BaiduDictionaryCache
  private readonly pending = new Map<string, Promise<LexemeDetail | null>>()

  constructor(cacheRoot: string, private readonly secrets: SecretStore, private readonly network: NetworkClient) {
    this.cache = new BaiduDictionaryCache(path.join(cacheRoot, 'dictionary', 'baidu-v2.sqlite'))
  }

  async configured(): Promise<boolean> {
    return Boolean(await this.secrets.getApiKey('baidu-dictionary-api-key')
      && await this.secrets.getApiKey('baidu-dictionary-secret-key'))
  }

  async testConnection(): Promise<void> {
    if (!(await this.configured())) throw new Error('请先保存百度 API Key 和 Secret Key')
    const result = await this.request('dictionary', 'lex_en_connection_test')
    if (!result) throw new Error('连接成功，但测试词未返回词典数据')
  }

  lookup(lemma: string, lexemeKey: LexemeKey): Promise<LexemeDetail | null> {
    const query = lemma.normalize('NFKC').trim().toLowerCase()
    const key = hash(`en\u001fzh\u001f${query}\u001fparser-v1`)
    const cached = this.cache.get(key)
    if (cached.hit) return Promise.resolve(cached.value)
    const active = this.pending.get(key)
    if (active) return active
    const request = this.request(query, lexemeKey).then((value) => {
      this.cache.put(key, query, value, value ? CACHE_TTL : NEGATIVE_TTL)
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }

  close(): void { this.cache.close() }
  credentialsChanged():void{this.token=null}

  private async request(query: string, lexemeKey: LexemeKey): Promise<LexemeDetail | null> {
    let last: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let token = await this.accessToken(false)
        let response = await this.fetchLookup(query, token)
        if (response.error_code === 110 || response.error_code === 111) {
          token = await this.accessToken(true)
          response = await this.fetchLookup(query, token)
        }
        if (response.error_code) {
          const code = Number(response.error_code)
          if ([2, 4, 18, 31101, 31102, 31104, 282000].includes(code)) throw new RetryableBaiduError(`百度词典暂时不可用（${code}）`)
          throw new Error(baiduError(code))
        }
        return parseBaiduResult(response, lexemeKey)
      } catch (error) {
        last = error instanceof Error ? error : new Error('百度词典请求失败')
        if (!(last instanceof RetryableBaiduError) || attempt === 2) break
        await delay(attempt === 0 ? 500 : 1500)
      }
    }
    throw last ?? new Error('百度词典请求失败')
  }

  private async fetchLookup(query: string, token: string): Promise<Json> {
    const response = await this.network.fetch(`${LOOKUP_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ q: query, from: 'en', to: 'zh' }), signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 429 || response.status >= 500) throw new RetryableBaiduError(`百度词典暂时不可用（HTTP ${response.status}）`)
    if (!response.ok) throw new Error(`百度词典请求失败（HTTP ${response.status}）`)
    return await response.json() as Json
  }

  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 5 * 60_000) return this.token.value
    const apiKey = await this.secrets.getApiKey('baidu-dictionary-api-key')
    const secretKey = await this.secrets.getApiKey('baidu-dictionary-secret-key')
    if (!apiKey || !secretKey) throw new Error('请先在词典服务中配置百度 API Key 和 Secret Key')
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey })
    const response = await this.network.fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('百度词典鉴权失败')
    const json = await response.json() as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('百度词典鉴权未返回 Access Token')
    this.token = { value: json.access_token, expiresAt: Date.now() + Math.max(600, Number(json.expires_in ?? 2_592_000)) * 1000 }
    return this.token.value
  }
}

function parseBaiduResult(outer: Json, lexemeKey: LexemeKey): LexemeDetail | null {
  const item = outer?.result?.trans_result?.[0]
  if (!item?.dict || typeof item.dict !== 'string') return null
  let dictionary: Json
  try { dictionary = JSON.parse(item.dict) as Json } catch { throw new Error('百度词典返回格式不正确') }
  const word = dictionary?.word_result
  const simple = word?.simple_means
  if (!simple || typeof simple !== 'object') return null
  const symbol = Array.isArray(simple.symbols) ? simple.symbols[0] ?? {} : {}
  const senseMap = new Map<string, string[]>()
  for (const part of Array.isArray(symbol.parts) ? symbol.parts : []) {
    const pos = normalizePartOfSpeech(String(part.part || '其他'))
    const meanings = chineseMeanings(part.means)
    if (!meanings.length) continue
    const values = senseMap.get(pos) ?? []
    for (const meaning of meanings) if (!values.includes(meaning)) values.push(meaning)
    senseMap.set(pos, values)
  }
  const fallbackMeanings = chineseMeanings(simple.word_means)
  if (!senseMap.size && fallbackMeanings.length) senseMap.set('其他', fallbackMeanings)
  const simpleSenses = [...senseMap].map(([partOfSpeech, translations]) => ({
    partOfSpeech, translations, definitions: [],
  }))
  const entries: DictionaryEntryResult[] = simpleSenses.length ? [{
    word: String(simple.word_name || item.src || ''), phonetic: textOrNull(symbol.ph_en || symbol.ph_am), senses: simpleSenses,
    positionWeights: null, tags: [], frequency: { bnc: null, contemporary: null }, exchanges: exchangeValues(simple.exchange),
  }] : []
  const examples: DictionaryExample[] = []
  const similar = new Set<string>()
  for (const edictItem of Array.isArray(word.edict?.item) ? word.edict.item : []) {
    const pos = normalizePartOfSpeech(String(edictItem.pos || '其他'))
    for (const group of Array.isArray(edictItem.tr_group) ? edictItem.tr_group : []) {
      for (const value of strings(group.similar_word)) similar.add(value)
      for (const value of strings(group.example)) examples.push({
        exampleId: hash(`${lexemeKey}\u001f${normalizeExample(value)}`), text: value, translationZh: null,
        partOfSpeech: pos, definition: null, providerId: 'baidu',
      })
    }
  }
  const lemma = String(simple.word_name || item.src || '').normalize('NFKC').trim().toLowerCase()
  const brief = [...new Set(simpleSenses.flatMap(sense => sense.translations))].slice(0, 3)
  return {
    lexemeKey, lemma, phonetic: textOrNull(symbol.ph_en || symbol.ph_am), briefMeanings: brief,
    tags: [], collins: null, oxford: false, frequency: { bnc: null, contemporary: null }, matchedBy: 'lemma',
    entries, forms: exchangeValues(simple.exchange), collections: [], providerId: 'baidu',
    examples: selectExamples(examples, lemma), similarWords: [...similar],
  }
}

function normalizePartOfSpeech(value: string): string {
  const key = value.trim().toLowerCase().replace(/\.$/, '')
  const labels: Record<string, string> = {
    n: '名词 · n.', noun: '名词 · n.', v: '动词 · v.', verb: '动词 · v.',
    vt: '及物动词 · vt.', vi: '不及物动词 · vi.', adj: '形容词 · adj.', adjective: '形容词 · adj.',
    adv: '副词 · adv.', adverb: '副词 · adv.', prep: '介词 · prep.', preposition: '介词 · prep.',
    conj: '连词 · conj.', conjunction: '连词 · conj.', pron: '代词 · pron.', pronoun: '代词 · pron.',
  }
  return labels[key] ?? (value.trim() || '其他')
}

function hasChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value)
}

function chineseMeanings(value: unknown): string[] {
  return [...new Set(strings(value)
    .flatMap(item => item.split(/[\n；;]+/u))
    .map(item => item.trim())
    .filter(item => item.length > 0 && hasChinese(item)))]
}

function selectExamples(values: DictionaryExample[], lemma: string): DictionaryExample[] {
  const seen = new Set<string>(), selected: DictionaryExample[] = []
  const ranked = values.filter(v => v.text.length >= 20 && v.text.length <= 160)
    .sort((a,b) => Number(!new RegExp(`\\b${escapeRegex(lemma)}\\b`, 'i').test(a.text)) - Number(!new RegExp(`\\b${escapeRegex(lemma)}\\b`, 'i').test(b.text)))
  for (const value of ranked) { const normalized=normalizeExample(value.text); if (seen.has(normalized)) continue; seen.add(normalized); selected.push(value); if (selected.length===2) break }
  return selected
}

class BaiduDictionaryCache {
  constructor(private readonly file: string) { const db=this.open();db.close() }
  get(key:string):{hit:boolean;value:LexemeDetail|null}{ const db=this.open();try{const now=Date.now(); const row=db.prepare('SELECT value_json,expires_at FROM lookups WHERE cache_key=?').get(key) as {value_json:string|null;expires_at:number}|undefined
    if(!row)return{hit:false,value:null}; if(Number(row.expires_at)<=now){db.prepare('DELETE FROM lookups WHERE cache_key=?').run(key);return{hit:false,value:null}}
    db.prepare('UPDATE lookups SET last_accessed_at=? WHERE cache_key=?').run(now,key); return{hit:true,value:row.value_json?JSON.parse(row.value_json) as LexemeDetail:null}}finally{db.close()} }
  put(key:string,query:string,value:LexemeDetail|null,ttl:number):void{const now=Date.now(),json=value?JSON.stringify(value):null,size=Buffer.byteLength(json??'')
    const db=this.open();try{db.prepare('INSERT OR REPLACE INTO lookups VALUES(?,?,?,?,?,?,?)').run(key,query,json,now,now,now+ttl,size);this.trim(db)}finally{db.close()} }
  close():void{}
  private open(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const db=new DatabaseSync(this.file);db.exec(`
    PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lookups(cache_key TEXT PRIMARY KEY,query TEXT NOT NULL,
    value_json TEXT,created_at INTEGER NOT NULL,last_accessed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,size_bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_baidu_cache_lru ON lookups(last_accessed_at);`);return db}
  private trim(db:DatabaseSync):void{let total=Number((db.prepare('SELECT COALESCE(SUM(size_bytes),0) total FROM lookups').get() as {total:number}).total);while(total>CACHE_LIMIT){const row=db.prepare('SELECT cache_key,size_bytes FROM lookups ORDER BY last_accessed_at LIMIT 1').get() as {cache_key:string;size_bytes:number}|undefined;if(!row)break;db.prepare('DELETE FROM lookups WHERE cache_key=?').run(row.cache_key);total-=Number(row.size_bytes)}}
}

class RetryableBaiduError extends Error {}
function baiduError(code:number):string { if([6,31005,19].includes(code))return '百度词典无权限或额度不足';if(code===20003)return '查询内容被百度安全策略拒绝';if([100,282003,282004,31103].includes(code))return '百度词典请求参数无效';return `百度词典请求失败（${code}）` }
function exchangeValues(value:unknown):string[]{if(!value||typeof value!=='object')return[];return Object.values(value as Json).flatMap(strings).map(v=>v.trim()).filter(Boolean)}
function strings(value:unknown):string[]{return Array.isArray(value)?value.map(v=>String(v).trim()).filter(Boolean):[]}
function textOrNull(value:unknown):string|null{const text=String(value??'').trim();return text||null}
function normalizeExample(value:string):string{return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()}
function hash(value:string):string{return crypto.createHash('sha256').update(value).digest('hex')}
function escapeRegex(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function delay(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms))}
