import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readMobileAppSource, readMobileCssSource } from './mobile-source'

const readText = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Android E1 local library and reader', () => {
  it('uses the typed library/reader facets and activates the optional E4 service slots', async () => {
    const [client, services, app] = await Promise.all([
      readText('src/renderer/tauri/mobile-client.ts'),
      readText('src/shared/mobile-reader-services.ts'),
      readMobileAppSource(),
    ])
    expect(client).toContain('readonly library: LibraryApi')
    expect(client).toContain('readonly reader: ReaderApi')
    expect(client).toContain('readonly services: MobileReaderServiceSlots')
    expect(services).toContain('translation: TranslationApi | null')
    expect(services).toContain('speech: SpeechApi | null')
    expect(app).toContain('translationClient.translateArticle(articleId)')
    expect(app).toContain('speechClient.play({')
    expect(app).not.toContain('synthesize(')
  })

  it('provides file-manager controls without browser prompts or character-arrow placeholders', async () => {
    const [app, icons] = await Promise.all([
      readMobileAppSource(),
      readText('src/renderer/ui/icons.tsx'),
    ])
    for (const feature of ['管理分类', '重命名刊物', '归类所选刊物', '删除所选刊物', 'sectionCount', 'categoryName', 'sortDirection', 'viewMode', 'selection.mode']) {
      expect(app).toContain(feature)
    }
    expect(app).toContain('onContextMenu=')
    expect(app).not.toContain('mobile-book-check')
    expect(app).not.toContain('搜索书名、作者或语言')
    expect(app).not.toContain('搜索目录中的文章')
    expect(app).toContain('aria-expanded={!collapsed}')
    expect(app).not.toContain('window.prompt(')
    expect(app).not.toContain('window.confirm(')
    expect(icons).toContain('export const FolderIcon')
    expect(icons).toContain('export const GridIcon')
    expect(icons).toContain('export const TrashIcon')
  })

  it('keeps reader search, cached translations and all appearance fields mobile-safe', async () => {
    const [app, css] = await Promise.all([
      readMobileAppSource(),
      readMobileCssSource(),
    ])
    expect(app).toContain('findArticleMatches(article.blocks, searchQuery)')
    expect(app).toContain('data-translation-block-id')
    expect(app).toContain('preferences.columnWidth')
    expect(app).toContain('preferences.paperTint')
    expect(css).toContain('width: min(calc(100% - 28px),var(--reader-width))')
    expect(css).toContain('.mobile-translation-text')
    expect(css).toContain('.mobile-reader-search')
    expect(css).toContain('@media (max-width: 520px)')
  })

  it('exposes the honest six-section settings framework and shared appearance controls', async () => {
    const [app, model] = await Promise.all([
      readMobileAppSource(),
      readText('src/renderer/tauri/mobile-appearance-model.ts'),
    ])
    for (const section of ['阅读外观', '翻译服务', '词典服务', '语音服务', '每日学习', '数据与存储']) expect(app).toContain(section)
    expect(app).not.toContain('<SectionHeader title="阅读与语言"')
    expect(app).not.toContain('<SectionHeader title="学习与本机"')
    expect(app).toContain('保存并测试')
    expect(app).toContain('从可见段落开始朗读')
    expect(app).toContain('format v1')
    expect(app).toContain('便携备份')
    expect(app).toContain('<AppearanceControls preferences={preferences}')
    expect(model).toContain("{ id: 'compact', label: '紧凑', value: 640 }")
    expect(model).toContain("{ id: 'wide', label: '宽阔', value: 900 }")
  })

  it('uses compact scalable chrome while preserving minimum interaction targets', async () => {
    const css = await readMobileCssSource()
    expect(css).toContain('--title-page: clamp(1.55rem,6vw,1.78rem)')
    expect(css).toMatch(/\.mobile-app-shell \.mobile-button\s*\{[^}]*min-height:\s*40px/s)
    expect(css).toMatch(/\.mobile-app-shell \.mobile-button\.primary\s*\{[^}]*box-shadow:\s*none/s)
    expect(css).toContain('height: calc(60px + env(safe-area-inset-bottom))')
    expect(css).toContain('grid-template-columns: repeat(3,minmax(0,1fr))')
    expect(css).toMatch(/\.mobile-app-shell \.mobile-cover > img\[hidden\]\s*\{\s*display:\s*none;/s)
    expect(css).toContain('.mobile-app-shell .mobile-toggle > input:checked + span')
    expect(css).toContain('text-size-adjust: 100%')
  })

})
