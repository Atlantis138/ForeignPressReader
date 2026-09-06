// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileTodayWords, MobileStudySession, MobileStudySettings, type MobileStudyUiClient } from '../src/renderer/tauri/mobile-study-pages'
import type { StudyTodayWordPage, StudySessionState } from '../src/shared/types'

afterEach(cleanup)
function page(lemma: string, offset = 0): StudyTodayWordPage {
  return { offset, limit: 100, total: 201, items: [{ itemId: lemma, lexemeKey: lemma,
    lemma, meanings: [], examples: [], context: null, firstAnswer: null, finalAnswer: null,
    attemptCount: 0, unknownCount: 0 }] } as StudyTodayWordPage
}
function show(listTodayWords: MobileStudyUiClient['listTodayWords']) {
  render(createElement(MobileTodayWords, { client: { listTodayWords } as MobileStudyUiClient,
    sessionId: 'session', onBack: vi.fn(), onLexeme: vi.fn(), onError: vi.fn() }))
}

it('offers retry after failure and reaches words beyond the first hundred', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValueOnce(page('first')).mockResolvedValueOnce(page('later', 100))
  show(load)
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  await screen.findByText('first')
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('later')
  expect(load).toHaveBeenLastCalledWith('session', { filter: 'all', offset: 100, limit: 100 })
})

it('ignores an older filter response after a newer selection has loaded', async () => {
  let finish!: (value: StudyTodayWordPage) => void
  const load = vi.fn().mockImplementationOnce(() => new Promise<StudyTodayWordPage>(resolve => { finish = resolve }))
    .mockResolvedValueOnce(page('new-filter'))
  show(load)
  fireEvent.click(screen.getByRole('button', { name: '新词' }))
  await screen.findByText('new-filter')
  await act(async () => finish(page('obsolete-filter')))
  await waitFor(() => expect(screen.queryByText('obsolete-filter')).toBeNull())
  expect(screen.getByText('new-filter')).toBeTruthy()
})

it.each([false, true])('keeps undo for the last card only after a successful suspension (failure=%s)', async failure => {
  const initial = { sessionId: 'session', status: 'active', total: 1, completed: 0, logicalDate: '2026-09-06',
    current: { itemId: 'item', lexemeKey: 'word', lemma: 'word', kind: 'new', version: 1,
      canMarkTooEasy: true, revealed: false, examples: [] } } as unknown as StudySessionState
  const client = { markTooEasy: failure ? vi.fn().mockRejectedValue(new Error('save failed'))
    : vi.fn().mockResolvedValue({ ...initial, status: 'completed', completed: 1, current: null }),
    setWordSuspended: vi.fn().mockResolvedValue(undefined) } as unknown as MobileStudyUiClient
  const speech = { getSettings: vi.fn().mockResolvedValue({ preferences: { autoPlayStudy: false } }), stop: vi.fn().mockResolvedValue(undefined) }
  const onError = vi.fn()
  function Session() {
    const [session, setSession] = useState(initial)
    return createElement(MobileStudySession, { client, speech: speech as never, session, onSession: setSession,
      onBack: vi.fn(), onOpenLexeme: vi.fn(), onError, onNotice: vi.fn() })
  }
  render(createElement(Session))
  fireEvent.click(screen.getByRole('button', { name: '太简单，暂停复习' }))
  if (failure) {
    await waitFor(() => expect(onError).toHaveBeenCalledWith('save failed'))
    expect(screen.queryByRole('button', { name: '撤销太简单' })).toBeNull()
  } else {
    const undo = await screen.findByRole('button', { name: '撤销太简单' })
    expect(screen.getByText('今日完成')).toBeTruthy()
    fireEvent.click(undo)
    await waitFor(() => expect(client.setWordSuspended).toHaveBeenCalledWith('word', false))
  }
})

it('retries loading study preferences and saves an edited queue order', async () => {
  const preferences = { queueOrder: 'mixed', cutoffHour: 4, requestRetention: 0.9, maximumInterval: 36500 }
  const client = { getPreferences: vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(preferences),
    savePreferences: vi.fn(async value => value) } as unknown as MobileStudyUiClient
  render(createElement(MobileStudySettings, { client, onError: vi.fn(), onNotice: vi.fn() }))
  fireEvent.click(await screen.findByRole('button', { name: '重试' }))
  fireEvent.click(await screen.findByRole('tab', { name: '新词优先' }))
  fireEvent.click(screen.getByRole('button', { name: '保存学习设置' }))
  await waitFor(() => expect(client.savePreferences).toHaveBeenCalledWith({ ...preferences, queueOrder: 'new_first' }))
})
