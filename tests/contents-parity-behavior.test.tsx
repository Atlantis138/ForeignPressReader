// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppClient } from '../src/core/app-client'
import type { PublicationDetail, TranslationApi, TranslationSettings } from '../src/shared/types'
import { PublicationView } from '../src/renderer/reader/PublicationView'
import { MobilePublication } from '../src/renderer/tauri/mobile-reader-pages'
import { MobileSettingsSectionPage } from '../src/renderer/tauri/mobile-settings-pages'
import type { MobileAppClient } from '../src/renderer/tauri/mobile-app-client'

afterEach(cleanup)
const publication = { id: 'publication_123', title: 'Weekly', articleCount: 1, sections: [{
  id: 'section_123', title: 'World', articles: [{ id: 'article_123', title: 'Headline', rubric: 'Summary' }],
}], unsectionedArticles: [] } as unknown as PublicationDetail

describe.each(['desktop', 'android'])('%s contents parity', platform => {
  it('restores cached translations before scroll, preserves visibility, resumes and forces refresh', async () => {
    let restore!: (value: Record<string, string>) => void
    const snapshot = { scrollTop: 640, showTranslation: true }
    const onError = vi.fn()
    const translated = { section_123: '世界', article_123: '标题', 'article_123:rubric': '摘要' }
    const client = {
      getContents: vi.fn(() => new Promise<Record<string, string>>(resolve => { restore = resolve })),
      translateContents: vi.fn(async () => translated), cancelContents: vi.fn(async () => undefined),
      onProgress: () => () => undefined,
    } as unknown as TranslationApi
    const component = platform === 'desktop'
      ? <PublicationView id={publication.id} client={{ library: { getPublication: async () => publication }, translation: client } as AppClient}
          snapshot={snapshot} onError={onError} onBack={vi.fn()} onOpenArticle={vi.fn()} />
      : <MobilePublication publication={publication} client={client as MobileAppClient['translation']}
          snapshot={snapshot} onError={onError} onBack={vi.fn()} onOpen={vi.fn()} />
    const view = render(<main className="main-content mobile-scroll">{component}</main>)
    await act(async () => restore({ section_123: '世界' }))
    expect(screen.getByText('世界')).toBeTruthy()
    expect(view.container.querySelector('main')!.scrollTop).toBe(640)
    fireEvent.click(screen.getByRole('button', { name: '继续翻译目录' }))
    expect(await screen.findByText('摘要')).toBeTruthy()
    expect(client.translateContents).toHaveBeenCalledWith(publication.id, false)
    fireEvent.click(screen.getByRole('button', { name: '重新翻译目录' }))
    await waitFor(() => expect(client.translateContents).toHaveBeenCalledWith(publication.id, true))
    fireEvent.click(screen.getByRole('button', { name: '隐藏目录译文' }))
    expect(snapshot.showTranslation).toBe(false)
    expect(screen.queryByText('摘要')).toBeNull()
    view.container.querySelector('main')!.scrollTop = 810
    view.unmount()
    expect(snapshot.scrollTop).toBe(810)
    expect(onError).not.toHaveBeenCalled()
  })
})

it('Android saves and deletes provider-scoped custom models and tests the form selection', async () => {
  const settings: TranslationSettings = { preferences: { providerId: 'openai', modelId: 'builtin' }, providers: [{
    id: 'openai', name: 'OpenAI', keyStatus: { configured: true, masked: '••••' }, models: [
      { id: 'builtin', name: 'Built in', description: '' }, { id: 'custom/model:1', name: 'Custom', description: '', custom: true },
    ],
  }] }
  const client = { getSettings: vi.fn(async () => settings),
    savePreferences: vi.fn(async (preferences) => { settings.preferences = preferences; return settings }),
    deleteModel: vi.fn(async () => { settings.preferences = { providerId: 'openai', modelId: 'builtin' }; return settings }),
    testConnection: vi.fn(async () => ({ ok: true, message: '成功' })),
  }
  render(<MobileSettingsSectionPage clients={{ settings: { translation: client } } as unknown as MobileAppClient}
    section="translation" preferences={{ theme: 'light', fontSize: 20, lineHeight: 1.8, columnWidth: 760, paperTint: 58 }}
    onBack={vi.fn()} onOpen={vi.fn()} onChange={vi.fn()} onDataChanged={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} onTask={vi.fn()} />)
  fireEvent.change(await screen.findByLabelText('模型 ID'), { target: { value: 'custom/model:1' } })
  fireEvent.click(screen.getByRole('button', { name: '测试所选模型' }))
  await waitFor(() => expect(client.testConnection).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'custom/model:1' }))
  await waitFor(() => expect((screen.getByLabelText('模型 ID') as HTMLInputElement).disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'custom/model:1' } })
  fireEvent.click(screen.getByRole('button', { name: '保存模型选择' }))
  await waitFor(() => expect(client.savePreferences).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'custom/model:1' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '删除自定义模型' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '删除自定义模型' }))
  await waitFor(() => expect(client.deleteModel).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'custom/model:1' }))
})
