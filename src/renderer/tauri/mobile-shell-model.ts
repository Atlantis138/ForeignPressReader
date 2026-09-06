import type { DictionarySearchQuery, VocabularyListQuery } from '../../shared/types'

export const MOBILE_SHELL_STORAGE_KEY = 'fpr.android.shell.v1'
export const MOBILE_SHELL_VERSION = 1 as const

export type PrimaryTab = 'library' | 'dictionary' | 'study' | 'settings'
export type DictionaryMode = 'search' | 'vocabulary'
export type LexemeHostTab = 'dictionary' | 'study'
export type MobileSettingsSection = 'appearance' | 'translation' | 'dictionary' | 'speech' | 'study' | 'data' | 'sync' | 'developer'

export type MobileRoute =
  | { name: 'library' }
  | { name: 'publication'; publicationId: string }
  | { name: 'article'; publicationId: string; articleId: string }
  | { name: 'dictionary'; mode: DictionaryMode }
  | { name: 'lexeme'; lexemeKey: string; hostTab: LexemeHostTab }
  | { name: 'study' }
  | { name: 'study-plan'; planId: string }
  | { name: 'study-plan-editor'; planId?: string }
  | { name: 'study-today'; sessionId: string }
  | { name: 'study-session' }
  | { name: 'settings' }
  | { name: 'settings-section'; section: MobileSettingsSection }

export interface MobileShellDrafts {
  dictionaryQuery: string
  vocabularyQuery: string
}

export interface MobileDictionaryBrowseSnapshot {
  search: Omit<DictionarySearchQuery, 'text'>
  vocabulary: Omit<VocabularyListQuery, 'text'>
}

export interface MobileShellState {
  version: typeof MOBILE_SHELL_VERSION
  activeTab: PrimaryTab
  stacks: Record<PrimaryTab, MobileRoute[]>
  scrollPositions: Record<string, number>
  drafts: MobileShellDrafts
  dictionaryBrowse: MobileDictionaryBrowseSnapshot
}

export type MobileBackTarget = 'overlay' | 'route' | 'system'

const TABS: PrimaryTab[] = ['library', 'dictionary', 'study', 'settings']

export function rootRoute(tab: PrimaryTab): MobileRoute {
  if (tab === 'library') return { name: 'library' }
  if (tab === 'dictionary') return { name: 'dictionary', mode: 'search' }
  if (tab === 'study') return { name: 'study' }
  return { name: 'settings' }
}

export function routeTab(route: MobileRoute): PrimaryTab {
  if (route.name === 'library' || route.name === 'publication' || route.name === 'article') return 'library'
  if (route.name === 'dictionary') return 'dictionary'
  if (route.name === 'lexeme') return route.hostTab
  if (route.name === 'study' || route.name === 'study-plan' || route.name === 'study-plan-editor'
    || route.name === 'study-today' || route.name === 'study-session') return 'study'
  return 'settings'
}

export function routeKey(route: MobileRoute): string {
  if (route.name === 'publication') return `publication:${route.publicationId}`
  if (route.name === 'article') return `article:${route.publicationId}:${route.articleId}`
  if (route.name === 'dictionary') return `dictionary:${route.mode}`
  if (route.name === 'lexeme') return `lexeme:${route.hostTab}:${route.lexemeKey}`
  if (route.name === 'study-plan') return `study-plan:${route.planId}`
  if (route.name === 'study-plan-editor') return `study-plan-editor:${route.planId ?? 'new'}`
  if (route.name === 'study-today') return `study-today:${route.sessionId}`
  if (route.name === 'settings-section') return `settings:${route.section}`
  return route.name
}

export function isImmersiveRoute(route: MobileRoute): boolean {
  return route.name === 'article' || route.name === 'study-session'
}

export function createDefaultMobileShellState(): MobileShellState {
  return {
    version: MOBILE_SHELL_VERSION,
    activeTab: 'library',
    stacks: {
      library: [rootRoute('library')],
      dictionary: [rootRoute('dictionary')],
      study: [rootRoute('study')],
      settings: [rootRoute('settings')],
    },
    scrollPositions: {},
    drafts: { dictionaryQuery: '', vocabularyQuery: '' },
    dictionaryBrowse: defaultDictionaryBrowseSnapshot(),
  }
}

export function activeRoute(state: MobileShellState): MobileRoute {
  const stack = state.stacks[state.activeTab]
  return stack[stack.length - 1] ?? rootRoute(state.activeTab)
}

export function selectPrimaryTab(state: MobileShellState, tab: PrimaryTab): MobileShellState {
  if (state.activeTab !== tab) return { ...state, activeTab: tab }
  const root = rootRoute(tab)
  return {
    ...state,
    stacks: { ...state.stacks, [tab]: [root] },
    scrollPositions: { ...state.scrollPositions, [routeKey(root)]: 0 },
  }
}

export function pushMobileRoute(state: MobileShellState, route: MobileRoute): MobileShellState {
  const tab = routeTab(route)
  const stack = state.stacks[tab]
  if (routeKey(stack[stack.length - 1] ?? rootRoute(tab)) === routeKey(route)) {
    return { ...state, activeTab: tab }
  }
  return {
    ...state,
    activeTab: tab,
    stacks: { ...state.stacks, [tab]: [...stack, route] },
  }
}

export function replaceTabRoot(state: MobileShellState, tab: PrimaryTab, route: MobileRoute): MobileShellState {
  if (routeTab(route) !== tab) return state
  return {
    ...state,
    activeTab: tab,
    stacks: { ...state.stacks, [tab]: [route] },
  }
}

/** Drop deep routes whose backing records may have been replaced by sync/import. */
export function reconcileMobileRoutesAfterDataMerge(state: MobileShellState): MobileShellState {
  const dictionaryRoot = state.stacks.dictionary.find(
    (route): route is Extract<MobileRoute, { name: 'dictionary' }> => route.name === 'dictionary',
  ) ?? rootRoute('dictionary')
  const dataSensitiveKey = (key: string) => key === 'library'
    || key.startsWith('publication:')
    || key.startsWith('article:')
    || key === 'study'
    || key.startsWith('study-plan:')
    || key.startsWith('study-plan-editor:')
    || key.startsWith('study-today:')
    || key === 'study-session'
    || key.startsWith('lexeme:')
  return {
    ...state,
    stacks: {
      ...state.stacks,
      library: [rootRoute('library')],
      dictionary: [dictionaryRoot],
      study: [rootRoute('study')],
    },
    scrollPositions: Object.fromEntries(
      Object.entries(state.scrollPositions).filter(([key]) => !dataSensitiveKey(key)),
    ),
  }
}

export function popMobileRoute(state: MobileShellState): MobileShellState {
  const stack = state.stacks[state.activeTab]
  if (stack.length <= 1) return state
  return {
    ...state,
    stacks: { ...state.stacks, [state.activeTab]: stack.slice(0, -1) },
  }
}

export function mobileBackTarget(state: MobileShellState, overlayOpen: boolean): MobileBackTarget {
  if (overlayOpen) return 'overlay'
  return state.stacks[state.activeTab].length > 1 ? 'route' : 'system'
}

export function setMobileScroll(state: MobileShellState, key: string, scrollTop: number): MobileShellState {
  const safe = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  if (state.scrollPositions[key] === safe) return state
  return { ...state, scrollPositions: { ...state.scrollPositions, [key]: safe } }
}

export function setMobileDraft(state: MobileShellState, key: keyof MobileShellDrafts, value: string): MobileShellState {
  const drafts = { ...state.drafts, [key]: value.slice(0, 500) }
  const dictionaryBrowse = key === 'dictionaryQuery'
    ? { ...state.dictionaryBrowse, search: { ...state.dictionaryBrowse.search, offset: 0 } }
    : { ...state.dictionaryBrowse, vocabulary: { ...state.dictionaryBrowse.vocabulary, offset: 0 } }
  return { ...state, drafts, dictionaryBrowse }
}

export function mobileDictionarySearchQuery(state: MobileShellState): DictionarySearchQuery {
  return { text: state.drafts.dictionaryQuery, ...state.dictionaryBrowse.search }
}

export function mobileVocabularyListQuery(state: MobileShellState): VocabularyListQuery {
  return { text: state.drafts.vocabularyQuery, ...state.dictionaryBrowse.vocabulary }
}

export function setMobileDictionarySearchQuery(state: MobileShellState, query: DictionarySearchQuery): MobileShellState {
  const sanitized = sanitizeDictionarySearch(query)
  return {
    ...state,
    drafts: { ...state.drafts, dictionaryQuery: query.text.slice(0, 500) },
    dictionaryBrowse: { ...state.dictionaryBrowse, search: sanitized },
  }
}

export function setMobileVocabularyListQuery(state: MobileShellState, query: VocabularyListQuery): MobileShellState {
  const sanitized = sanitizeVocabularySearch(query)
  return {
    ...state,
    drafts: { ...state.drafts, vocabularyQuery: query.text.slice(0, 500) },
    dictionaryBrowse: { ...state.dictionaryBrowse, vocabulary: sanitized },
  }
}

export function serializeMobileShellState(state: MobileShellState): string {
  const { persisted: studyStack, dropped: droppedStudyRoutes } = persistentStudyStack(state.stacks.study)
  const droppedStudyKeys = new Set(droppedStudyRoutes.map(routeKey))
  const persisted: MobileShellState = {
    ...state,
    version: MOBILE_SHELL_VERSION,
    stacks: {
      ...state.stacks,
      dictionary: state.stacks.dictionary,
      study: studyStack,
      settings: state.stacks.settings.some((route) => route.name === 'settings-section' && route.section === 'developer')
        ? [rootRoute('settings')]
        : state.stacks.settings,
    },
    scrollPositions: Object.fromEntries(Object.entries(state.scrollPositions).filter(([key]) => (
      key !== 'study-session' && !droppedStudyKeys.has(key)
    ))),
  }
  return JSON.stringify(persisted)
}

export function parseMobileShellState(raw: string | null): MobileShellState {
  if (!raw) return createDefaultMobileShellState()
  try {
    const value = JSON.parse(raw) as unknown
    return sanitizeShellState(value)
  } catch {
    return createDefaultMobileShellState()
  }
}

function sanitizeShellState(value: unknown): MobileShellState {
  if (!isRecord(value) || value.version !== MOBILE_SHELL_VERSION) return createDefaultMobileShellState()
  return sanitizeShellValue(value)
}

function sanitizeShellValue(value: Record<string, unknown>): MobileShellState {
  const activeTabValue = TABS.includes(value.activeTab as PrimaryTab) ? value.activeTab as PrimaryTab : 'library'
  const stacksValue = isRecord(value.stacks) ? value.stacks : {}
  const stacks = Object.fromEntries(TABS.map((tab) => [tab, sanitizeStack(tab, stacksValue[tab])])) as MobileShellState['stacks']
  const retainedRouteKeys = new Set(Object.values(stacks).flat().map(routeKey))
  const scrollPositions: Record<string, number> = {}
  if (isRecord(value.scrollPositions)) {
    for (const [key, scroll] of Object.entries(value.scrollPositions)) {
      const deviceSessionKey = key === 'study-session'
        || (key.startsWith('lexeme:study:') && !retainedRouteKeys.has(key))
      if (!deviceSessionKey && key.length <= 300 && typeof scroll === 'number' && Number.isFinite(scroll) && scroll >= 0) scrollPositions[key] = scroll
    }
  }
  const draftsValue = isRecord(value.drafts) ? value.drafts : {}
  const drafts = {
    dictionaryQuery: typeof draftsValue.dictionaryQuery === 'string' ? draftsValue.dictionaryQuery.slice(0, 500) : '',
    vocabularyQuery: typeof draftsValue.vocabularyQuery === 'string' ? draftsValue.vocabularyQuery.slice(0, 500) : '',
  }
  return {
    version: MOBILE_SHELL_VERSION,
    activeTab: activeTabValue,
    stacks,
    scrollPositions,
    drafts,
    dictionaryBrowse: sanitizeDictionaryBrowse(value.dictionaryBrowse),
  }
}

function sanitizeStack(tab: PrimaryTab, value: unknown): MobileRoute[] {
  if (!Array.isArray(value)) return [rootRoute(tab)]
  const routes = value.map(sanitizeRoute).filter((route): route is MobileRoute => route !== null && routeTab(route) === tab)
  if (!routes.length || !isRootForTab(routes[0], tab)) return [rootRoute(tab)]
  if (tab === 'study') {
    const sessionIndex = routes.findIndex((route) => route.name === 'study-session')
    return routes.slice(0, sessionIndex < 0 ? 8 : Math.min(sessionIndex, 8))
  }
  return routes.slice(0, 8)
}

function isRootForTab(route: MobileRoute, tab: PrimaryTab): boolean {
  if (tab === 'library') return route.name === 'library'
  if (tab === 'dictionary') return route.name === 'dictionary'
  if (tab === 'study') return route.name === 'study'
  return route.name === 'settings'
}

function sanitizeRoute(value: unknown): MobileRoute | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  if (value.name === 'library') return { name: 'library' }
  if (value.name === 'publication' && safeId(value.publicationId)) return { name: 'publication', publicationId: value.publicationId }
  if (value.name === 'article' && safeId(value.publicationId) && safeId(value.articleId)) return { name: 'article', publicationId: value.publicationId, articleId: value.articleId }
  if (value.name === 'dictionary' && (value.mode === 'search' || value.mode === 'vocabulary')) return { name: 'dictionary', mode: value.mode }
  if (value.name === 'lexeme' && safeId(value.lexemeKey)) {
    if (value.hostTab === 'dictionary' || value.hostTab === 'study') return { name: 'lexeme', lexemeKey: value.lexemeKey, hostTab: value.hostTab }
    return null
  }
  if (value.name === 'study') return { name: 'study' }
  if (value.name === 'study-plan' && safeId(value.planId)) return { name: 'study-plan', planId: value.planId }
  if (value.name === 'study-plan-editor') {
    if (value.planId === undefined) return { name: 'study-plan-editor' }
    if (safeId(value.planId)) return { name: 'study-plan-editor', planId: value.planId }
    return null
  }
  if (value.name === 'study-today' && safeId(value.sessionId)) return { name: 'study-today', sessionId: value.sessionId }
  if (value.name === 'study-session') return { name: 'study-session' }
  if (value.name === 'settings') return { name: 'settings' }
  if (value.name === 'settings-section' && isSettingsSection(value.section) && value.section !== 'developer') return { name: 'settings-section', section: value.section }
  return null
}

function persistentStudyStack(routes: readonly MobileRoute[]): { persisted: MobileRoute[]; dropped: MobileRoute[] } {
  const sessionIndex = routes.findIndex((route) => route.name === 'study-session')
  const boundary = sessionIndex < 0 ? routes.length : sessionIndex
  const persisted = routes.slice(0, boundary)
  return {
    persisted: persisted.length ? persisted : [rootRoute('study')],
    dropped: routes.slice(boundary),
  }
}

function defaultDictionaryBrowseSnapshot(): MobileDictionaryBrowseSnapshot {
  return {
    search: {
      tags: [],
      tagMatch: 'any',
      oxfordOnly: false,
      collinsMin: null,
      bncMax: null,
      contemporaryMax: null,
      sort: 'relevance',
      offset: 0,
      limit: 30,
    },
    vocabulary: { offset: 0, limit: 50 },
  }
}

function sanitizeDictionaryBrowse(value: unknown): MobileDictionaryBrowseSnapshot {
  if (!isRecord(value)) return defaultDictionaryBrowseSnapshot()
  return {
    search: sanitizeDictionarySearch(value.search),
    vocabulary: sanitizeVocabularySearch(value.vocabulary),
  }
}

function sanitizeDictionarySearch(value: unknown): MobileDictionaryBrowseSnapshot['search'] {
  const fallback = defaultDictionaryBrowseSnapshot().search
  if (!isRecord(value)) return fallback
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => typeof tag === 'string' && tag.length <= 50 && safeText(tag) ? [tag] : []).slice(0, 12)
    : []
  return {
    tags,
    tagMatch: value.tagMatch === 'all' ? 'all' : 'any',
    oxfordOnly: value.oxfordOnly === true,
    collinsMin: nullableInteger(value.collinsMin, 1, 5),
    bncMax: nullableInteger(value.bncMax, 1, 10_000_000),
    contemporaryMax: nullableInteger(value.contemporaryMax, 1, 10_000_000),
    sort: value.sort === 'frequency' || value.sort === 'alphabetical' ? value.sort : 'relevance',
    offset: boundedInteger(value.offset, 0, Number.MAX_SAFE_INTEGER, fallback.offset),
    limit: boundedInteger(value.limit, 1, 50, fallback.limit),
  }
}

function sanitizeVocabularySearch(value: unknown): MobileDictionaryBrowseSnapshot['vocabulary'] {
  const fallback = defaultDictionaryBrowseSnapshot().vocabulary
  if (!isRecord(value)) return fallback
  return {
    offset: boundedInteger(value.offset, 0, Number.MAX_SAFE_INTEGER, fallback.offset),
    limit: boundedInteger(value.limit, 1, 50, fallback.limit),
  }
}

function nullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : boundedInteger(value, minimum, maximum, null)
}

function boundedInteger<T extends number | null>(value: unknown, minimum: number, maximum: number, fallback: T): number | T {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function safeText(value: string): boolean {
  return !/[\u0000-\u001f]/.test(value)
}

function isSettingsSection(value: unknown): value is MobileSettingsSection {
  return value === 'appearance' || value === 'translation' || value === 'dictionary'
    || value === 'speech' || value === 'study' || value === 'data' || value === 'sync' || value === 'developer'
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
