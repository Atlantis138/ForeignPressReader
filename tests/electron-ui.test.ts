import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import JSZip from 'jszip'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { EpubImporter } from '../src/main/epub-importer'
import { LibraryService } from '../src/main/library-service'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import { contentsCacheKey } from '../src/core/contents-cache'
import { FileContentsCache } from '../src/main/contents-cache'

const samplePath = process.env.EPUB_SAMPLE_PATH
let application: ElectronApplication | null = null
let testRoot: string | null = null

afterAll(async () => {
  await application?.close()
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('Electron publication import worker', () => {
  it('imports a compressed EPUB through the renderer IPC without retaining the source file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-electron-import-'))
    const epubPath = path.join(root, 'compressed.epub')
    let appUnderTest: ElectronApplication | null = null
    try {
      const zip = await JSZip.loadAsync(await contentsEpub())
      fs.writeFileSync(epubPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
      appUnderTest = await electron.launch({
        args: ['.'], cwd: process.cwd(), env: { ...process.env, READER_USER_DATA_PATH: root },
      })
      await appUnderTest.evaluate(({ dialog }, sourceFile) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] })
      }, epubPath)
      const page = await appUnderTest.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.locator('.page-header .primary-button').click()

      await expect.poll(() => page.locator('.toc-section').count(), { timeout: 30_000 }).toBe(1)
      await expect.poll(() => page.locator('.toc-section button').count()).toBe(30)
      fs.mkdirSync(path.join(process.cwd(), 'test-artifacts'), { recursive: true })
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'contents-desktop.png') })
      await page.locator('.toc-section button').last().scrollIntoViewIfNeeded()
      const contentsScroll = await page.locator('.main-content').evaluate(element => element.scrollTop)
      expect(contentsScroll).toBeGreaterThan(500)
      await page.locator('.toc-section button').last().click()
      await page.getByRole('button', { name: '目录', exact: true }).click()
      await expect.poll(() => page.locator('.main-content').evaluate(element => element.scrollTop)).toBeCloseTo(contentsScroll, 0)
      await page.locator('.app-sidebar nav button').nth(3).click({ force: true })
      await page.locator('.app-sidebar nav button').nth(0).click({ force: true })
      await expect.poll(() => page.locator('.main-content').evaluate(element => element.scrollTop)).toBeCloseTo(contentsScroll, 0)
      await expect.poll(() => page.locator('.error-banner').count()).toBe(0)
      expect(fs.existsSync(epubPath)).toBe(true)
      const managedFiles = fs.readdirSync(path.join(root, 'library'), { recursive: true })
        .map((entry) => String(entry).replace(/\\/g, '/'))
      expect(managedFiles.some((entry) => entry === 'source.epub' || entry.endsWith('/source.epub'))).toBe(false)
      const publication = await page.evaluate(async () => {
        const state = await window.readerApi.library.getState()
        return window.readerApi.library.getPublication(state.publications[0].id)
      })
      const articleId = [...publication.unsectionedArticles, ...publication.sections.flatMap(section => section.articles)][0].id
      new FileContentsCache(path.join(root, 'app-cache', 'contents-translations')).write(
        contentsCacheKey(publication, { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }),
        { [articleId]: '重启后保留的目录译文' },
      )
      await appUnderTest.close()
      appUnderTest = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, READER_USER_DATA_PATH: root } })
      const reopened = await appUnderTest.firstWindow()
      await reopened.waitForLoadState('domcontentloaded')
      await reopened.locator('.managed-book-card .book-open').click()
      await expect.poll(() => reopened.getByText('重启后保留的目录译文', { exact: true }).count()).toBe(1)
    } finally {
      await appUnderTest?.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('vocabulary Electron UI', () => {
  it('persists reader favorite/context controls and exposes My Vocabulary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-electron-vocabulary-'))
    const epubPath = path.join(root, 'vocabulary.epub')
    let appUnderTest: ElectronApplication | null = null
    try {
      fs.writeFileSync(epubPath, await vocabularyEpub())
      const database = await SqliteApplicationRepository.open(root, 'test')
      const library = new LibraryService(database, epubFormats(), root)
      const imported = await library.importFile(epubPath)
      const article = [...imported.publication.unsectionedArticles, ...imported.publication.sections.flatMap(section => section.articles)][0]
      const block = database.getTranslatableBlocks(article.id).find(item => item.type === 'paragraph')!
      database.saveTranslation(block.id, block.sourceHash, '这是一段用于验证字号的测试译文。', 'deepseek-v4-flash', 'editorial-zh-v1')
      database.saveSpeechPreferences({
        locale: 'en-US', voiceId: null, rate: 0.9,
        autoPlayStudy: false, wordProviderId: 'system', articleProviderId: 'system',
        providerSettings: {
          google: { modelId: 'standard', voiceId: 'en-US-Standard-C' },
          minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
        },
      })
      database.close()
      await installSyntheticDictionary(root)

      appUnderTest = await electron.launch({
        args: ['.'], cwd: process.cwd(), env: { ...process.env, READER_USER_DATA_PATH: root },
      })
      const page = await appUnderTest.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(blobAudioLoadResult(page)).resolves.toBe('loadeddata')
      fs.mkdirSync(path.join(process.cwd(), 'test-artifacts'), { recursive: true })
      await expect.poll(() => page.locator('.book-card:not(.add-card)').count()).toBe(1)
      await page.getByLabel('新分类名称').fill('测试分类')
      await page.getByRole('button', { name: '建立分类' }).click()
      await expect.poll(() => page.locator('.library-categories').innerText()).toContain('测试分类')
      await page.locator('.library-category-row').filter({ hasText: '测试分类' }).hover()
      await page.getByLabel('重命名分类 测试分类').click()
      await page.getByLabel('分类名称', { exact: true }).fill('已整理')
      await page.getByRole('button', { name: '保存名称' }).click()
      await expect.poll(() => page.locator('.library-categories').innerText()).toContain('已整理')
      await page.getByRole('button', { name: '选择', exact: true }).click()
      await page.getByRole('button', { name: '选择 Vocabulary Weekly' }).click()
      await expect.poll(() => page.getByRole('button', { name: '取消选择 Vocabulary Weekly' }).getAttribute('aria-pressed')).toBe('true')
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'library-selection.png'), fullPage: false })
      await page.getByLabel('批量移动到分类').selectOption({ label: '已整理' })
      await expect.poll(() => page.locator('.managed-book-card').innerText()).toContain('已整理')
      await page.getByRole('button', { name: '退出选择' }).click()
      await page.getByRole('button', { name: '列表', exact: true }).click()
      await expect.poll(() => page.locator('.book-list-row').count()).toBe(1)
      await page.getByRole('button', { name: '图标', exact: true }).click()
      await expect.poll(() => page.locator('.managed-book-grid').count()).toBe(1)
      await page.locator('.managed-book-card').getByRole('button', { name: '重命名' }).click()
      await page.getByLabel('书名').fill('我的测试周刊')
      await page.getByRole('button', { name: '保存名称' }).click()
      await expect.poll(() => page.evaluate(() => window.readerApi.library.getState().then((state) => state.publications[0]?.title))).toBe('我的测试周刊')
      await expect.poll(() => page.locator('.managed-book-card h2').innerText()).toBe('我的测试周刊')
      await page.locator('.managed-book-card .book-open').click()
      await page.getByText('America article', { exact: true }).click()
      await expect.poll(() => page.locator('.reader-article').count()).toBe(1)
      await page.locator('.translation-toggle').first().click()
      await expect.poll(() => page.locator('.translation-text').evaluate(element => getComputedStyle(element).fontSize)).toBe('20px')
      await page.getByTitle('增大字号').click()
      await expect.poll(() => page.locator('.translation-text').evaluate(element => getComputedStyle(element).fontSize)).toBe('21px')
      await page.getByTitle('减小字号').click()
      const readerScrollTop = await page.evaluate(() => { const article = document.querySelector<HTMLElement>('.reader-article'); const main = document.querySelector<HTMLElement>('.main-content'); if (!main || !article) return 0; article.style.minHeight = '1800px'; main.scrollTop = 120; return main.scrollTop })
      expect(readerScrollTop).toBeGreaterThan(0)
      await page.locator('.app-sidebar nav button').nth(1).click({ force: true })
      await expect.poll(() => page.locator('.dictionary-page h1').innerText()).toBe('词典')
      await expect.poll(() => page.locator('.reader-article').count()).toBe(0)
      await page.locator('.app-sidebar nav button').nth(0).click({ force: true })
      await expect.poll(() => page.locator('.reader-article').count()).toBe(1)
      await expect.poll(() => page.locator('.dictionary-page').count()).toBe(0)
      await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.main-content')?.scrollTop ?? 0)).toBeCloseTo(readerScrollTop, 0)
      await installSpeechSpy(page)
      const firstParagraph = page.locator('.reader-article .text-block').filter({ hasText: /sufficiently long editorial sentence/ }).first()
      const firstSpeechButton = firstParagraph.locator('.block-speech-button')
      await firstParagraph.scrollIntoViewIfNeeded()
      await firstSpeechButton.evaluate((button: HTMLButtonElement) => button.click())
      await expect.poll(() => spokenTexts(page)).toEqual([expect.stringContaining('sufficiently long editorial sentence')])
      await expect.poll(() => page.locator('.reader-speech-player').count()).toBe(1)
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'tts-reader.png'), fullPage: false })
      await clearSpokenTexts(page)
      const word = page.locator('.reader-article .lookup-word').filter({ hasText: /^America$/ }).first()
      await word.click()
      await expect.poll(() => page.locator('.dictionary-drawer').getAttribute('data-state')).toBe('open')
      const favorite = page.locator('.dictionary-drawer .vocabulary-toggle')
      const context = page.locator('.dictionary-drawer .context-save-toggle')
      await expect.poll(() => favorite.isEnabled()).toBe(true)
      await favorite.click()
      await expect.poll(() => favorite.innerText()).toContain('已收藏')
      await expect.poll(() => context.innerText()).toContain('已收藏语境')
      await page.locator('.dictionary-drawer .pronounce-button').click()
      await expect.poll(() => spokenTexts(page)).toEqual(['America'])
      const overlap = await page.locator('.dictionary-word').evaluate((container) => {
        container.classList.add('very-long-word')
        const title = container.querySelector('h2')!
        const action = container.querySelector('.vocabulary-toggle')!
        title.textContent = 'institutionalizationadministration'
        const left = title.getBoundingClientRect()
        const right = action.getBoundingClientRect()
        const intersects = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
        title.textContent = 'America'
        container.classList.remove('very-long-word')
        return intersects
      })
      expect(overlap).toBe(false)

      await page.locator('.dictionary-drawer > header > button').click()
      await expect.poll(() => page.locator('.dictionary-drawer').count()).toBe(0)
      await word.click()
      await expect.poll(() => page.locator('.dictionary-drawer .vocabulary-toggle').innerText()).toContain('已收藏')

      await page.locator('.app-sidebar nav button').nth(2).click({ force: true })
      await page.getByRole('button', { name: /创建计划/ }).click()
      const savePlan = page.getByRole('button', { name: '保存并同步' })
      await savePlan.click()
      await expect.poll(() => page.locator('.error-banner').innerText()).toContain('计划名称')
      await expect.poll(() => savePlan.isEnabled()).toBe(true)
      await page.locator('.error-banner button').click()
      await page.locator('.plan-editor > label input').fill('外刊生词计划')
      await savePlan.click()
      await expect.poll(() => page.locator('.study-plan-card').innerText()).toContain('外刊生词计划')
      await page.locator('.study-plan-card').click()
      const planSearch = page.locator('.study-word-search input')
      await expect.poll(() => planSearch.isEditable()).toBe(true)
      await planSearch.click()
      await planSearch.fill('Amer')
      await expect.poll(() => planSearch.inputValue()).toBe('Amer')
      await page.getByRole('button', { name: '搜索' }).click()
      await expect.poll(() => page.locator('.plan-word-table').innerText()).toContain('America')
      await page.locator('.app-sidebar nav button').nth(3).click({ force: true })
      const developerNav = page.getByRole('button', { name: '开发与调试' })
      await expect.poll(() => developerNav.count()).toBe(0)
      const settingsTitle = page.locator('.settings-unlock-title')
      for (let index = 0; index < 9; index += 1) await settingsTitle.click()
      await expect.poll(() => developerNav.count()).toBe(0)
      await settingsTitle.click()
      await expect.poll(() => developerNav.count()).toBe(1)
      await developerNav.click()
      await expect.poll(() => page.locator('.developer-mode-card').count()).toBe(1)
      await page.getByRole('button', { name: '翻译服务' }).click()
      const translationSelects = page.locator('.settings-content select')
      await expect.poll(() => translationSelects.count()).toBe(1)
      await translationSelects.nth(0).selectOption('openai')
      const translationModel = page.locator('input[list="translation-model-options"]')
      await expect.poll(() => translationModel.inputValue()).toBe('gpt-5.4-nano')
      await page.getByRole('button', { name: '保存模型选择' }).click()
      await expect.poll(() => page.locator('.toast').innerText()).toContain('翻译模型已保存')
      await translationSelects.nth(0).selectOption('moonshot')
      await expect.poll(() => page.locator('#translation-model-options option').allTextContents()).toEqual([
        'Moonshot V1 8K', 'Moonshot V1 32K', 'Moonshot V1 128K', 'Kimi K2.6',
      ])
      await translationModel.fill('test-custom-model')
      await page.getByRole('button', { name: '保存模型选择' }).click()
      await expect.poll(() => page.evaluate(() => window.readerApi.settings.getTranslationSettings().then(value => value.preferences.modelId))).toBe('test-custom-model')
      await page.locator('.app-sidebar nav button').nth(1).click()
      await page.locator('.app-sidebar nav button').nth(3).click()
      await page.getByRole('button', { name: '翻译服务' }).click()
      await expect.poll(() => translationModel.inputValue()).toBe('test-custom-model')
      await page.getByRole('button', { name: '删除自定义模型' }).click()
      await expect.poll(() => translationModel.inputValue()).toBe('gpt-5.4-nano')
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'translation-settings.png'), fullPage: false })
      await page.getByRole('button', { name: '语音服务' }).click()
      const autoPronounce = page.getByRole('checkbox', { name: '每日学习卡出现时自动朗读一次' })
      await expect.poll(() => autoPronounce.isChecked()).toBe(false)
      await page.getByText('每日学习卡出现时自动朗读一次', { exact: true }).click()
      await expect.poll(() => autoPronounce.isChecked()).toBe(true)
      await page.getByRole('button', { name: '保存语音设置' }).click()
      await page.locator('.app-sidebar nav button').nth(0).click({ force: true })
      await expect.poll(() => page.locator('.reader-article').count()).toBe(1)
      await expect.poll(() => page.locator('.settings-page').count()).toBe(0)
      await page.locator('.app-sidebar nav button').nth(3).click({ force: true })
      await expect.poll(() => page.locator('.speech-settings-card').count()).toBe(1)
      await expect.poll(() => page.locator('.reader-article').count()).toBe(0)
      await page.locator('.app-sidebar nav button').nth(2).click({ force: true })
      await expect.poll(() => page.locator('.plan-detail').count()).toBe(1)
      await expect.poll(() => page.locator('.settings-page').count()).toBe(0)
      await expect.poll(() => planSearch.inputValue()).toBe('Amer')
      await page.locator('.plan-detail > header button').click()
      await clearSpokenTexts(page)
      await page.getByRole('button', { name: '开始今日学习' }).click()
      await expect.poll(() => page.locator('.study-card h1').innerText()).toBe('America')
      await expect.poll(() => spokenTexts(page)).toEqual(['America'])
      await page.locator('.study-card .pronounce-button').click()
      await expect.poll(() => spokenTexts(page)).toEqual(['America', 'America'])
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'tts-study.png'), fullPage: false })
      await page.getByRole('button', { name: '认识', exact: true }).click()
      await expect.poll(() => page.locator('.study-answer').innerText()).toContain('美国')
      await page.getByRole('button', { name: '其实不认识' }).click()
      await page.getByRole('button', { name: '认识', exact: true }).click()
      await page.getByRole('button', { name: '确认认识，继续' }).click()
      await page.getByRole('button', { name: '认识', exact: true }).click()
      await page.getByRole('button', { name: '确认认识，继续' }).click()
      await expect.poll(() => page.locator('.today-card').innerText()).toContain('今天的任务已完成')
      await page.getByRole('button', { name: '查看今日词表' }).click()
      await expect.poll(() => page.locator('.today-history').innerText()).toContain('America')
      await page.locator('.today-history > header button').click()

      await page.locator('.app-sidebar nav button').nth(1).click({ force: true })
      await page.getByRole('tab', { name: /我的生词/ }).click()
      await expect.poll(() => page.locator('.dictionary-results').innerText()).toContain('America')
      await page.locator('.dictionary-results button').filter({ hasText: 'America' }).first().click()
      await expect.poll(() => page.locator('.lexeme-contexts').innerText()).toContain('America article')
      await page.locator('.app-sidebar nav button').nth(0).click({ force: true })
      await expect.poll(() => page.locator('.reader-article').count()).toBe(1)
      await page.locator('.app-sidebar nav button').nth(1).click({ force: true })
      await expect.poll(() => page.locator('.lexeme-contexts').innerText()).toContain('America article')
      await clearSpokenTexts(page)
      await page.locator('.dictionary-detail .pronounce-button').click()
      await expect.poll(() => spokenTexts(page)).toEqual(['America'])
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'tts-dictionary.png'), fullPage: false })
      await page.getByRole('button', { name: '取消收藏' }).click()
      await expect.poll(() => page.locator('.dictionary-results').innerText()).not.toContain('America')
      await page.getByRole('tab', { name: '词典检索' }).click()
      await page.getByLabel('搜索词典').fill('part')
      await expect.poll(() => page.locator('.dictionary-results').innerText()).toContain('部分')
      await page.locator('.dictionary-results > button').filter({ hasText: /^part/ }).first().click()
      await expect.poll(() => page.locator('.dictionary-detail h2').innerText()).toBe('part')
      const metadataBadges = await page.locator('.dictionary-detail .lexeme-badges span').allTextContents()
      expect(metadataBadges.filter(text => text === '高考')).toHaveLength(1)
      expect(metadataBadges.filter(text => text.includes('考研'))).toHaveLength(1)
      await expect.poll(() => page.locator('.lexeme-meaning-line').innerText()).not.toContain('角色')
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'dictionary-meanings-v088.png'), fullPage: false })
      await page.getByRole('button', { name: '展开其余 2 项' }).click()
      await expect.poll(() => page.locator('.lexeme-meaning-line').innerText()).toContain('角色')
      await page.getByRole('button', { name: '收起释义' }).click()
      await expect.poll(() => page.locator('.lexeme-meaning-line').innerText()).not.toContain('角色')
      await page.locator('.app-sidebar nav button').nth(3).click({ force: true })
      await page.getByRole('button', { name: '语音服务' }).click()
      await expect.poll(() => page.locator('.speech-settings-card').count()).toBe(1)
      await page.locator('.speech-settings-card').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'tts-settings.png'), fullPage: false })
      await page.getByRole('button', { name: '词典服务' }).click()
      await expect.poll(() => page.locator('.settings-card.dictionary-settings').count()).toBe(1)
      await expect.poll(() => page.locator('.dictionary-local-section').count()).toBe(1)
      await expect.poll(() => page.locator('.dictionary-online-section').count()).toBe(1)
      await page.getByRole('button', { name: '百度增强' }).click()
      await expect.poll(() => page.locator('.online-dictionary-options').count()).toBe(1)
      await expect.poll(() => page.getByRole('button', { name: '百度增强' }).getAttribute('aria-pressed')).toBe('true')
      await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'dictionary-settings-v088.png'), fullPage: false })
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: '删除词典', exact: true }).click()
      await expect.poll(() => page.locator('.dictionary-online-section').count()).toBe(0)
      await expect.poll(() => page.locator('.dictionary-local-section').innerText()).toContain('未安装')
    } finally {
      await appUnderTest?.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!samplePath)('packaged Electron UI', () => {
  it('renders library, contents and normalized article in an isolated renderer', async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-electron-'))
    const database = await SqliteApplicationRepository.open(testRoot, 'test')
    const library = new LibraryService(database, epubFormats(), testRoot)
    const imported = await library.importFile(samplePath!)
    const searchArticle = imported.publication.sections.flatMap((section) => section.articles)
      .find((article) => article.title === 'America is anxious, and awesomely powerful')!
    const searchBlock = database.getTranslatableBlocks(searchArticle.id)[0]
    database.saveTranslation(searchBlock.id, searchBlock.sourceHash, '美国焦虑而强大。', 'test-model', 'test-prompt')
    database.close()
    await installSyntheticDictionary(testRoot)

    application = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: { ...process.env, READER_USER_DATA_PATH: testRoot },
    })
    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.locator('.book-card').count()).toBeGreaterThan(0)
    expect(await page.locator('body').innerText()).toContain('TheEconomist.2026.07.04')
    expect(await page.evaluate(() => ({
      requireType: typeof (window as any).require,
      processType: typeof (window as any).process,
      bridgeType: typeof window.readerApi,
    }))).toEqual({ requireType: 'undefined', processType: 'undefined', bridgeType: 'object' })

    fs.mkdirSync(path.join(process.cwd(), 'test-artifacts'), { recursive: true })
    await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'library.png'), fullPage: true })
    await page.locator('.book-card').first().click()
    await expect.poll(() => page.locator('.toc-section').count()).toBe(19)
    expect(await page.locator('.toc-section button').count()).toBe(74)
    await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'contents.png'), fullPage: true })

    await page.getByText('America is anxious, and awesomely powerful', { exact: true }).click()
    await expect.poll(() => page.locator('.reader-article h1').first().innerText()).toContain('America is anxious')
    expect(await page.locator('.reader-article .text-block').count()).toBe(21)
    expect(await page.locator('.reader-article figure img').count()).toBe(1)

    const reader = page.locator('.reader-view')
    const image = page.locator('.reader-article figure').first()
    await reader.evaluate((element) => element.style.setProperty('--reader-width', '560px'))
    await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(560)
    await reader.evaluate((element) => element.style.setProperty('--reader-width', '980px'))
    await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(980)
    await reader.evaluate((element) => element.style.setProperty('--reader-width', '760px'))
    await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'article.png'), fullPage: false })

    await page.setViewportSize({ width: 1800, height: 1000 })
    const toolbarBefore = await page.locator('.reader-toolbar').boundingBox()
    const articleWidthBefore = (await page.locator('.reader-article').boundingBox())!.width
    const firstWord = page.locator('.reader-article .lookup-word').first()
    const wordTopBefore = (await firstWord.boundingBox())!.y
    await firstWord.click()
    await expect.poll(() => page.locator('.dictionary-drawer').getAttribute('data-state')).toBe('open')
    expect(await reader.getAttribute('class')).toContain('dictionary-reserved')
    const toolbarAfter = await page.locator('.reader-toolbar').boundingBox()
    expect(Math.abs(toolbarAfter!.width - toolbarBefore!.width)).toBeLessThan(2)
    expect(Math.abs(toolbarAfter!.x - toolbarBefore!.x)).toBeLessThan(2)
    expect(Math.abs((await page.locator('.reader-article').boundingBox())!.width - articleWidthBefore)).toBeLessThan(2)
    expect(Math.abs((await firstWord.boundingBox())!.y - wordTopBefore)).toBeLessThan(8)
    expect(await page.locator('.dictionary-drawer').innerText()).toContain('美国')
    expect(await page.locator('.dictionary-drawer').innerText()).toContain('分析文中义')
    const favoriteToggle = page.locator('.dictionary-drawer .vocabulary-toggle')
    const contextToggle = page.locator('.dictionary-drawer .context-save-toggle')
    await expect.poll(() => favoriteToggle.isEnabled()).toBe(true)
    await favoriteToggle.click()
    await expect.poll(() => favoriteToggle.innerText()).toContain('已收藏')
    await expect.poll(() => contextToggle.innerText()).toContain('已收藏语境')
    await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'dictionary-drawer.png'), fullPage: false })
    await page.locator('.dictionary-drawer > header > button').evaluate((button: HTMLButtonElement) => button.click())
    expect(await page.locator('.dictionary-drawer').getAttribute('data-state')).toBe('closing')
    await expect.poll(() => page.locator('.dictionary-drawer').count()).toBe(0)

    await page.setViewportSize({ width: 1000, height: 800 })
    await page.waitForTimeout(260)
    const narrowArticleBefore = await page.locator('.reader-article').boundingBox()
    await firstWord.click()
    await expect.poll(() => page.locator('.dictionary-drawer').getAttribute('data-state')).toBe('open')
    await expect.poll(() => page.locator('.dictionary-drawer .vocabulary-toggle').innerText()).toContain('已收藏')
    await expect.poll(() => page.locator('.dictionary-drawer .context-save-toggle').innerText()).toContain('已收藏语境')
    expect(await reader.getAttribute('class')).toContain('dictionary-overlay')
    const narrowArticleAfter = await page.locator('.reader-article').boundingBox()
    expect(Math.abs(narrowArticleAfter!.x - narrowArticleBefore!.x)).toBeLessThan(2)
    expect(Math.abs(narrowArticleAfter!.width - narrowArticleBefore!.width)).toBeLessThan(2)
    const anchoredTop = (await firstWord.boundingBox())!.y
    await page.setViewportSize({ width: 980, height: 760 })
    await expect.poll(async () => Math.abs((await firstWord.boundingBox())!.y - anchoredTop)).toBeLessThan(14)
    await page.locator('.dictionary-drawer > header > button').evaluate((button: HTMLButtonElement) => button.click())
    await expect.poll(() => page.locator('.dictionary-drawer').count()).toBe(0)

    await page.setViewportSize({ width: 1440, height: 920 })
    await page.keyboard.press('Control+f')
    const search = page.locator('.reader-search-panel input')
    await search.fill('America')
    await expect.poll(async () => Number((await page.locator('.reader-search-panel > span').innerText()).split('/')[1])).toBeGreaterThan(0)
    expect(await page.evaluate(() => (CSS.highlights.get('reader-search-active') as Highlight | undefined)?.size ?? 0)).toBe(1)
    await search.fill('美国')
    await expect.poll(() => page.locator('.translation-text').count()).toBeGreaterThan(0)
    expect(await page.locator('.reader-search-panel').innerText()).toContain('同时搜索已有译文')
    expect(await page.evaluate(() => (CSS.highlights.get('reader-search-active') as Highlight | undefined)?.size ?? 0)).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.reader-search-panel').count()).toBe(0)
    expect(await page.locator('.translation-text').count()).toBe(0)

    await page.locator('.app-sidebar nav button').nth(1).click({ force: true })
    await page.getByRole('tab', { name: /我的生词/ }).click()
    await expect.poll(() => page.locator('.dictionary-results').innerText()).toContain('America')
    await page.locator('.dictionary-results button').filter({ hasText: 'America' }).first().click()
    await page.getByRole('button', { name: '取消收藏' }).click()
    await expect.poll(() => page.locator('.dictionary-results').innerText()).not.toContain('America')

    await page.locator('.app-sidebar nav button').nth(3).click({ force: true })
    await page.getByRole('button', { name: '词典服务' }).click()
    expect(await page.locator('.settings-page').innerText()).toContain('本地词典')
    expect(await page.locator('.settings-page').innerText()).toContain('在线词典')
    await page.screenshot({ path: path.join(process.cwd(), 'test-artifacts', 'dictionary-settings.png'), fullPage: false })
  })
})

async function installSyntheticDictionary(root: string): Promise<void> {
  const sourceRoot = path.join(root, 'dictionary-source')
  const stagingRoot = path.join(root, 'dictionary-staging')
  const dictionariesRoot = path.join(root, 'dictionaries')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(dictionariesRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'ecdict.csv'), [
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail',
    'America,əˈmerɪkə,a country,n. 美国,n:100,5,1,,100,100,,',
    'part,pɑːt,,"n. 部分\nn. 部件\nn. 部\nn. 区域、地区\nn. （度量单位的）等份、份\nn. 参加\nn. 成员\nn. 角色",n:100,3,1,gk ky,178,178,,',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'lemma.en.txt'), '', 'utf8')
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(path.join(process.cwd(), 'dist-electron', 'main', 'dictionary-worker.js'), {
      workerData: {
        mode: 'local',
        stagingRoot,
        csvPath: path.join(sourceRoot, 'ecdict.csv'),
        lemmaPath: path.join(sourceRoot, 'lemma.en.txt'),
      },
    })
    worker.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'done') resolve()
      if (message.type === 'error') reject(new Error(String(message.message)))
    })
    worker.on('error', reject)
  })
  fs.renameSync(path.join(stagingRoot, 'ecdict-base.sqlite'), path.join(dictionariesRoot, 'ecdict-base.sqlite'))
}

function epubFormats(): PublicationFormatRegistry {
  return new PublicationFormatRegistry([{
    id: 'epub', name: 'EPUB 电子刊物', extensions: ['epub'],
    maxBytes: 500 * 1024 * 1024, importer: new EpubImporter(),
  }])
}

async function installSpeechSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as typeof window & { __spokenTexts?: string[] }
    target.__spokenTexts = []
    Object.defineProperty(window.speechSynthesis, 'speak', {
      configurable: true,
      value: (utterance: SpeechSynthesisUtterance) => {
        target.__spokenTexts!.push(utterance.text)
      },
    })
    Object.defineProperty(window.speechSynthesis, 'cancel', { configurable: true, value: () => undefined })
    Object.defineProperty(window.speechSynthesis, 'pause', { configurable: true, value: () => undefined })
    Object.defineProperty(window.speechSynthesis, 'resume', { configurable: true, value: () => undefined })
  })
}

async function blobAudioLoadResult(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const sampleRate = 8_000
    const sampleCount = 800
    const bytes = new Uint8Array(44 + sampleCount)
    const view = new DataView(bytes.buffer)
    const text = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
    }
    text(0, 'RIFF'); view.setUint32(4, 36 + sampleCount, true); text(8, 'WAVE')
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true)
    view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, sampleCount, true)
    bytes.fill(128, 44)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const audio = new Audio()
    audio.preload = 'auto'
    try {
      return await new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => resolve('timeout'), 3_000)
        audio.onloadeddata = () => { window.clearTimeout(timer); resolve('loadeddata') }
        audio.onerror = () => { window.clearTimeout(timer); resolve(`error:${audio.error?.code ?? 0}`) }
        audio.src = url
        audio.load()
      })
    } finally {
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
    }
  })
}

function spokenTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as typeof window & { __spokenTexts?: string[] }).__spokenTexts ?? [])
}

function clearSpokenTexts(page: Page): Promise<void> {
  return page.evaluate(() => { (window as typeof window & { __spokenTexts?: string[] }).__spokenTexts = [] })
}

async function vocabularyEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Vocabulary Weekly</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="article" href="article.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="article"/></spine></package>`)
  zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="article.xhtml">America article</a></li></ol></nav></body></html>`)
  zip.file('EPUB/article.xhtml', `<html><head><title>America article</title></head><body><h1>America article</h1><p>America appears here in a sufficiently long editorial sentence that remains useful for vocabulary context testing.</p>${Array.from({ length: 24 }, (_, index) => `<p>This additional paragraph ${index + 1} keeps the synthetic article scrollable while workspace DOM is unmounted and later restored.</p>`).join('')}</body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function contentsEpub(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await vocabularyEpub())
  const articles = Array.from({ length: 30 }, (_, index) => ({ id: `article${index}`, title: `Contents headline ${index}` }))
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Contents Weekly</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${articles.map(article => `<item id="${article.id}" href="${article.id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${articles.map(article => `<itemref idref="${article.id}"/>`).join('')}</spine></package>`)
  zip.file('EPUB/nav.xhtml', `<html><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>${articles.map(article => `<li><a href="${article.id}.xhtml">${article.title}</a></li>`).join('')}</ol></nav></body></html>`)
  for (const article of articles) zip.file(`EPUB/${article.id}.xhtml`, `<html><body><h1>${article.title}</h1><p>A sufficiently long synthetic paragraph for a directory navigation test.</p></body></html>`)
  zip.remove('EPUB/article.xhtml')
  return zip.generateAsync({ type: 'nodebuffer' })
}
