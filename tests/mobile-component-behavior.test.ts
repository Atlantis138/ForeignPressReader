// @vitest-environment jsdom

import { createElement, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DictionarySearchPage,
  PortableImportPreview,
  StorageReport,
  StudySessionState,
  SyncApi,
  SyncPageState,
} from '../src/shared/types'
import type { MobileSpeechClient } from '../src/shared/mobile-online-services'
import {
  MobileDictionaryHome,
  MobileLexemePage,
  type MobileDictionaryUiClient,
} from '../src/renderer/tauri/mobile-dictionary-pages'
import {
  MobileStudySession,
  type MobileStudyUiClient,
} from '../src/renderer/tauri/mobile-study-pages'
import { MobileDataSettings } from '../src/renderer/tauri/mobile-app'
import type { MobileAppClient } from '../src/renderer/tauri/mobile-app-client'
import { SyncSettingsPanel } from '../src/renderer/sync-settings'
import type { MobileTask } from '../src/renderer/tauri/mobile-ui'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('mobile component behavior with injected clients', () => {
  it('keeps only the latest dictionary search result', async () => {
    const oldSearch = deferred<DictionarySearchPage>()
    const newSearch = deferred<DictionarySearchPage>()
    const search = vi.fn((query: { text: string }) => query.text === 'old' ? oldSearch.promise : newSearch.promise)
    const client = {
      getStatus: vi.fn(async () => ({ baseInstalled: true })),
      listCollections: vi.fn(async () => []),
      search,
    } as unknown as MobileDictionaryUiClient

    function Harness() {
      const [text, setText] = useState('')
      return createElement(MobileDictionaryHome, {
        client,
        mode: 'search',
        dictionaryText: text,
        vocabularyText: '',
        onMode: vi.fn(),
        onDictionaryText: setText,
        onVocabularyText: vi.fn(),
        onLexeme: vi.fn(),
        onArticle: vi.fn(),
        onOpenSettings: vi.fn(),
        onError: vi.fn(),
      })
    }

    render(createElement(Harness))
    const input = await screen.findByPlaceholderText('输入英文单词或中文释义')
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: 'old' })))
    fireEvent.change(input, { target: { value: 'new' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: 'new' })))

    await act(async () => newSearch.resolve(searchPage('new-result')))
    expect(await screen.findByText('new-result')).toBeTruthy()
    await act(async () => oldSearch.resolve(searchPage('old-result')))
    expect(screen.queryByText('old-result')).toBeNull()
    expect(screen.getByText('new-result')).toBeTruthy()
  })

  it('renders a saved lexeme snapshot and its retained article context without a dictionary pack', async () => {
    const onArticle = vi.fn()
    const client = {
      getLexemeSource: vi.fn(async () => ({
        source: 'snapshot', detail: null, localProfile: 'none', favorite: true, manualState: 'learning',
        snapshot: {
          lexemeKey: 'snapshot-word', lemma: 'resilient', phonetic: 'rɪˈzɪliənt',
          briefMeanings: ['有韧性的'],
          senseGroups: [{ partOfSpeech: 'adjective', translations: ['能迅速恢复的'], definitions: [] }],
          frequency: { bnc: 2048, contemporary: null }, providerId: 'ecdict',
        },
      })),
      listContexts: vi.fn(async () => ({
        items: [{
          contextId: 'context-1', publicationId: 'publication-1', publicationTitle: 'Weekly',
          articleId: 'article-1', articleTitle: 'A retained article',
          sentence: 'A resilient system recovers cleanly.', surface: 'resilient',
          paragraph: 'A resilient system recovers cleanly.', savedAt: '2026-07-15T00:00:00.000Z',
        }],
        offset: 0, limit: 50, total: 1,
      })),
    } as unknown as MobileDictionaryUiClient

    render(createElement(MobileLexemePage, {
      client,
      speech: { stop: vi.fn() } as unknown as MobileSpeechClient,
      lexemeKey: 'snapshot-word',
      onBack: vi.fn(),
      onArticle,
      onError: vi.fn(),
    }))

    expect(await screen.findByText('正在显示收藏快照')).toBeTruthy()
    expect(screen.getByText('能迅速恢复的')).toBeTruthy()
    expect(await screen.findByText('A resilient system recovers cleanly.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回到原刊文章' }))
    expect(onArticle).toHaveBeenCalledWith('publication-1', 'article-1')
  })

  it('keeps study answer staging separate from final commit', async () => {
    const initial = studySession(false, null, 1)
    const revealed = studySession(true, 'known', 2)
    const completed = { ...revealed, status: 'completed' as const, current: null, completed: 1, remaining: 0 }
    const stageAnswer = vi.fn(async () => revealed)
    const commitAnswer = vi.fn(async () => completed)
    const client = {
      stageAnswer,
      commitAnswer,
      hydrateCurrentExamples: vi.fn(async () => []),
    } as unknown as MobileStudyUiClient
    const speech = { stop: vi.fn(async () => undefined) } as unknown as MobileSpeechClient

    function Harness() {
      const [session, setSession] = useState(initial)
      return createElement(MobileStudySession, {
        client,
        speech,
        session,
        onSession: setSession,
        onBack: vi.fn(),
        onOpenLexeme: vi.fn(),
        onError: vi.fn(),
        onNotice: vi.fn(),
      })
    }

    render(createElement(Harness))
    fireEvent.click(screen.getByRole('button', { name: '认识' }))
    await screen.findByRole('button', { name: '确认认识' })
    expect(stageAnswer).toHaveBeenCalledWith({
      sessionId: 'session-1', itemId: 'item-1', expectedVersion: 1, answer: 'known',
    })
    expect(commitAnswer).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认认识' }))
    expect(await screen.findByText('今日完成')).toBeTruthy()
    expect(commitAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', itemId: 'item-1', expectedVersion: 2, answer: 'known',
    }))
  })

  it('handles portable preview cancel, confirm, progress cancellation, and errors', async () => {
    const preview = portablePreview()
    const selectPortableImport = vi.fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error('backup failed'))
    const confirmPortableImport = vi.fn(async () => ({
      fileName: 'portable.fprbackup', bytes: 50, importedPublications: 1, mergedVocabulary: 2,
    }))
    const discardPortableImport = vi.fn(async () => undefined)
    const cancelTransfer = vi.fn(async () => undefined)
    let progress: ((value: { operation: 'import'; stage: 'validating'; completedBytes: number; totalBytes: number; message: string }) => void) | undefined
    const data = {
      selectPortableImport,
      confirmPortableImport,
      cancelTransfer,
      exportPortable: vi.fn(async () => null),
      onProgress: vi.fn((callback) => { progress = callback; return vi.fn() }),
    }
    const report: StorageReport = {
      scannedAt: '2026-07-15T00:00:00.000Z', totalBytes: 0, packaged: false, categories: [],
    }
    const clients = {
      data,
      storage: {
        scan: vi.fn(async () => report), clearSafeCache: vi.fn(), clearAiTextCache: vi.fn(),
      },
      platform: {
        appInfo: { getInfo: vi.fn(async () => ({ appVersion: 'test' })) },
        data: { discardPortableImport },
        storage: { openAppStorageSettings: vi.fn() },
      },
    } as unknown as Pick<MobileAppClient, 'data' | 'storage' | 'platform'>
    const onError = vi.fn()
    const onNotice = vi.fn()
    const onTask = vi.fn<(task: MobileTask | null) => void>()

    render(createElement(MobileDataSettings, {
      clients, onOpenSync: vi.fn(), onError, onNotice, onTask,
    }))
    await screen.findByText('总占用')
    act(() => progress?.({ operation: 'import', stage: 'validating', completedBytes: 5, totalBytes: 10, message: 'validating' }))
    const task = onTask.mock.calls.at(-1)?.[0]
    expect(task?.progress).toBe(0.5)
    await act(async () => task?.onCancel?.())
    expect(cancelTransfer).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '导入便携备份' }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(discardPortableImport).toHaveBeenCalledWith('portable-token'))

    fireEvent.click(screen.getByRole('button', { name: '导入便携备份' }))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: '合并并恢复' }))
    await waitFor(() => expect(confirmPortableImport).toHaveBeenCalledWith('portable-token'))

    fireEvent.click(screen.getByRole('button', { name: '导入便携备份' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('backup failed'))
  })

  it('shows sync progress, cancels an operation, and allows retry', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const uploading = syncState('uploading')
    const cancelled = syncState('cancelled')
    const completed = syncState('completed')
    const api = {
      openPage: vi.fn(async () => uploading),
      closePage: vi.fn(async () => undefined),
      getState: vi.fn(async () => uploading),
      refreshDiscovery: vi.fn(async () => uploading),
      cancelOperation: vi.fn(async () => cancelled),
      sendTo: vi.fn(async () => completed),
      startPairing: vi.fn(), confirmPairing: vi.fn(), rejectPairing: vi.fn(),
      acceptIncoming: vi.fn(), rejectIncoming: vi.fn(), revokeTrust: vi.fn(),
      discardPendingTransfer: vi.fn(),
    } as unknown as SyncApi

    const view = render(createElement(SyncSettingsPanel, { api, onError: vi.fn(), compact: true }))
    expect(await screen.findByText('传输内容')).toBeTruthy()
    const progressBar = screen.getByRole('progressbar') as HTMLProgressElement
    expect(progressBar.value).toBe(50)
    fireEvent.click(screen.getByRole('button', { name: '取消同步' }))
    expect(await screen.findByText('已取消')).toBeTruthy()
    expect(api.cancelOperation).toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: '同步到此设备' })[0])
    await waitFor(() => expect(api.sendTo).toHaveBeenCalledWith('peer-1'))
    expect(await screen.findByText('完成')).toBeTruthy()
    view.unmount()
    await waitFor(() => expect(api.closePage).toHaveBeenCalled())
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function searchPage(lemma: string): DictionarySearchPage {
  return {
    items: [{
      lexemeKey: `lex-${lemma}`, lemma, phonetic: null, briefMeanings: ['meaning'], tags: [],
      collins: null, oxford: false, frequency: { bnc: null, contemporary: null }, matchedBy: 'lemma',
    }],
    total: 1, offset: 0, limit: 30,
  }
}

function studySession(revealed: boolean, proposedAnswer: 'known' | 'unknown' | null, version: number): StudySessionState {
  return {
    sessionId: 'session-1', logicalDate: '2026-07-15', status: 'active', completed: 0, total: 1, remaining: 1, extraBatchCount: 0,
    current: {
      itemId: 'item-1', kind: 'review', version, lexemeKey: 'lex-one', lemma: 'durable', phonetic: null,
      senseGroups: [], briefMeanings: ['持久的'], context: null, examples: [], revealed, proposedAnswer,
      hadFailure: false, consecutiveKnown: 0, attemptCount: 0, canMarkTooEasy: false,
    },
  }
}

function portablePreview(): PortableImportPreview {
  return {
    token: 'portable-token', fileName: 'portable.fprbackup', totalBytes: 50,
    publicationCount: 1, newPublicationCount: 1, duplicatePublicationCount: 0,
    settingCount: 1, readingPositionCount: 1, vocabularyCount: 2, vocabularySourceCount: 2,
    savedContextCount: 1, studyPlanCount: 1, reviewCardCount: 1, reviewEventCount: 1,
    reinforcementEventCount: 0, suspendedWordCount: 0, createdAt: '2026-07-15T00:00:00.000Z',
  }
}

function syncState(stage: NonNullable<SyncPageState['operation']>['stage']): SyncPageState {
  const peer = {
    deviceId: 'peer-1', name: 'Windows', platform: 'windows' as const, trusted: true, online: true,
    reachability: 'online' as const, diagnostic: null,
    lastSeenAt: '2026-07-15T00:00:00.000Z', certificateSha256: 'a'.repeat(64),
  }
  return {
    active: true, localDevice: { ...peer, deviceId: 'local', name: 'Android', platform: 'android' },
    nearbyDevices: [peer], trustedDevices: [peer], pairing: null, incoming: null,
    operation: {
      operationId: 'operation-1', direction: 'sending', peer, stage,
      message: stage, completedBytes: 50, totalBytes: 100, resumable: false,
    },
    resumableTransfers: [], lastCompleted: null, diagnostic: null,
  }
}
