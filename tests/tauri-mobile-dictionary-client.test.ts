import { describe, expect, it, vi } from 'vitest'
import { TauriMobileDictionaryClient, TauriMobileStudyClient } from '../src/renderer/tauri/mobile-learning-client'

describe('TauriMobileDictionaryClient', () => {
  it('uses only the fixed D1 dictionary commands and logical DTOs', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000501' })
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const client = new TauriMobileDictionaryClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'get_mobile_dictionary_status' || command === 'install_mobile_dictionary_online') {
        return { installed: true, profile: 'standard-v1', datasetRevision: 'fixture', entryCount: 3, formCount: 4, lexemeMapHash: 'a'.repeat(64) } as T
      }
      if (command === 'lookup_mobile_dictionary') return { found: false, candidates: [] } as T
      if (command === 'search_mobile_dictionary') return { items: [], total: 0, offset: 0, limit: 20 } as T
      return undefined as T
    })
    await client.getDictionaryPackStatus()
    await client.installBasePackOnline()
    await client.lookupInContext({ articleId: 'article', blockId: 'block', surface: 'running', tokenIndex: 0 })
    await client.searchDictionary({ text: 'run', offset: 0, limit: 20 })
    expect(calls.map((call) => call.command)).toEqual([
      'get_mobile_dictionary_status',
      'install_mobile_dictionary_online',
      'lookup_mobile_dictionary',
      'search_mobile_dictionary',
    ])
    expect(JSON.stringify(calls)).not.toMatch(/(?:sql|filePath|databasePath|https?:\/\/)/i)
    vi.unstubAllGlobals()
  })

  it('uses fixed D2 vocabulary commands without exposing storage details', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const client = new TauriMobileDictionaryClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'list_mobile_vocabulary_favorites') return { items: [], total: 0, offset: 0, limit: 50 } as T
      if (command === 'list_mobile_saved_contexts') return { items: [], total: 0, offset: 0, limit: 50 } as T
      return { lexemeKey: 'lex_en_fixture', favorite: true, contextSaved: true, manualState: 'unrated' } as T
    })
    const request = { articleId: 'article', blockId: 'block', surface: 'running', tokenIndex: 0 }
    await client.getReaderState(request, 'lex_en_fixture')
    await client.setFavorite(request, 'lex_en_fixture', true)
    await client.setContextSaved(request, 'lex_en_fixture', true)
    await client.listFavorites({ text: '', offset: 0, limit: 50 })
    await client.listContexts('lex_en_fixture')
    await client.removeFavorite('lex_en_fixture')
    expect(calls.map((call) => call.command)).toEqual([
      'get_mobile_reader_vocabulary_state', 'set_mobile_vocabulary_favorite',
      'set_mobile_context_saved', 'list_mobile_vocabulary_favorites',
      'list_mobile_saved_contexts', 'remove_mobile_vocabulary_favorite',
    ])
    expect(JSON.stringify(calls)).not.toMatch(/(?:sql|filePath|databasePath|https?:\/\/)/i)
  })

  it('routes the additive E2 dictionary center through fixed logical commands', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000502' })
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const preferences = {
      enabled: true,
      lookupProviderId: 'ecdict' as const,
      fallbackToLocal: true,
      contextExplanationEnabled: false,
      translateExamples: false,
    }
    const client = new TauriMobileDictionaryClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'preflight_mobile_dictionary_install') {
        return { profile: 'full', requiredBytes: 400, availableBytes: 800, canInstall: true } as T
      }
      if (command === 'get_mobile_dictionary_preferences' || command === 'save_mobile_dictionary_preferences') return preferences as T
      if (command === 'search_mobile_dictionary') return { items: [], total: 0, offset: 0, limit: 30 } as T
      if (command === 'lookup_mobile_dictionary') return { found: false, candidates: [] } as T
      return undefined as T
    })
    const lookup = { articleId: 'article', blockId: 'block', surface: 'running', tokenIndex: 0 }
    const query = {
      text: 'run', tags: ['cet4', 'ky'], tagMatch: 'all' as const, oxfordOnly: true,
      collinsMin: 3, bncMax: 2_000, contemporaryMax: 3_000,
      sort: 'frequency' as const, offset: 30, limit: 30,
    }

    await client.preflightInstall('full')
    await client.lookup(lookup)
    await client.search(query)
    await client.getLexemeSource('lex_en_run')
    await client.listCollections()
    await client.getPreferences()
    await client.savePreferences(preferences)
    await client.repair('full')
    await client.removeFullExtension()

    expect(calls.map((call) => call.command)).toEqual([
      'preflight_mobile_dictionary_install',
      'lookup_mobile_dictionary',
      'search_mobile_dictionary',
      'get_mobile_lexeme_source',
      'list_mobile_dictionary_collections',
      'get_mobile_dictionary_preferences',
      'save_mobile_dictionary_preferences',
      'repair_mobile_dictionary',
      'remove_mobile_dictionary_full_extension',
    ])
    expect(calls.find((call) => call.command === 'search_mobile_dictionary')?.args?.query).toEqual(query)
    expect(JSON.stringify(calls)).not.toMatch(/(?:sql|filePath|databasePath|https?:\/\/|apiKey|secretKey)/i)
    vi.unstubAllGlobals()
  })
})

describe('TauriMobileStudyClient', () => {
  it('routes E3 management operations without exposing destructive developer commands', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const client = new TauriMobileStudyClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      return undefined as T
    })
    const input = { name: '考研', dailyNewLimit: 5, dailyReviewLimit: 10, sources: [{ type: 'reader_manual' as const, ref: 'favorite' }] }
    const wordQuery = { text: 'run', filter: 'due' as const, offset: 0, limit: 30 }
    const todayQuery = { filter: 'unknown' as const, offset: 0, limit: 50 }
    const preferences = { cutoffHour: 4, requestRetention: 0.9, maximumInterval: 36500, queueOrder: 'mixed' as const }

    await client.getDashboard()
    await client.listPlans(true)
    await client.createPlan(input)
    await client.updatePlan('plan-1', input)
    await client.setPlanStatus('plan-1', 'paused')
    await client.getPlan('plan-1')
    await client.listPlanWords('plan-1', wordQuery)
    await client.setWordExcluded('plan-1', 'lex_en_run', true)
    await client.setWordSuspended('lex_en_run', true)
    await client.listTodayWords('session-1', todayQuery)
    await client.markTooEasy({
      sessionId: 'session-1', itemId: 'item-1', expectedVersion: 2,
      commandId: '11111111-1111-4111-8111-111111111111',
    })
    await client.syncSources('plan-1')
    await client.getPreferences()
    await client.savePreferences(preferences)
    await client.listDictionaryCollections()

    expect(calls.map((call) => call.command)).toEqual([
      'get_mobile_study_dashboard', 'list_mobile_study_plans', 'create_mobile_study_plan',
      'update_mobile_study_plan', 'set_mobile_study_plan_status', 'get_mobile_study_plan',
      'list_mobile_study_plan_words', 'set_mobile_study_word_excluded', 'set_mobile_study_word_suspended',
      'list_mobile_study_today_words', 'mark_mobile_study_too_easy', 'sync_mobile_study_sources',
      'get_mobile_study_preferences', 'save_mobile_study_preferences', 'list_mobile_dictionary_collections',
    ])
    expect(JSON.stringify(calls)).not.toMatch(/(?:delete|reset|debug|sql|filePath|databasePath|https?:\/\/)/i)
  })

  it('uses queue and review proposal v2 for regular and extra batches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T02:00:00.000Z'))
    vi.stubGlobal('crypto', { randomUUID: () => '22222222-2222-4222-8222-222222222222' })
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const preferences = { cutoffHour: 4, requestRetention: 0.9, maximumInterval: 36500, queueOrder: 'mixed' as const }
    const session = { sessionId: 'session', logicalDate: '2026-07-12', status: 'active', current: null, completed: 0, total: 0, remaining: 0, extraBatchCount: 0 }
    const client = new TauriMobileStudyClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'get_mobile_study_preferences') return preferences as T
      if (command === 'prepare_mobile_today_v2') return {
        order: 'mixed', stateFingerprint: 'state-1',
        quotas: [{ planId: 'plan-a', dailyNewLimit: 1, dailyReviewLimit: 1 }],
        candidates: [
          { lexemeKey: 'review-a', planId: 'plan-a', kind: 'review', dueAt: '2026-07-11T00:00:00.000Z', rank: null },
          { lexemeKey: 'new-a', planId: 'plan-a', kind: 'new', dueAt: null, rank: 100 },
        ],
      } as T
      if (command === 'prepare_mobile_study_extra_batch') return {
        seed: 'session:extra:1', order: 'mixed', stateFingerprint: 'state-extra-1',
        quotas: [{ planId: 'plan-a', dailyNewLimit: 1, dailyReviewLimit: 1 }],
        candidates: [
          { lexemeKey: 'review-extra', planId: 'plan-a', kind: 'review', dueAt: '2026-07-11T00:00:00.000Z', rank: null },
          { lexemeKey: 'new-extra', planId: 'plan-a', kind: 'new', dueAt: null, rank: 200 },
        ],
      } as T
      if (command === 'get_mobile_review_transition_input') return { stored: null, preferences, fsrsCommitted: false } as T
      return session as T
    })

    await client.openToday()
    await client.commitAnswer({
      sessionId: 'session', itemId: 'item', expectedVersion: 2,
      commandId: '22222222-2222-4222-8222-222222222222', answer: 'unknown',
    })
    await client.addExtraBatch('plan-a')

    const open = calls.find((call) => call.command === 'open_mobile_today_v2')?.args
    const commit = calls.find((call) => call.command === 'commit_mobile_study_answer_v2')?.args
    const extra = calls.find((call) => call.command === 'add_mobile_study_extra_batch')?.args
    expect(open?.proposal).toMatchObject({
      contractVersion: 2, engineVersion: 'learning-queue-v2', seed: '2026-07-12:regular', stateFingerprint: 'state-1',
      selected: expect.arrayContaining([
        { lexemeKey: 'review-a', planId: 'plan-a', kind: 'review' },
        { lexemeKey: 'new-a', planId: 'plan-a', kind: 'new' },
      ]),
    })
    expect(commit?.proposal).toMatchObject({
      contractVersion: 2, engineVersion: 'fsrs-6/ts-fsrs-5.4.1/mobile-v2',
      commandId: '22222222-2222-4222-8222-222222222222',
      parameters: { request_retention: 0.9, maximum_interval: 36500 },
    })
    expect(extra?.proposal).toMatchObject({
      contractVersion: 2, engineVersion: 'learning-queue-v2', seed: 'session:extra:1', stateFingerprint: 'state-extra-1',
      selected: expect.arrayContaining([
        { lexemeKey: 'review-extra', planId: 'plan-a', kind: 'review' },
        { lexemeKey: 'new-extra', planId: 'plan-a', kind: 'new' },
      ]),
    })
    expect(calls.map((call) => call.command)).toContain('prepare_mobile_today_v2')
    expect(calls.map((call) => call.command)).not.toContain('prepare_mobile_today')
    expect(JSON.stringify(calls)).not.toMatch(/(?:sql|filePath|databasePath|https?:\/\/)/i)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
