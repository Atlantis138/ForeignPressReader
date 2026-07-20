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

  it('covers plan sources, quotas, lifecycle, diagnostics and word actions', async () => {
    const page = await readText('src/renderer/tauri/mobile-study-pages.tsx')
    expect(page).toContain('client.listDictionaryCollections()')
    expect(page).toContain("{ type: 'reader_manual', ref: 'favorite' }")
    expect(page).toContain('dailyNewLimit')
    expect(page).toContain('dailyReviewLimit')
    expect(page).toContain("changeStatus(detail.status === 'active' ? 'paused' : 'active')")
    expect(page).toContain("changeStatus('archived')")
    expect(page).toContain('client.syncSources(planId)')
    for (const diagnostic of ['word.difficulty', 'word.stability', 'word.retrievability', 'word.reps', 'word.lapses']) {
      expect(page).toContain(diagnostic)
    }
    expect(page).toContain('client.setWordExcluded(')
    expect(page).toContain('client.setWordSuspended(')
    expect(page).toContain('debug?.enabled')
    expect(page).toContain('client.deletePlan(planId, deleteName, { resetWordProgress })')
    expect(page).toContain('deleteName !== detail.name')
    expect(page).toContain('MobileDistributionDonut')
    expect(page).toContain('查看熟练度、复习安排与计划词表。')
    for (const label of ['今日待复习', '暂停复习', '已排除']) expect(page).toContain(label)
    expect(page).not.toContain('计划词表筛选')
  })

  it('keeps the two-stage answer, correction, reinforcement and too-easy undo flow explicit', async () => {
    const page = await readText('src/renderer/tauri/mobile-study-pages.tsx')
    expect(page).toContain("stage('known')")
    expect(page).toContain("stage('unknown')")
    expect(page).toContain("commit('known')")
    expect(page).toContain("commit('unknown')")
    expect(page).toContain("current.proposedAnswer === 'known'")
    expect(page).toContain('client.markTooEasy(')
    expect(page).toContain('undoTooEasy')
    expect(page).toContain('window.setTimeout(() => setUndo(null)')
    expect(page).toContain('client.addExtraBatch(')
  })

  it('persists all user-facing queue and FSRS settings for the next batch', async () => {
    const page = await readText('src/renderer/tauri/mobile-study-pages.tsx')
    expect(page).toContain('draft.queueOrder')
    expect(page).toContain('draft.cutoffHour')
    expect(page).toContain('draft.requestRetention')
    expect(page).toContain('draft.maximumInterval')
    expect(page).toContain('min="0" max="23"')
    expect(page).toContain('min="0.8" max="0.95" step="0.01"')
    expect(page).toContain('min="30" max="36500"')
    expect(page).toContain('client.savePreferences(draft)')
    expect(page).toContain('下一批任务生效')
  })
})
