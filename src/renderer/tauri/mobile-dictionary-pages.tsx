import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DictionaryCollection,
  DictionaryCredentialStatus,
  DictionaryPreferences,
  DictionarySearchItem,
  DictionarySearchPage,
  DictionarySearchQuery,
  SavedContextPage,
  VocabularyListPage,
} from '../../shared/types'
import type { MobileDictionaryCenterStatus, MobileDictionaryInstallPreflight, MobileLexemeSource } from '../../shared/mobile-learning'
import type { MobileSpeechClient } from '../../shared/mobile-online-services'
import { buildMobileLexemePresentation } from '../../shared/mobile-lexeme-presentation'
import { SlidersIcon, SpeakerIcon, TrashIcon } from '../ui/icons'
import {
  ChoiceChip,
  ConfirmDialog,
  ContextCard,
  EditorialCard,
  EmptyState,
  FilterSheet,
  LexemeBadges,
  LexemeHeader,
  MobileButton,
  PageHeader,
  PaginationFooter,
  SearchField,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toggle,
  TopAppBar,
  type MobileTask,
} from './mobile-ui'
import type { DictionaryMode } from './mobile-shell-model'

export interface MobileDictionaryUiClient {
  getStatus(): Promise<MobileDictionaryCenterStatus>
  peekStatus?(): MobileDictionaryCenterStatus | undefined
  preflightInstall(profile: 'standard' | 'full'): Promise<MobileDictionaryInstallPreflight>
  install(profile: 'standard' | 'full'): Promise<void>
  installFromLocal(profile: 'standard' | 'full'): Promise<boolean>
  repair(profile: 'standard' | 'full'): Promise<void>
  removeFullExtension(): Promise<void>
  remove(): Promise<void>
  cancelInstall(): Promise<void>
  search(query: DictionarySearchQuery): Promise<DictionarySearchPage>
  listCollections(): Promise<DictionaryCollection[]>
  peekCollections?(): DictionaryCollection[] | undefined
  getLexemeSource(lexemeKey: string): Promise<MobileLexemeSource>
  listFavorites(query: { text: string; offset: number; limit: number }): Promise<VocabularyListPage>
  listContexts(lexemeKey: string, offset?: number): Promise<SavedContextPage>
  removeFavorite(lexemeKey: string): Promise<void>
  getPreferences(): Promise<DictionaryPreferences>
  savePreferences(value: DictionaryPreferences): Promise<DictionaryPreferences>
  getCredentialStatus(): Promise<DictionaryCredentialStatus>
  saveBaiduCredentials(apiKey: string, secretKey: string): Promise<{ ok: boolean; message: string }>
  deleteBaiduCredentials(): Promise<void>
  testBaiduConnection(): Promise<{ ok: boolean; message: string }>
}

const DEFAULT_QUERY: DictionarySearchQuery = {
  text: '', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
  bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 0, limit: 30,
}

export function MobileDictionaryHome({ client, mode, dictionaryText, vocabularyText, onMode, onDictionaryText, onVocabularyText, onLexeme, onArticle, onOpenSettings, onError }: {
  client: MobileDictionaryUiClient
  mode: DictionaryMode
  dictionaryText: string
  vocabularyText: string
  onMode(mode: DictionaryMode): void
  onDictionaryText(value: string): void
  onVocabularyText(value: string): void
  onLexeme(lexemeKey: string): void
  onArticle(publicationId: string, articleId: string): void
  onOpenSettings(): void
  onError(message: string): void
}) {
  return <div className="mobile-page dictionary-page">
    <PageHeader eyebrow="LEXICON" title="词典" description="ECDICT 词条、考试标签、词频与收藏语境。" />
    <SegmentedControl value={mode} label="词典模式" items={[{ value: 'search', label: '词典检索' }, { value: 'vocabulary', label: '我的生词' }]} onChange={onMode} />
    {mode === 'search'
      ? <MobileDictionarySearch client={client} text={dictionaryText} onText={onDictionaryText} onLexeme={onLexeme} onOpenSettings={onOpenSettings} onError={onError} />
      : <MobileVocabularyList client={client} text={vocabularyText} onText={onVocabularyText} onLexeme={onLexeme} onArticle={onArticle} onError={onError} />}
  </div>
}

function MobileDictionarySearch({ client, text, onText, onLexeme, onOpenSettings, onError }: {
  client: MobileDictionaryUiClient; text: string; onText(value: string): void; onLexeme(lexemeKey: string): void; onOpenSettings(): void; onError(message: string): void
}) {
  const [status, setStatus] = useState<MobileDictionaryCenterStatus | null>(() => client.peekStatus?.() ?? null)
  const [collections, setCollections] = useState<DictionaryCollection[]>(() => client.peekCollections?.() ?? [])
  const [query, setQuery] = useState<DictionarySearchQuery>({ ...DEFAULT_QUERY, text })
  const [page, setPage] = useState<DictionarySearchPage | null>(null)
  const [busy, setBusy] = useState<'status' | 'search' | null>(() => client.peekStatus?.() ? null : 'status')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const sequence = useRef(0)
  const reloadStatus = useCallback(async () => {
    const next = await client.getStatus(); setStatus(next)
    setCollections(next.baseInstalled ? await client.listCollections() : [])
  }, [client])
  useEffect(() => { void reloadStatus().catch((reason) => onError(messageOf(reason))).finally(() => setBusy(null)) }, [onError, reloadStatus])
  useEffect(() => { setQuery((current) => ({ ...current, text, offset: current.text === text ? current.offset : 0 })) }, [text])
  const runSearch = useCallback(async (next: DictionarySearchQuery) => {
    if (!status?.baseInstalled) return
    if (!next.text.trim() && !activeFilterCount(next)) { setPage(null); return }
    const current = ++sequence.current; setBusy('search')
    try { const result = await client.search(next); if (current === sequence.current) { setPage(result); setQuery(next) } }
    catch (reason) { if (current === sequence.current) onError(messageOf(reason)) }
    finally { if (current === sequence.current) setBusy(null) }
  }, [client, onError, status?.baseInstalled])
  useEffect(() => {
    if (!status?.baseInstalled) return
    const next = { ...query, text, offset: query.text === text ? query.offset : 0 }
    const timer = window.setTimeout(() => void runSearch(next), 180)
    return () => window.clearTimeout(timer)
  }, [status?.baseInstalled, text, query.tags, query.tagMatch, query.oxfordOnly, query.collinsMin, query.bncMax, query.contemporaryMax, query.sort]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleTag = (tag: string) => setQuery((current) => ({ ...current, tags: current.tags.includes(tag) ? current.tags.filter((item) => item !== tag) : [...current.tags, tag], offset: 0 }))
  const clearFilters = () => setQuery((current) => ({ ...DEFAULT_QUERY, text: current.text }))
  const count = activeFilterCount(query)
  if (!status) return <section className="dictionary-mode-content"><Skeleton lines={4} /></section>
  return <section className="dictionary-mode-content">
    {!status.baseInstalled ? <EmptyState symbol="词" title="请先安装本地词典" description="ECDICT 资源统一在“设置－词典服务”中管理；安装后这里专注查词与生词。" action={<MobileButton onClick={onOpenSettings}>前往词典设置</MobileButton>} /> : <>
      <SearchField value={text} onChange={onText} onSubmit={() => void runSearch({ ...query, text: text.trim(), offset: 0 })} placeholder="输入英文单词或中文释义" />
      <div className="dictionary-collection-strip">{collections.map((collection) => <ChoiceChip key={collection.id} selected={query.tags.includes(collection.tag)} onClick={() => toggleTag(collection.tag)}><b>{collection.name}</b> <small>{collection.count.toLocaleString('zh-CN')}</small></ChoiceChip>)}</div>
      <div className="dictionary-filter-bar"><MobileButton onClick={() => setFiltersOpen(true)}><SlidersIcon /> 高级筛选{count ? <b>{count}</b> : null}</MobileButton>{count ? <MobileButton variant="text" onClick={clearFilters}>清除条件</MobileButton> : null}</div>
      {page && <p className="dictionary-result-count">共 {page.total.toLocaleString('zh-CN')} 个结果</p>}
      {busy === 'search' ? <Skeleton lines={5} /> : page?.items.length ? <DictionaryResults items={page.items} onLexeme={onLexeme} /> : Boolean(query.text.trim() || count) && <EmptyState symbol="词" title="没有匹配词条" description="尝试清除筛选或换一个英文词头、词形或中文释义。" />}
      {page && <PaginationFooter offset={page.offset} limit={page.limit} total={page.total} onPrevious={() => void runSearch({ ...query, offset: Math.max(0, page.offset - page.limit) })} onNext={() => void runSearch({ ...query, offset: page.offset + page.limit })} />}
    </>}
    {filtersOpen && <DictionaryFilterSheet query={query} onQuery={setQuery} onClose={() => setFiltersOpen(false)} onClear={clearFilters} />}
  </section>
}

function DictionaryResults({ items, onLexeme }: { items: DictionarySearchItem[]; onLexeme(lexemeKey: string): void }) {
  return <div className="dictionary-results">{items.map((item) => <button key={item.lexemeKey} onClick={() => onLexeme(item.lexemeKey)}><span><b>{item.lemma}</b>{item.phonetic && <small>/{item.phonetic}/</small>}</span><p>{item.briefMeanings.join('；') || '暂无简释'}</p><em>{item.matchedBy === 'form' ? '词形匹配' : item.matchedBy === 'translation' ? '中文释义' : item.oxford ? 'Oxford' : '词元匹配'}</em></button>)}</div>
}

function DictionaryFilterSheet({ query, onQuery, onClose, onClear }: { query: DictionarySearchQuery; onQuery(value: DictionarySearchQuery): void; onClose(): void; onClear(): void }) {
  return <FilterSheet title="高级筛选" onClose={onClose}><Toggle checked={query.oxfordOnly} label="仅 Oxford 词条" onChange={(oxfordOnly) => onQuery({ ...query, oxfordOnly, offset: 0 })} /><label>Collins 星级至少 <select value={query.collinsMin ?? ''} onChange={(event) => onQuery({ ...query, collinsMin: event.target.value ? Number(event.target.value) : null, offset: 0 })}><option value="">不限</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>BNC 排名上限 <input type="number" min="1" value={query.bncMax ?? ''} placeholder="不限" onChange={(event) => onQuery({ ...query, bncMax: event.target.value ? Number(event.target.value) : null, offset: 0 })} /></label><label>当代词频排名上限 <input type="number" min="1" value={query.contemporaryMax ?? ''} placeholder="不限" onChange={(event) => onQuery({ ...query, contemporaryMax: event.target.value ? Number(event.target.value) : null, offset: 0 })} /></label><SegmentedControl value={query.tagMatch} label="标签匹配" items={[{ value: 'any', label: '任一标签' }, { value: 'all', label: '全部标签' }]} onChange={(tagMatch) => onQuery({ ...query, tagMatch, offset: 0 })} /><SegmentedControl value={query.sort} label="结果排序" items={[{ value: 'relevance', label: '相关度' }, { value: 'frequency', label: '词频' }, { value: 'alphabetical', label: '字母序' }]} onChange={(sort) => onQuery({ ...query, sort, offset: 0 })} /><MobileButton variant="text" onClick={onClear}>清除全部条件</MobileButton></FilterSheet>
}

function MobileVocabularyList({ client, text, onText, onLexeme, onArticle, onError }: { client: MobileDictionaryUiClient; text: string; onText(value: string): void; onLexeme(lexemeKey: string): void; onArticle(publicationId: string, articleId: string): void; onError(message: string): void }) {
  const [page, setPage] = useState<VocabularyListPage | null>(null)
  const [contexts, setContexts] = useState<{ lexemeKey: string; page: SavedContextPage } | null>(null)
  const [busy, setBusy] = useState(true)
  const sequence = useRef(0)
  const load = useCallback(async (offset = 0) => { const current = ++sequence.current; setBusy(true); try { const result = await client.listFavorites({ text: text.trim(), offset, limit: 30 }); if (current === sequence.current) setPage(result) } catch (reason) { onError(messageOf(reason)) } finally { if (current === sequence.current) setBusy(false) } }, [client, onError, text])
  useEffect(() => { const timer = window.setTimeout(() => void load(0), 180); return () => window.clearTimeout(timer) }, [load])
  const openContexts = async (lexemeKey: string) => { try { setContexts({ lexemeKey, page: await client.listContexts(lexemeKey) }) } catch (reason) { onError(messageOf(reason)) } }
  const remove = async (lexemeKey: string) => { try { await client.removeFavorite(lexemeKey); await load(page?.offset ?? 0) } catch (reason) { onError(messageOf(reason)) } }
  return <section className="dictionary-mode-content vocabulary-page"><SearchField value={text} onChange={onText} onSubmit={() => void load(0)} placeholder="搜索词条或释义" />{busy ? <Skeleton lines={5} /> : page?.items.length ? <div className="vocabulary-list">{page.items.map((item) => <article key={item.lexemeKey}><button className="vocabulary-main" onClick={() => onLexeme(item.lexemeKey)}><span><h2>{item.lemma}</h2>{item.phonetic && <em>/{item.phonetic}/</em>}</span><p>{item.briefMeanings.join('；') || '收藏快照暂无简释'}</p><small>{new Date(item.addedAt).toLocaleDateString('zh-CN')}</small></button><div><MobileButton variant="text" onClick={() => void openContexts(item.lexemeKey)}>收藏语境</MobileButton><MobileButton variant="text" onClick={() => void remove(item.lexemeKey)}>取消收藏</MobileButton></div></article>)}</div> : <EmptyState symbol="词" title="还没有生词" description="在文章中点词后，可以收藏词条或只收藏当前语境。" />}{page && <PaginationFooter offset={page.offset} limit={page.limit} total={page.total} onPrevious={() => void load(Math.max(0, page.offset - page.limit))} onNext={() => void load(page.offset + page.limit)} />}
    {contexts && <FilterSheet title="收藏语境" onClose={() => setContexts(null)}>{contexts.page.items.length ? <div className="dictionary-context-list">{contexts.page.items.map((context) => <ContextCard key={context.contextId} title={context.articleTitle} sentence={context.sentence} action={context.publicationId && context.articleId ? <MobileButton variant="text" onClick={() => { setContexts(null); onArticle(context.publicationId!, context.articleId!) }}>回到原刊文章</MobileButton> : <StatusPill tone="warning">原刊已删除</StatusPill>} />)}</div> : <EmptyState symbol="引" title="尚未收藏语境" description="词条仍保留在我的生词中。" />}</FilterSheet>}
  </section>
}

export function MobileLexemePage({ client, speech, lexemeKey, onBack, onArticle, onError }: { client: MobileDictionaryUiClient; speech: MobileSpeechClient; lexemeKey: string; onBack(): void; onArticle(publicationId: string, articleId: string): void; onError(message: string): void }) {
  const [source, setSource] = useState<MobileLexemeSource | null>(null)
  const [contexts, setContexts] = useState<SavedContextPage | null>(null)
  useEffect(() => {
    let active = true
    void client.getLexemeSource(lexemeKey).then((value) => active && setSource(value)).catch((reason) => onError(messageOf(reason)))
    void client.listContexts(lexemeKey).then((value) => active && setContexts(value)).catch(() => undefined)
    return () => { active = false }
  }, [client, lexemeKey, onError])
  const presentation = useMemo(() => source ? buildMobileLexemePresentation(source) : null, [source])
  const speak = async () => {
    if (!presentation) return
    const settings = await speech.getSettings()
    const providerId = settings.preferences.wordProviderId
    const provider = settings.preferences.providerSettings[providerId]
    await speech.play({ providerId, modelId: provider?.modelId ?? 'system', voiceId: provider?.voiceId ?? settings.preferences.voiceId ?? '', text: presentation.lemma, locale: settings.preferences.locale, rate: settings.preferences.rate, sourceId: 'dictionary', itemId: presentation.lexemeKey, usage: 'word' })
  }
  return <div className="mobile-page lexeme-page"><TopAppBar title="词条详情" onBack={onBack} />{!presentation ? <Skeleton lines={6} /> : <section className="dictionary-detail">
    <p className="mobile-eyebrow">{presentation.source === 'snapshot' ? 'SAVED SNAPSHOT' : 'LEXEME'}</p>
    <LexemeHeader lemma={presentation.lemma} phonetic={presentation.phonetic} action={<MobileButton variant="text" onClick={() => void speak().catch((reason) => onError(messageOf(reason)))}><SpeakerIcon /> 发音</MobileButton>} />
    {presentation.source === 'snapshot' && <StatusPill tone="warning">正在显示收藏快照</StatusPill>}
    <LexemeBadges badges={presentation.badges.map(({ label, tone }) => ({ label, tone }))} />
    <section className="lexeme-entry">{presentation.senses.map((sense, index) => <details key={sense.key} open={index < 2}><summary>{sense.partOfSpeech}</summary>{sense.translations.map((meaning) => <p key={meaning}>{meaning}</p>)}{sense.definitions.map((definition) => <p className="lexeme-definition" key={definition}>{definition}</p>)}</details>)}</section>
    {presentation.forms.length ? <section className="lexeme-forms"><h2>词形</h2><p>{presentation.forms.join(' · ')}</p></section> : null}
    {presentation.examples.length ? <section className="lexeme-examples"><h2>例句</h2>{presentation.examples.map((example) => <ContextCard key={example.exampleId} title={example.partOfSpeech ?? undefined} sentence={example.text} translation={example.translationZh} />)}</section> : null}
    {contexts?.items.length ? <section className="lexeme-contexts"><h2>收藏语境</h2>{contexts.items.map((context) => <ContextCard key={context.contextId} title={context.articleTitle} sentence={context.sentence} action={context.publicationId && context.articleId ? <MobileButton variant="text" onClick={() => onArticle(context.publicationId!, context.articleId!)}>回到原刊文章</MobileButton> : <StatusPill tone="warning">原刊已删除</StatusPill>} />)}</section> : null}
  </section>}</div>
}

export function MobileDictionarySettings({ client, onError, onNotice, onTask }: { client: MobileDictionaryUiClient; onError(message: string): void; onNotice(message: string): void; onTask(task: MobileTask | null): void }) {
  const [status, setStatus] = useState<MobileDictionaryCenterStatus | null>(null)
  const [saved, setSaved] = useState<DictionaryPreferences | null>(null)
  const [draft, setDraft] = useState<DictionaryPreferences | null>(null)
  const [credentials, setCredentials] = useState<DictionaryCredentialStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [resourceBusy, setResourceBusy] = useState<'install' | 'repair' | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const reloadStatus = useCallback(async () => setStatus(await client.getStatus()), [client])
  const reloadCredentials = useCallback(async () => setCredentials(await client.getCredentialStatus()), [client])
  useEffect(() => { void Promise.all([client.getStatus(), client.getPreferences(), client.getCredentialStatus()]).then(([nextStatus, preferences, nextCredentials]) => { setStatus(nextStatus); setSaved(preferences); setDraft(preferences); setCredentials(nextCredentials) }).catch((reason) => onError(messageOf(reason))) }, [client, onError])
  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [draft, saved])
  const save = async () => { if (!draft) return; try { const next = await client.savePreferences(draft); setSaved(next); setDraft(next); onNotice('词典设置已保存。') } catch (reason) { onError(messageOf(reason)) } }
  const saveCredentials = async () => { setBusy(true); try { const result = await client.saveBaiduCredentials(apiKey, secretKey); if (!result.ok) throw new Error(result.message); setApiKey(''); setSecretKey(''); await reloadCredentials(); onNotice(result.message) } catch (reason) { onError(messageOf(reason)) } finally { setBusy(false) } }
  const testCredentials = async () => { setBusy(true); try { const result = await client.testBaiduConnection(); if (!result.ok) throw new Error(result.message); onNotice(result.message) } catch (reason) { onError(messageOf(reason)) } finally { setBusy(false) } }
  const deleteCredentials = async () => { setBusy(true); try { await client.deleteBaiduCredentials(); await reloadCredentials(); onNotice('百度凭据已删除。') } catch (reason) { onError(messageOf(reason)) } finally { setBusy(false) } }
  const install = async (profile: 'standard' | 'full', fromLocal = false) => {
    if (!fromLocal) {
      try {
        const preflight = await client.preflightInstall(profile)
        if (!preflight.canInstall) {
          onError(`可用空间不足：安装至少需要 ${Math.ceil(preflight.requiredBytes / 1024 / 1024)} MiB。`)
          return
        }
      } catch (reason) { onError(messageOf(reason)); return }
    }
    setResourceBusy('install')
    onTask({ id: 'dictionary-install', kind: 'dictionary', label: profile === 'full' ? '正在构建完整 ECDICT' : '正在预载离线词典', detail: '新资源校验通过前会继续保留旧版本。', progress: null, onCancel: () => void client.cancelInstall() })
    try {
      const installed = fromLocal ? await client.installFromLocal(profile) : (await client.install(profile), true)
      if (installed) {
        await reloadStatus()
        onNotice(profile === 'full' ? '完整定义扩展已安装。' : 'ECDICT 标准包已安装。')
      } else onNotice('已取消选择，原资源保持不变。')
    } catch (reason) { onError(messageOf(reason)) }
    finally { setResourceBusy(null); onTask(null) }
  }
  const repair = async () => {
    if (!status) return
    setResourceBusy('repair')
    onTask({ id: 'dictionary-repair', kind: 'dictionary', label: '正在修复词典资源', detail: '深度完整性检查在后台运行。', progress: null, onCancel: () => void client.cancelInstall() })
    try { await client.repair(status.fullExtensionInstalled ? 'full' : 'standard'); await reloadStatus(); onNotice('词典资源已修复。') }
    catch (reason) { onError(messageOf(reason)) }
    finally { setResourceBusy(null); onTask(null) }
  }
  const downgrade = async () => {
    try { await client.removeFullExtension(); await reloadStatus(); onNotice('已降级为标准学习包。') }
    catch (reason) { onError(messageOf(reason)) }
  }
  const remove = async () => {
    setRemoveConfirm(false)
    try { await client.remove(); await reloadStatus(); onNotice('本地词典已删除；生词、语境和学习进度仍保留。') }
    catch (reason) { onError(messageOf(reason)) }
  }
  if (!status || !draft) return <Skeleton lines={5} />
  return <div className="dictionary-settings">
    <EditorialCard className="dictionary-resource-card">
      <div className="mobile-service-heading"><div><h2>本地词典</h2><p>标准学习包是查词、收藏和学习计划的离线基座；完整扩展提供更多长尾定义。</p></div><StatusPill tone={status.health === 'damaged' ? 'danger' : status.baseInstalled ? 'success' : 'neutral'}>{status.health === 'damaged' ? '需要修复' : status.baseInstalled ? status.effectiveProfile === 'full' ? '完整包' : '标准包' : '未安装'}</StatusPill></div>
      {status.baseInstalled ? <>
        <p className="dictionary-resource-summary"><b>{status.effectiveProfile === 'full' ? 'ECDICT 完整包' : 'ECDICT 标准学习包'}</b><span>{status.entryCount.toLocaleString('zh-CN')} 词元 · {status.formCount.toLocaleString('zh-CN')} 词形</span></p>
        <div className="mobile-service-actions">{!status.fullExtensionInstalled && <MobileButton variant="primary" disabled={resourceBusy !== null} onClick={() => void install('full')}>升级为完整包</MobileButton>}<MobileButton disabled={resourceBusy !== null} onClick={() => void repair()}>{resourceBusy === 'repair' ? '修复中…' : '修复'}</MobileButton>{status.fullExtensionInstalled && <MobileButton disabled={resourceBusy !== null} onClick={() => void downgrade()}>降级为标准包</MobileButton>}<MobileButton variant="danger" disabled={resourceBusy !== null} onClick={() => setRemoveConfirm(true)}><TrashIcon /> 删除词典</MobileButton></div>
      </> : <>
        <p className="dictionary-resource-summary">安装后可完全离线查词、收藏语境并建立学习计划。</p>
        <div className="mobile-service-actions"><MobileButton variant="primary" disabled={resourceBusy !== null} onClick={() => void install('standard')}>安装标准包</MobileButton><MobileButton disabled={resourceBusy !== null} onClick={() => void install('full')}>安装完整包</MobileButton><MobileButton variant="text" disabled={resourceBusy !== null} onClick={() => void install('standard', true)}>从本机选择</MobileButton></div>
      </>}
    </EditorialCard>
    <EditorialCard className="dictionary-preference-card">
      <div className="mobile-service-heading"><div><h2>词典服务</h2><p>本地数据来自 skywind3000/ECDICT · MIT；百度可按需补充中文详释和例句。</p></div></div>
      <Toggle checked={draft.enabled} label="点击查词" description="关闭后阅读器不会响应正文点词。" onChange={(enabled) => setDraft({ ...draft, enabled })} />
      <Toggle checked={draft.contextExplanationEnabled} label="文中义分析" description="使用当前翻译服务根据语境直接分析，没有本地词条也可使用。" onChange={(contextExplanationEnabled) => setDraft({ ...draft, contextExplanationEnabled })} />
      <div className="dictionary-online-options">
        <div className="dictionary-online-label"><b>在线词典</b><span>详细释义来源</span></div>
        <SegmentedControl value={draft.lookupProviderId} label="在线词典" items={[{ value: 'ecdict', label: '仅使用本地' }, { value: 'baidu', label: '百度增强' }]} onChange={(lookupProviderId) => setDraft({ ...draft, lookupProviderId })} />
        {draft.lookupProviderId === 'baidu' && <><Toggle checked={draft.fallbackToLocal} label="百度不可用时自动回退本地" description="ECDICT 的考试标签和词频始终保留。" onChange={(fallbackToLocal) => setDraft({ ...draft, fallbackToLocal })} /><Toggle checked={draft.translateExamples} label="自动翻译学习例句" description="使用当前翻译服务生成中文例句译文。" onChange={(translateExamples) => setDraft({ ...draft, translateExamples })} /></>}
      </div>
      <div className="mobile-form-actions"><MobileButton disabled={!dirty} onClick={() => saved && setDraft(saved)}>撤销改动</MobileButton><MobileButton variant="primary" disabled={!dirty} onClick={() => void save()}>保存词典设置</MobileButton></div>
    </EditorialCard>
    {draft.lookupProviderId === 'baidu' && <EditorialCard className="mobile-service-card"><div className="mobile-service-heading"><div><h2>百度在线增强</h2><p>API Key 与 Secret Key 作为一个原子凭据包保存在 Android Keystore。</p></div><StatusPill tone={credentials?.configured ? 'success' : 'warning'}>{credentials?.configured ? '已配置' : '未配置'}</StatusPill></div>{credentials?.configured && <code>{credentials.apiKey.masked}</code>}<label>百度 API Key<input type="password" autoComplete="off" value={apiKey} placeholder="输入新凭据以替换" onChange={(event) => setApiKey(event.target.value)} /></label><label>百度 Secret Key<input type="password" autoComplete="off" value={secretKey} placeholder="输入新凭据以替换" onChange={(event) => setSecretKey(event.target.value)} /></label><div className="mobile-service-actions"><MobileButton variant="primary" disabled={busy || apiKey.trim().length < 16 || secretKey.trim().length < 16} onClick={() => void saveCredentials()}>保存并测试</MobileButton><MobileButton disabled={busy || !credentials?.configured} onClick={() => void testCredentials()}>测试连接</MobileButton>{credentials?.configured && <MobileButton variant="text" disabled={busy} onClick={() => void deleteCredentials()}>删除凭据</MobileButton>}</div></EditorialCard>}
    {removeConfirm && <ConfirmDialog title="删除本地词典资源？" description="ECDICT 索引会被删除，但书库、生词快照、收藏语境和学习进度都会保留。" confirmLabel="删除资源" onCancel={() => setRemoveConfirm(false)} onConfirm={() => void remove()} />}
  </div>
}

function activeFilterCount(query: DictionarySearchQuery) { return query.tags.length + Number(query.oxfordOnly) + Number(query.collinsMin !== null) + Number(query.bncMax !== null) + Number(query.contemporaryMax !== null) + Number(query.sort !== 'relevance') + Number(query.tagMatch !== 'any') }
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
