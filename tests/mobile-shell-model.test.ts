import { describe, expect, it } from 'vitest'
import {
  MOBILE_SHELL_VERSION,
  activeRoute,
  createDefaultMobileShellState,
  isImmersiveRoute,
  mobileBackTarget,
  mobileDictionarySearchQuery,
  mobileVocabularyListQuery,
  parseMobileShellState,
  popMobileRoute,
  pushMobileRoute,
  reconcileMobileRoutesAfterDataMerge,
  replaceTabRoot,
  selectPrimaryTab,
  serializeMobileShellState,
  setMobileDictionarySearchQuery,
  setMobileDraft,
  setMobileScroll,
  setMobileVocabularyListQuery,
} from '../src/renderer/tauri/mobile-shell-model'

describe('Android Alpha mobile shell model', () => {
  it('keeps four independent stacks and resets only a reselected tab', () => {
    let state = createDefaultMobileShellState()
    state = pushMobileRoute(state, { name: 'publication', publicationId: 'publication-1' })
    state = pushMobileRoute(state, { name: 'article', publicationId: 'publication-1', articleId: 'article-1' })
    state = selectPrimaryTab(state, 'dictionary')
    state = pushMobileRoute(state, { name: 'lexeme', lexemeKey: 'en:example', hostTab: 'dictionary' })

    expect(activeRoute(state)).toEqual({ name: 'lexeme', lexemeKey: 'en:example', hostTab: 'dictionary' })
    expect(state.stacks.library).toHaveLength(3)

    state = selectPrimaryTab(state, 'library')
    expect(activeRoute(state).name).toBe('article')
    state = selectPrimaryTab(state, 'library')
    expect(state.stacks.library).toEqual([{ name: 'library' }])
    expect(state.stacks.dictionary).toHaveLength(2)
  })

  it('routes Back to overlays, the current stack, then Android system exit', () => {
    let state = createDefaultMobileShellState()
    expect(mobileBackTarget(state, false)).toBe('system')
    expect(mobileBackTarget(state, true)).toBe('overlay')

    state = pushMobileRoute(state, { name: 'publication', publicationId: 'publication-1' })
    expect(mobileBackTarget(state, false)).toBe('route')
    state = popMobileRoute(state)
    expect(activeRoute(state)).toEqual({ name: 'library' })
  })

  it('hosts study word details on the study stack and never persists that session stack', () => {
    let state = createDefaultMobileShellState()
    state = pushMobileRoute(state, { name: 'study-plan', planId: 'plan-1' })
    state = pushMobileRoute(state, { name: 'study-session' })
    state = pushMobileRoute(state, { name: 'lexeme', lexemeKey: 'lex_en_study', hostTab: 'study' })
    state = setMobileScroll(state, 'study-plan:plan-1', 80)
    state = setMobileScroll(state, 'study-session', 240)
    state = setMobileScroll(state, 'lexeme:study:lex_en_study', 120)

    expect(state.activeTab).toBe('study')
    expect(activeRoute(state)).toEqual({ name: 'lexeme', lexemeKey: 'lex_en_study', hostTab: 'study' })
    expect(state.stacks.dictionary).toEqual([{ name: 'dictionary', mode: 'search' }])

    const restored = parseMobileShellState(serializeMobileShellState(state))
    expect(restored.stacks.study).toEqual([{ name: 'study' }, { name: 'study-plan', planId: 'plan-1' }])
    expect(restored.scrollPositions['study-plan:plan-1']).toBe(80)
    expect(restored.scrollPositions['study-session']).toBeUndefined()
    expect(restored.scrollPositions['lexeme:study:lex_en_study']).toBeUndefined()
  })

  it('returns from hosted lexeme details to the exact dictionary or study source route', () => {
    let dictionary = createDefaultMobileShellState()
    dictionary = selectPrimaryTab(dictionary, 'dictionary')
    dictionary = pushMobileRoute(dictionary, { name: 'lexeme', lexemeKey: 'lex_en_dictionary', hostTab: 'dictionary' })
    expect(activeRoute(popMobileRoute(dictionary))).toEqual({ name: 'dictionary', mode: 'search' })

    let study = createDefaultMobileShellState()
    study = selectPrimaryTab(study, 'study')
    study = pushMobileRoute(study, { name: 'study-plan', planId: 'plan-1' })
    study = pushMobileRoute(study, { name: 'lexeme', lexemeKey: 'lex_en_study', hostTab: 'study' })
    const returned = popMobileRoute(study)
    expect(returned.activeTab).toBe('study')
    expect(activeRoute(returned)).toEqual({ name: 'study-plan', planId: 'plan-1' })
    expect(returned.stacks.dictionary).toEqual([{ name: 'dictionary', mode: 'search' }])
  })

  it('persists plan, editor and completed-today summary routes', () => {
    let editor = createDefaultMobileShellState()
    editor = pushMobileRoute(editor, { name: 'study-plan-editor', planId: 'plan-1' })
    expect(parseMobileShellState(serializeMobileShellState(editor)).stacks.study).toEqual([
      { name: 'study' }, { name: 'study-plan-editor', planId: 'plan-1' },
    ])

    let today = createDefaultMobileShellState()
    today = pushMobileRoute(today, { name: 'study-today', sessionId: 'completed-2026-07-13' })
    expect(parseMobileShellState(serializeMobileShellState(today)).stacks.study).toEqual([
      { name: 'study' }, { name: 'study-today', sessionId: 'completed-2026-07-13' },
    ])

    let planWord = createDefaultMobileShellState()
    planWord = pushMobileRoute(planWord, { name: 'study-plan', planId: 'plan-1' })
    planWord = pushMobileRoute(planWord, { name: 'lexeme', lexemeKey: 'lex_en_plan', hostTab: 'study' })
    planWord = setMobileScroll(planWord, 'lexeme:study:lex_en_plan', 64)
    const restoredPlanWord = parseMobileShellState(serializeMobileShellState(planWord))
    expect(restoredPlanWord.stacks.study.at(-1)).toEqual({ name: 'lexeme', lexemeKey: 'lex_en_plan', hostTab: 'study' })
    expect(restoredPlanWord.scrollPositions['lexeme:study:lex_en_plan']).toBe(64)
  })

  it('supports cross-module deep links without destroying the source stack', () => {
    let state = createDefaultMobileShellState()
    state = pushMobileRoute(state, { name: 'article', publicationId: 'publication-1', articleId: 'article-1' })
    state = replaceTabRoot(state, 'dictionary', { name: 'dictionary', mode: 'vocabulary' })

    expect(state.activeTab).toBe('dictionary')
    expect(activeRoute(state)).toEqual({ name: 'dictionary', mode: 'vocabulary' })
    expect(state.stacks.library.at(-1)?.name).toBe('article')
  })

  it('persists safe routes, scroll and drafts while dropping active answer UI', () => {
    let state = createDefaultMobileShellState()
    state = replaceTabRoot(state, 'dictionary', { name: 'dictionary', mode: 'vocabulary' })
    state = setMobileDictionarySearchQuery(state, {
      text: 'futile', tags: ['cet4'], tagMatch: 'all', oxfordOnly: true, collinsMin: 3,
      bncMax: 2_000, contemporaryMax: 3_000, sort: 'frequency', offset: 30, limit: 30,
    })
    state = setMobileVocabularyListQuery(state, { text: '语境', offset: 50, limit: 50 })
    state = setMobileScroll(state, 'dictionary:vocabulary', 428.5)
    state = pushMobileRoute(state, { name: 'study-session' })

    const restored = parseMobileShellState(serializeMobileShellState(state))
    expect(restored.version).toBe(MOBILE_SHELL_VERSION)
    expect(restored.stacks.study).toEqual([{ name: 'study' }])
    expect(restored.stacks.dictionary).toEqual([{ name: 'dictionary', mode: 'vocabulary' }])
    expect(restored.scrollPositions['dictionary:vocabulary']).toBe(428.5)
    expect(restored.drafts).toEqual({ dictionaryQuery: 'futile', vocabularyQuery: '语境' })
    expect(mobileDictionarySearchQuery(restored)).toMatchObject({
      text: 'futile', tags: ['cet4'], tagMatch: 'all', oxfordOnly: true, collinsMin: 3,
      bncMax: 2_000, contemporaryMax: 3_000, sort: 'frequency', offset: 30, limit: 30,
    })
    expect(mobileVocabularyListQuery(restored)).toEqual({ text: '语境', offset: 50, limit: 50 })
  })

  it('keeps dictionary modes independent and resets only the edited mode pagination', () => {
    let state = createDefaultMobileShellState()
    state = setMobileDictionarySearchQuery(state, {
      text: 'first', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
      bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 30, limit: 30,
    })
    state = setMobileVocabularyListQuery(state, { text: 'saved', offset: 50, limit: 50 })
    state = setMobileDraft(state, 'dictionaryQuery', 'second')

    expect(mobileDictionarySearchQuery(state)).toMatchObject({ text: 'second', offset: 0 })
    expect(mobileVocabularyListQuery(state)).toEqual({ text: 'saved', offset: 50, limit: 50 })
  })

  it('drops data-backed deep routes after an incoming merge while keeping settings open', () => {
    let state = createDefaultMobileShellState()
    state = pushMobileRoute(state, { name: 'article', publicationId: 'publication-1', articleId: 'article-1' })
    state = replaceTabRoot(state, 'dictionary', { name: 'dictionary', mode: 'vocabulary' })
    state = pushMobileRoute(state, { name: 'lexeme', lexemeKey: 'lexeme-1', hostTab: 'dictionary' })
    state = pushMobileRoute(state, { name: 'study-plan', planId: 'plan-1' })
    state = pushMobileRoute(state, { name: 'settings-section', section: 'sync' })
    state = setMobileScroll(state, 'article:publication-1:article-1', 120)
    state = setMobileScroll(state, 'lexeme:dictionary:lexeme-1', 60)
    state = setMobileScroll(state, 'study-plan:plan-1', 80)
    state = setMobileScroll(state, 'dictionary:vocabulary', 40)

    const reconciled = reconcileMobileRoutesAfterDataMerge(state)
    expect(activeRoute(reconciled)).toEqual({ name: 'settings-section', section: 'sync' })
    expect(reconciled.stacks.library).toEqual([{ name: 'library' }])
    expect(reconciled.stacks.dictionary).toEqual([{ name: 'dictionary', mode: 'vocabulary' }])
    expect(reconciled.stacks.study).toEqual([{ name: 'study' }])
    expect(reconciled.scrollPositions).toEqual({ 'dictionary:vocabulary': 40 })
  })

  it('rejects corrupt, unknown and unsafe persisted state', () => {
    expect(parseMobileShellState('{bad json')).toEqual(createDefaultMobileShellState())
    expect(parseMobileShellState(JSON.stringify({ version: 99 }))).toEqual(createDefaultMobileShellState())

    const unsafeValue = {
      ...createDefaultMobileShellState(),
      activeTab: 'library',
      stacks: {
        library: [{ name: 'library' }, { name: 'article', publicationId: 'ok', articleId: '\u0000bad' }],
        dictionary: [{ name: 'dictionary', mode: 'search' }, { name: 'lexeme', lexemeKey: 'lex_en_alpha', hostTab: 'dictionary' }],
        study: [{ name: 'study' }, { name: 'study-session' }],
        settings: [{ name: 'settings' }],
      },
      scrollPositions: { library: -4, safe: 16 },
      drafts: { libraryQuery: 'ignored legacy field', dictionaryQuery: 'x'.repeat(800), vocabularyQuery: 42 },
    }
    const restored = parseMobileShellState(JSON.stringify(unsafeValue))
    expect(restored.version).toBe(MOBILE_SHELL_VERSION)
    expect(restored.stacks.library).toEqual([{ name: 'library' }])
    expect(restored.stacks.dictionary.at(-1)).toEqual({ name: 'lexeme', lexemeKey: 'lex_en_alpha', hostTab: 'dictionary' })
    expect(restored.stacks.study).toEqual([{ name: 'study' }])
    expect(restored.scrollPositions).toEqual({ safe: 16 })
    expect(restored.drafts.dictionaryQuery).toHaveLength(500)
    expect(restored.drafts.vocabularyQuery).toBe('')
    expect(restored.dictionaryBrowse).toEqual(createDefaultMobileShellState().dictionaryBrowse)
  })

  it('restores public settings sections but never persists the session-only developer route', () => {
    const sections = ['appearance', 'translation', 'dictionary', 'speech', 'study', 'data'] as const
    for (const section of sections) {
      const restored = parseMobileShellState(JSON.stringify({
        ...createDefaultMobileShellState(),
        activeTab: 'settings',
        stacks: { ...createDefaultMobileShellState().stacks, settings: [{ name: 'settings' }, { name: 'settings-section', section }] },
      }))
      expect(restored.stacks.settings.at(-1)).toEqual({ name: 'settings-section', section })
    }

    let developer = createDefaultMobileShellState()
    developer = pushMobileRoute(developer, { name: 'settings-section', section: 'developer' })
    expect(parseMobileShellState(serializeMobileShellState(developer)).stacks.settings).toEqual([{ name: 'settings' }])
  })

  it('drops an unknown settings section back to the valid settings root', () => {
    const restored = parseMobileShellState(JSON.stringify({
      ...createDefaultMobileShellState(),
      activeTab: 'settings',
      stacks: { ...createDefaultMobileShellState().stacks, settings: [{ name: 'settings' }, { name: 'settings-section', section: 'future' }] },
    }))
    expect(restored.stacks.settings).toEqual([{ name: 'settings' }])
  })

  it('marks only article and answer routes as immersive', () => {
    expect(isImmersiveRoute({ name: 'article', publicationId: 'p', articleId: 'a' })).toBe(true)
    expect(isImmersiveRoute({ name: 'study-session' })).toBe(true)
    expect(isImmersiveRoute({ name: 'lexeme', lexemeKey: 'en:test', hostTab: 'dictionary' })).toBe(false)
  })
})
