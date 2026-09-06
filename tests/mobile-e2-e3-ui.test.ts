import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readText = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Android E2 dictionary center', () => {
  it('integrates the extracted dictionary routes and source-tab aware lexeme deep links', async () => {
    const app = await readText('src/renderer/tauri/mobile-app.tsx')
    expect(app).toContain("from './mobile-dictionary-pages'")
    expect(app).toContain("route.name === 'dictionary' && <MobileDictionaryCenter")
    expect(app).toContain("route.name === 'lexeme' && <MobileLexemeCenter")
    expect(app).toContain("{ name: 'lexeme', lexemeKey, hostTab: 'dictionary' }")
    expect(app).toContain("{ name: 'lexeme', lexemeKey, hostTab: 'study' }")
  })

  it('keeps search responsive, latest-wins and feature-complete on mobile', async () => {
    const page = await readText('src/renderer/tauri/mobile-dictionary-pages.tsx')
    const search = page.slice(page.indexOf('function MobileDictionarySearch'), page.indexOf('function DictionaryResults'))
    const settings = page.slice(page.indexOf('export function MobileDictionarySettings'))
    expect(page).toContain('window.setTimeout(() => void runSearch(next), 180)')
    expect(page).toContain('current === sequence.current')
    expect(page).toContain('DictionaryFilterSheet')
    for (const field of ['query.tags', 'query.tagMatch', 'query.oxfordOnly', 'query.collinsMin', 'query.bncMax', 'query.contemporaryMax', 'query.sort']) {
      expect(page).toContain(field)
    }
    expect(page).toContain('<PaginationFooter offset={page.offset} limit={page.limit} total={page.total}')
    expect(search).not.toContain('client.preflightInstall(profile)')
    expect(search).not.toContain('管理本地词典资源')
    expect(settings).toContain('client.preflightInstall(profile)')
    expect(settings).toContain('client.install(profile)')
    expect(settings).toContain("install('full')")
    expect(settings).toContain('client.removeFullExtension()')
    expect(settings).toContain('client.repair(')
  })

  it('combines local dictionary preferences with E4 online enhancement and speech', async () => {
    const page = await readText('src/renderer/tauri/mobile-dictionary-pages.tsx')
    expect(page).toContain('checked={draft.enabled}')
    expect(page).toContain('client.savePreferences(draft)')
    expect(page).toContain('draft.lookupProviderId')
    expect(page).toContain('draft.fallbackToLocal')
    expect(page).toContain('onChange={(fallbackToLocal) => setDraft({ ...draft, fallbackToLocal })}')
    expect(page).not.toContain('checked={draft.fallbackToLocal} disabled')
    expect(page).toContain('draft.contextExplanationEnabled')
    expect(page).toContain('draft.translateExamples')
    expect(page).toContain("draft.lookupProviderId === 'baidu' && <>")
    expect(page).toContain("draft.lookupProviderId === 'baidu' && <EditorialCard")
    expect(page).toContain('speech.play({')
    expect(page).toContain('保存并测试')
    expect(page).not.toMatch(/(?:fetch\(|https?:\/\/)/)
  })
})

describe('Android E3 study center', () => {
  it('integrates dashboard, editor, plan detail, today history and device-session routes', async () => {
    const app = await readText('src/renderer/tauri/mobile-app.tsx')
    expect(app).toContain("from './mobile-study-pages'")
    for (const route of ["route.name === 'study'", "route.name === 'study-plan-editor'", "route.name === 'study-plan'", "route.name === 'study-today'", "route.name === 'study-session'"]) {
      expect(app).toContain(route)
    }
    expect(app).toContain('setStudySession(session)')
    expect(app).toContain("navigate({ name: 'study-session' })")
  })

  // Study behavior is exercised by mobile-study-loading.test.ts and the shared study suites.
})
