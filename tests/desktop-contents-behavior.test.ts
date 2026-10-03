// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicationView, type ContentsSnapshot } from '../src/renderer/reader/PublicationView'
import type { AppClient } from '../src/core/app-client'
import type { PublicationDetail } from '../src/shared/types'

afterEach(cleanup)

const detail = { id: 'publication_123', title: 'Weekly', articleCount: 1, sections: [{
  id: 'section_123', title: 'World', articles: [{ id: 'article_123', title: 'Headline', rubric: 'Summary' }],
}], unsectionedArticles: [] } as unknown as PublicationDetail

describe('desktop contents navigation', () => {
  it('restores the saved offset after asynchronous contents load, including visible translations', async () => {
    let complete!: (value: PublicationDetail) => void
    const snapshot: ContentsSnapshot = { scrollTop: 640, showTranslation: true }
    const client = { library: { getPublication: vi.fn(() => new Promise<PublicationDetail>(resolve => { complete = resolve })) },
      translation: { getContents: vi.fn(async () => ({ article_123: '标题译文' })), onProgress: () => () => undefined },
    } as unknown as AppClient
    const open = vi.fn()
    const view = render(createElement('main', { className: 'main-content' }, createElement(PublicationView, {
      id: detail.id, client, snapshot, onBack: vi.fn(), onOpenArticle: open, onError: vi.fn(),
    })))
    await act(async () => complete(detail))
    expect(screen.getByText('标题译文')).toBeTruthy()
    const main = view.container.querySelector<HTMLElement>('main')!
    expect(main.scrollTop).toBe(640)
    main.scrollTop = 820
    fireEvent.click(screen.getByRole('button', { name: /Headline/ }))
    expect(open).toHaveBeenCalledWith('article_123')
    view.unmount()
    expect(snapshot.scrollTop).toBe(820)
  })

  it('renders directory translation, keeps article IDs and recovers partial results after failure', async () => {
    const snapshot = { scrollTop: 0, showTranslation: true }
    const error = vi.fn()
    const translate = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce({
      section_123: '世界', article_123: '标题译文', 'article_123:rubric': '摘要译文',
    })
    const client = { library: { getPublication: async () => detail }, translation: {
      getContents: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ section_123: '世界' }),
      translateContents: translate, onProgress: () => () => undefined,
    } } as unknown as AppClient
    render(createElement(PublicationView, { id: detail.id, client, snapshot, onBack: vi.fn(), onOpenArticle: vi.fn(), onError: error }))
    fireEvent.click(await screen.findByRole('button', { name: '翻译目录' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('连接失败'))
    fireEvent.click(await screen.findByRole('button', { name: '继续翻译目录' }))
    expect(await screen.findByText('摘要译文')).toBeTruthy()
    expect(screen.getByText('Headline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '隐藏目录译文' }))
    expect(screen.queryByText('摘要译文')).toBeNull()
    expect(snapshot.showTranslation).toBe(false)
    expect(translate).toHaveBeenNthCalledWith(2, detail.id, false)
  })
})
