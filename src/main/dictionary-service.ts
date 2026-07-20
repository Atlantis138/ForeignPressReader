import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ContextDefinition,
  DictionaryInstallProgress,
  DictionaryCredentialStatus,
  DictionaryLookupRequest,
  DictionaryLookupResult,
  DictionaryPreferences,
  DictionarySenseGroup,
  DictionaryStatus,
  DictionarySearchQuery,
  DictionarySearchPage,
  DictionaryCollection,
  DictionaryLearningPage,
  DictionaryLocalProfile,
  LexemeDetail,
  LexemeKey,
} from '../shared/types'
import { normalizeEnglishWord } from '../shared/word-utils'
import { DictionaryInstaller } from './dictionary-installer'
import { SecretStore } from './secret-store'
import { DictionaryQueryClient } from './dictionary-query-client'
import type { NetworkClient } from '../core/network-client'
import { BaiduDictionaryProvider } from './baidu-dictionary-provider'
import { createLexemeKey } from '../core/lexicon/identity'
import { appCachePath } from './app-cache'

interface DictionaryUserStore {
  getDictionaryPreferences(): DictionaryPreferences
  saveDictionaryPreferences(preferences: DictionaryPreferences): DictionaryPreferences
  getLookupContext(articleId: string, blockId: string, surface: string, tokenIndex: number): {
    publicationId: string; publicationTitle: string; articleId: string; blockId: string
    articleTitle: string; text: string; surface: string; normalized: string; sentence: string
  }
  getContextDefinition(cacheKey: string): ContextDefinition | null
  saveContextDefinition(input: {
    cacheKey: string; lexemeKey: LexemeKey; word: string; lemma: string; articleId: string
    blockId: string; sentenceHash: string; dictionaryVersion: string; model: string
    promptVersion: string; result: ContextDefinition
  }): void
}

type Row = Record<string, unknown>

const LEGACY_MODEL = 'deepseek-v4-flash'
const PROMPT_VERSION = 'dictionary-context-v2'
const SOURCE_URL = 'https://github.com/skywind3000/ECDICT'

interface ContextModelClient {
  identity(): { providerId: string; modelId: string; cacheModel: string }
  complete(systemPrompt: string, payload: unknown): Promise<Record<string, unknown>>
}

export class DictionaryService {
  private queryClient: DictionaryQueryClient | null = null
  private readonly dictionaryPath: string
  private readonly fullDictionaryPath: string
  private readonly dictionariesRoot: string
  private readonly baidu: BaiduDictionaryProvider
  private readonly recentDetails=new Map<LexemeKey,LexemeDetail>()
  readonly installer: DictionaryInstaller

  constructor(
    private readonly appDatabase: DictionaryUserStore,
    private readonly secrets: SecretStore,
    userDataPath: string,
    onProgress: (progress: DictionaryInstallProgress) => void,
    private readonly network: NetworkClient,
    private readonly translateExampleTexts?: (texts:string[])=>Promise<string[]>,
    private readonly contextModel?: ContextModelClient,
  ) {
    this.dictionariesRoot = path.join(userDataPath, 'dictionaries')
    this.dictionaryPath = path.join(this.dictionariesRoot, 'ecdict-base.sqlite')
    this.fullDictionaryPath = path.join(this.dictionariesRoot, 'ecdict-full.sqlite')
    this.baidu = new BaiduDictionaryProvider(appCachePath(userDataPath), secrets, network)
    this.installer = new DictionaryInstaller(
      this.dictionariesRoot,
      onProgress,
      () => this.closeProvider(),
      network,
    )
  }

  getStatus(): DictionaryStatus {
    const baseMeta = readMetadata(this.dictionaryPath)
    const fullMeta = readMetadata(this.fullDictionaryPath)
    const baseInstalled = baseMeta?.schemaVersion === '4'
    const extensionCompatible = Boolean(baseInstalled && fullMeta?.schemaVersion === '1'
      && fullMeta.datasetRevision === baseMeta?.datasetRevision && fullMeta.lexemeMapHash === baseMeta?.lexemeMapHash)
    const fullExtensionInstalled = extensionCompatible
    const version = baseInstalled ? baseMeta?.version ?? null : null
    const entryCount = baseInstalled ? Number((fullExtensionInstalled?fullMeta:baseMeta)?.entryCount ?? 0) : 0
    const formCount = baseInstalled ? Number((fullExtensionInstalled?fullMeta:baseMeta)?.formCount ?? 0) : 0
    const pack = (file: string, meta: Record<string,string>|null, installed: boolean) => ({
      installed, installing: this.installer.installing, version: installed ? meta?.version ?? null : null,
      entryCount: installed ? Number(meta?.entryCount ?? 0) : 0,
      formCount: installed ? Number(meta?.formCount ?? 0) : 0,
      sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    })
    return {
      providerId: 'ecdict',
      installed: baseInstalled,
      baseInstalled,
      fullExtensionInstalled,
      extensionCompatible,
      effectiveProfile: !baseInstalled ? 'none' : fullExtensionInstalled ? 'full' : 'standard',
      installing: this.installer.installing,
      base: pack(this.dictionaryPath, baseMeta, baseInstalled),
      full: pack(this.fullDictionaryPath, fullMeta, fullExtensionInstalled),
      version,
      entryCount,
      formCount,
      sizeBytes: [this.dictionaryPath,this.fullDictionaryPath].filter(fs.existsSync).reduce((n,file)=>n+fs.statSync(file).size,0),
      source: SOURCE_URL,
      license: 'MIT',
    }
  }

  getPreferences(): DictionaryPreferences {
    return this.appDatabase.getDictionaryPreferences()
  }

  savePreferences(preferences: DictionaryPreferences): DictionaryPreferences {
    return this.appDatabase.saveDictionaryPreferences(preferences)
  }

  async install(profile: Exclude<DictionaryLocalProfile,'none'> = 'standard'): Promise<void> {
    await this.installer.installFromDownload(profile)
  }

  async installFromLocal(csvPath: string, lemmaPath?: string, profile: Exclude<DictionaryLocalProfile,'none'> = 'standard'): Promise<void> {
    await this.installer.installFromLocal(csvPath, lemmaPath, profile)
  }

  async removeFullExtension(): Promise<void> {
    await this.closeProvider()
    const removing = `${this.fullDictionaryPath}.removing`
    fs.rmSync(removing, { force: true })
    if (fs.existsSync(this.fullDictionaryPath)) fs.renameSync(this.fullDictionaryPath, removing)
    fs.rmSync(removing, { force: true }); fs.rmSync(`${this.fullDictionaryPath}-wal`, { force: true }); fs.rmSync(`${this.fullDictionaryPath}-shm`, { force: true })
  }

  async remove(): Promise<void> {
    if (this.installer.installing) await this.installer.cancel()
    await this.closeProvider()
    fs.rmSync(this.dictionaryPath, { force: true })
    fs.rmSync(`${this.dictionaryPath}-wal`, { force: true })
    fs.rmSync(`${this.dictionaryPath}-shm`, { force: true })
    fs.rmSync(this.fullDictionaryPath, { force: true })
    fs.rmSync(`${this.fullDictionaryPath}-wal`, { force: true })
    fs.rmSync(`${this.fullDictionaryPath}-shm`, { force: true })
    fs.rmSync(path.join(this.dictionariesRoot, 'ecdict.sqlite'), { force: true })
  }

  lookup(request: DictionaryLookupRequest): Promise<DictionaryLookupResult> {
    return this.lookupInContext(request)
  }

  lookupInContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<DictionaryLookupResult> {
    return this.resolveLookup(request, preferredLexemeKey)
  }

  search(query: DictionarySearchQuery): Promise<DictionarySearchPage> {
    return this.getQueryClient().search(query)
  }

  async getLexeme(lexemeKey: LexemeKey): Promise<LexemeDetail> {
    let local:LexemeDetail
    try{local=await this.getQueryClient().getLexeme(lexemeKey)}catch{const recent=this.recentDetails.get(lexemeKey);if(recent)return recent;throw new Error('未找到该词条')}
    if (this.getPreferences().lookupProviderId !== 'baidu') return local
    try {
      const remote = await this.baidu.lookup(local.lemma, lexemeKey)
      return await this.withExampleTranslations(remote ? mergeLexemeDetails(local, remote) : local)
    } catch { return local }
  }

  listCollections(): Promise<DictionaryCollection[]> {
    return this.getQueryClient().listCollections()
  }

  listCollectionMembers(tag: string, offset: number, limit = 500): Promise<DictionaryLearningPage> {
    return this.getQueryClient().listCollectionMembers(tag, offset, limit)
  }

  async explainContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<ContextDefinition> {
    const preferences = this.getPreferences()
    if (!preferences.contextExplanationEnabled) throw new Error('请在设置中启用“文中义分析”')
    const result = await this.resolveLookup(request, preferredLexemeKey)
    const context = this.appDatabase.getLookupContext(
      request.articleId,
      request.blockId,
      request.surface,
      request.tokenIndex,
    )
    const modelIdentity = this.contextModel?.identity() ?? {
      providerId: 'deepseek', modelId: LEGACY_MODEL, cacheModel: LEGACY_MODEL,
    }
    const basis = preferredLexemeKey
      ? 'selected-lexeme'
      : result.candidates.length > 0 ? 'auto-candidates' : 'context-only'
    const resolvedCandidate = preferredLexemeKey
      ? result.candidates.find((candidate) => candidate.lexemeKey === preferredLexemeKey) ?? null
      : !result.requiresSelection ? result.candidates[0] ?? null : null
    const resolvedLexemeKey = resolvedCandidate?.lexemeKey ?? null
    const resolvedLemma = resolvedCandidate?.lemma ?? (basis === 'context-only' ? null : result.lemma)
    const dictionaryVersion = result.dictionaryVersion ?? 'none'
    const sentenceHash = sha256(context.sentence)
    const cacheKey = contextCacheKey({
      result,
      context,
      preferredLexemeKey,
      dictionaryVersion,
      modelIdentity,
    })
    const cached = this.appDatabase.getContextDefinition(cacheKey)
    if (cached) return cached

    let parsed: Record<string, unknown>
    const systemPrompt = [
      '你是严谨的英语词义辨析助手。结合英文语境判断所点词语在文中的含义。',
      '词典候选仅是辅助；没有候选或候选不确定时也必须根据语境作答，并相应降低 confidence。',
      '不要扩写文章，不要虚构原文信息。',
      '只返回 JSON：{"meaningZh":"文中义","partOfSpeech":"词性","explanationZh":"一句简短说明","phrase":null或固定搭配,"confidence":"high|medium|low"}。',
    ].join('\n')
    const payload = {
      word: result.surface,
      normalized: result.normalized,
      basis,
      resolvedLemma,
      articleTitle: context.articleTitle,
      sentence: context.sentence,
      paragraph: context.text,
      candidates: result.candidates,
      dictionaryEntries: result.entries,
    }
    if (this.contextModel) {
      parsed = await this.contextModel.complete(systemPrompt, payload)
    } else {
      const apiKey = await this.secrets.getApiKey()
      if (!apiKey) throw new Error('请先在设置中填写 DeepSeek API Key')
      const outer = await requestContextApi(apiKey, {
        model: LEGACY_MODEL,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }, this.network)
      const content = outer.choices?.[0]?.message?.content
      if (!content) throw new Error('DeepSeek 返回了空内容')
      try {
        parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>
      } catch {
        throw new Error('DeepSeek 返回格式不正确')
      }
    }
    const explanation: ContextDefinition = {
      meaningZh: requiredString(parsed.meaningZh, '文中义'),
      partOfSpeech: requiredString(parsed.partOfSpeech, '词性'),
      explanationZh: requiredString(parsed.explanationZh, '说明'),
      phrase: typeof parsed.phrase === 'string' && parsed.phrase.trim() ? parsed.phrase.trim() : null,
      confidence: ['high', 'medium', 'low'].includes(String(parsed.confidence))
        ? parsed.confidence as ContextDefinition['confidence']
        : 'medium',
      cached: false,
      basis,
      resolvedLexemeKey,
      resolvedLemma,
    }
    const cacheLexemeKey = resolvedLexemeKey ?? createLexemeKey({ sha256 }, 'en', result.normalized)
    this.appDatabase.saveContextDefinition({
      cacheKey,
      lexemeKey: cacheLexemeKey,
      word: result.normalized,
      lemma: resolvedLemma ?? result.normalized,
      articleId: request.articleId,
      blockId: request.blockId,
      sentenceHash,
      dictionaryVersion,
      model: modelIdentity.cacheModel,
      promptVersion: PROMPT_VERSION,
      result: explanation,
    })
    return explanation
  }

  close(): Promise<void> {
    this.baidu.close()
    return this.closeProvider()
  }

  async saveBaiduCredentials(apiKey: string, secretKey: string): Promise<void> {
    const previous = {
      'baidu-dictionary-api-key': await this.secrets.getApiKey('baidu-dictionary-api-key'),
      'baidu-dictionary-secret-key': await this.secrets.getApiKey('baidu-dictionary-secret-key'),
    }
    await this.secrets.saveApiKeys({
      'baidu-dictionary-api-key': apiKey,
      'baidu-dictionary-secret-key': secretKey,
    })
    this.baidu.credentialsChanged()
    try {
      await this.baidu.testConnection()
    } catch (error) {
      const restore = Object.fromEntries(Object.entries(previous).filter((entry): entry is [string, string] => Boolean(entry[1])))
      const remove = Object.entries(previous).filter(([, value]) => !value).map(([slot]) => slot)
      await this.secrets.replaceApiKeys(restore, remove)
      this.baidu.credentialsChanged()
      throw error
    }
  }
  async deleteBaiduCredentials(): Promise<void> {
    await this.secrets.deleteApiKeys(['baidu-dictionary-api-key', 'baidu-dictionary-secret-key'])
    this.baidu.credentialsChanged()
  }
  testBaiduConnection(): Promise<void> { return this.baidu.testConnection() }
  async getCredentialStatus(): Promise<DictionaryCredentialStatus> {
    const [apiKey, secretKey] = await Promise.all([
      this.secrets.status('baidu-dictionary-api-key'),
      this.secrets.status('baidu-dictionary-secret-key'),
    ])
    return { configured: apiKey.configured && secretKey.configured, apiKey, secretKey }
  }
  async enrichLexemeExamples(lexemeKey: LexemeKey) {
    const local=await this.getQueryClient().getLexeme(lexemeKey)
    if (this.getPreferences().lookupProviderId !== 'baidu') {
      return (await this.withExampleTranslations(local)).examples
    }
    return (await this.withExampleTranslations(await this.baidu.lookup(local.lemma,lexemeKey)??local)).examples
  }
  private async withExampleTranslations(detail:LexemeDetail):Promise<LexemeDetail>{
    if(!this.getPreferences().translateExamples||!this.translateExampleTexts||!detail.examples.some(item=>!item.translationZh))return detail
    try{const pending=detail.examples.filter(item=>!item.translationZh),translations=await this.translateExampleTexts(pending.map(item=>item.text));let index=0
      return{...detail,examples:detail.examples.map(item=>item.translationZh?item:{...item,translationZh:translations[index++]||null})}
    }catch{return detail}
  }

  private async resolveLookup(
    request: DictionaryLookupRequest,
    preferredLexemeKey?: LexemeKey,
  ): Promise<DictionaryLookupResult> {
    const preferences = this.getPreferences()
    if (!preferences.enabled) throw new Error('查词功能已在设置中关闭')
    const context = this.appDatabase.getLookupContext(
      request.articleId,
      request.blockId,
      request.surface,
      request.tokenIndex,
    )
    const normalized = normalizeEnglishWord(context.surface)
    if (!this.isInstalled()) {
      return {
        surface: context.surface,
        normalized,
        lemma: normalized,
        sentence: context.sentence,
        paragraph: context.text,
        found: false,
        entries: [],
        suggestions: [],
        contextDefinition: null,
        dictionaryVersion: null,
        lexemeKey: null,
        candidates: [],
        requiresSelection: false,
        requestedProviderId: preferences.lookupProviderId,
        resolvedProviderId: 'ecdict',
        localProfile: 'none',
        fallbackUsed: false,
        examples: [],
        metadata: emptyLookupMetadata(),
      }
    }
    const client = this.getQueryClient()
    let candidates = await client.resolve(context.surface)
    if(!candidates.length&&preferences.lookupProviderId==='baidu'&&normalized){candidates=[{lexemeKey:createLexemeKey({sha256},'en',normalized),lemma:normalized,relation:'exact',confidence:1,phonetic:null,briefMeanings:[]}]}
    const preferred = preferredLexemeKey
      ? candidates.find((candidate) => candidate.lexemeKey === preferredLexemeKey)
      : undefined
    if (preferredLexemeKey && !preferred) throw new Error('所选词条与当前词形不匹配')
    const selected = preferred ?? candidates[0]
    const requiresSelection = !preferred && candidates.length > 1
      && candidates[0].confidence - candidates[1].confidence < .25
    const localDetail = selected ? await client.getLexeme(selected.lexemeKey).catch(()=>null) : null
    let detail = localDetail
    let resolvedProviderId: 'ecdict'|'baidu' = 'ecdict'
    let fallbackUsed = false
    if (selected && preferences.lookupProviderId === 'baidu') {
      try {
        const remote=await this.baidu.lookup(localDetail?.lemma??selected.lemma, selected.lexemeKey)
        detail=remote&&localDetail?mergeLexemeDetails(localDetail,remote):remote??localDetail
        if(detail)detail=await this.withExampleTranslations(detail)
        if(detail)this.recentDetails.set(selected.lexemeKey,detail)
        resolvedProviderId = detail?.providerId??'ecdict'
        fallbackUsed = detail?.providerId !== 'baidu'
      } catch (error) {
        if (!preferences.fallbackToLocal) throw error
        detail = localDetail; fallbackUsed = true
      }
    }
    const entries = detail?.entries ?? []
    const lemma = detail?.lemma ?? normalized
    const dictionaryVersion = await client.version()
    const provisional = {
      surface: context.surface,
      normalized,
      lemma,
      entries,
      candidates,
      requiresSelection,
    } as Pick<DictionaryLookupResult, 'surface' | 'normalized' | 'lemma' | 'entries' | 'candidates' | 'requiresSelection'>
    const cacheKey = contextCacheKey({
      result: provisional,
      context,
      preferredLexemeKey,
      dictionaryVersion,
      modelIdentity: this.contextModel?.identity() ?? {
        providerId: 'deepseek', modelId: LEGACY_MODEL, cacheModel: LEGACY_MODEL,
      },
    })
    return {
      surface: context.surface,
      normalized,
      lemma,
      sentence: context.sentence,
      paragraph: context.text,
      found: entries.length > 0,
      entries,
      suggestions: [],
      contextDefinition: this.appDatabase.getContextDefinition(cacheKey),
      dictionaryVersion,
      lexemeKey: selected?.lexemeKey ?? null,
      candidates,
      requiresSelection,
      requestedProviderId: preferences.lookupProviderId,
      resolvedProviderId,
      localProfile: this.getStatus().effectiveProfile,
      fallbackUsed,
      examples: detail?.examples ?? [],
      metadata: detail ? {
        tags: detail.tags,
        collections: detail.collections,
        oxford: detail.oxford,
        collins: detail.collins,
        frequency: detail.frequency,
        forms: detail.forms,
      } : emptyLookupMetadata(),
    }
  }

  private getQueryClient(): DictionaryQueryClient {
    if (!this.isInstalled()) throw new Error('请安装 ECDICT 标准学习包')
    if (!this.queryClient) this.queryClient = new DictionaryQueryClient(this.dictionaryPath, 60_000,
      this.getStatus().fullExtensionInstalled ? this.fullDictionaryPath : null)
    return this.queryClient
  }

  private isInstalled(): boolean {
    if (!fs.existsSync(this.dictionaryPath)) return false
    try {
      const db = new DatabaseSync(this.dictionaryPath, { readOnly: true })
      try {
        const row = db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as Row | undefined
        return String(row?.value ?? '') === '4'
      } finally { db.close() }
    } catch { return false }
  }

  private async closeProvider(): Promise<void> {
    await this.queryClient?.close()
    this.queryClient = null
  }
}

function mergeLexemeDetails(local: LexemeDetail, remote: LexemeDetail): LexemeDetail {
  return {
    ...remote,
    lexemeKey: local.lexemeKey,
    lemma: local.lemma,
    phonetic: remote.phonetic ?? local.phonetic,
    briefMeanings: remote.briefMeanings.length ? remote.briefMeanings : local.briefMeanings,
    tags: local.tags,
    collins: local.collins,
    oxford: local.oxford,
    frequency: local.frequency,
    matchedBy: local.matchedBy,
    entries: remote.entries.length ? remote.entries : local.entries,
    forms: [...new Set([...local.forms, ...remote.forms])],
    collections: local.collections,
    examples: remote.examples,
    similarWords: [...new Set([...remote.similarWords, ...local.similarWords])],
    providerId: remote.entries.length || remote.examples.length ? 'baidu' : 'ecdict',
  }
}

function emptyLookupMetadata(): DictionaryLookupResult['metadata'] {
  return {
    tags: [], collections: [], oxford: false, collins: null,
    frequency: { bnc: null, contemporary: null }, forms: [],
  }
}

function readMetadata(file: string): Record<string,string> | null {
  if (!fs.existsSync(file)) return null
  try { const db=new DatabaseSync(file,{readOnly:true}); try{return Object.fromEntries((db.prepare('SELECT key,value FROM metadata').all() as Row[]).map(r=>[String(r.key),String(r.value)]))} finally{db.close()} } catch{return null}
}

export function groupSenses(translationValue: unknown, definitionValue: unknown): DictionarySenseGroup[] {
  const groups = new Map<string, DictionarySenseGroup>()
  const ensure = (pos: string) => {
    if (!groups.has(pos)) groups.set(pos, { partOfSpeech: pos, translations: [], definitions: [] })
    return groups.get(pos)!
  }
  const appendUnique = (items: string[], value: string) => {
    if (value && !items.includes(value)) items.push(value)
  }
  let previousTranslationPos: string | null = null
  for (const line of splitLines(translationValue)) {
    const parsed = parsePosLine(line)
    const pos: string = parsed.pos ?? previousTranslationPos ?? '其他'
    appendUnique(ensure(pos).translations, parsed.text)
    previousTranslationPos = pos
  }
  let previousDefinitionPos: string | null = null
  for (const line of splitLines(definitionValue)) {
    const parsed = parsePosLine(line)
    const pos: string = parsed.pos
      ?? previousDefinitionPos
      ?? (groups.size === 1 ? [...groups.keys()][0] : '其他')
    appendUnique(ensure(pos).definitions, parsed.text)
    previousDefinitionPos = pos
  }
  return [...groups.values()]
}

function parsePosLine(line: string): { pos: string | null; text: string } {
  const match = line.match(/^([a-z][a-z-]{0,10})(?:\.\s*|\s+)(.+)$/i)
  if (!match) return { pos: null, text: line.trim() }
  const labels: Record<string, string> = {
    n: '名词 · n.', noun: '名词 · n.',
    v: '动词 · v.', verb: '动词 · v.', vt: '及物动词 · vt.', vi: '不及物动词 · vi.',
    a: '形容词 · adj.', s: '形容词 · adj.', j: '形容词 · adj.', adj: '形容词 · adj.', adjective: '形容词 · adj.',
    r: '副词 · adv.', d: '副词 · adv.', adv: '副词 · adv.', adverb: '副词 · adv.',
    p: '介词 · prep.', prep: '介词 · prep.', preposition: '介词 · prep.',
    c: '连词 · conj.', conj: '连词 · conj.', conjunction: '连词 · conj.',
    pron: '代词 · pron.', pronoun: '代词 · pron.',
    num: '数词 · num.', numeral: '数词 · num.',
    art: '冠词 · art.', article: '冠词 · art.',
    aux: '助动词 · aux.', auxiliary: '助动词 · aux.',
    int: '感叹词 · int.', interj: '感叹词 · int.', interjection: '感叹词 · int.',
  }
  const code = match[1].toLowerCase()
  return { pos: labels[code] ?? `其他 · ${code}`, text: match[2].trim() }
}

function splitLines(value: unknown): string[] {
  return String(value ?? '').split(/\\n|\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`DeepSeek 返回缺少${label}`)
  return value.trim()
}

async function requestContextApi(
  apiKey: string,
  body: Record<string, unknown>,
  network: NetworkClient,
): Promise<{ choices?: Array<{ message?: { content?: string } }> }> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await network.fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status === 401 || response.status === 403) throw new Error('API Key 无效或账户无权访问该模型')
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`DeepSeek 暂时不可用（HTTP ${response.status}）`)
      } else if (!response.ok) {
        throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）`)
      } else {
        return await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DeepSeek 请求失败'
      if (/API Key 无效|请求失败（HTTP 4(?!29)/.test(message)) throw error
      lastError = error instanceof Error ? error : new Error(message)
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 1_500))
  }
  throw lastError ?? new Error('DeepSeek 请求失败')
}

function contextCacheKey(input: {
  result: Pick<
    DictionaryLookupResult,
    'normalized' | 'lemma' | 'entries' | 'candidates' | 'requiresSelection'
  >
  context: { blockId: string; text: string; sentence: string }
  preferredLexemeKey?: LexemeKey
  dictionaryVersion: string
  modelIdentity: { providerId: string; modelId: string; cacheModel: string }
}): string {
  const basis = input.preferredLexemeKey
    ? 'selected-lexeme'
    : input.result.candidates.length > 0 ? 'auto-candidates' : 'context-only'
  const candidateDigest = sha256(JSON.stringify({
    candidates: input.result.candidates.map((candidate) => ({
      lexemeKey: candidate.lexemeKey,
      lemma: candidate.lemma,
      relation: candidate.relation,
      confidence: candidate.confidence,
    })),
    entries: input.result.entries,
  }))
  return sha256([
    input.result.normalized,
    basis,
    input.preferredLexemeKey ?? candidateDigest,
    input.context.blockId,
    sha256(input.context.text),
    sha256(input.context.sentence),
    input.dictionaryVersion,
    `${input.modelIdentity.providerId}:${input.modelIdentity.modelId}`,
    PROMPT_VERSION,
  ].join('\u001f'))
}
