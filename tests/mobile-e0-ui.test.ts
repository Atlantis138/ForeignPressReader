import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readMobileCssSource } from './mobile-source'

const readText = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Android E0 product shell', () => {
  it('uses four accessible primary destinations and shared SVG icons', async () => {
    const ui = await readText('src/renderer/tauri/mobile-ui.tsx')
    expect(ui).toContain("{ tab: 'library', label: '书库'")
    expect(ui).toContain("{ tab: 'dictionary', label: '词典'")
    expect(ui).toContain("{ tab: 'study', label: '背单词'")
    expect(ui).toContain("{ tab: 'settings', label: '设置'")
    expect(ui).toContain('aria-label="主要导航"')
    expect(ui).toContain("aria-current={active ? 'page' : undefined}")
    expect(ui).not.toMatch(/[‹›]/)
  })

  it('adapts bottom navigation to a safe wide-screen rail', async () => {
    const css = await readMobileCssSource()
    expect(css).toContain('@media (min-width: 840px) and (min-height: 600px)')
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toContain('env(safe-area-inset-top)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('--font-editorial:')
    expect(css).toContain('--accent: #c9252b')
    expect(css).toContain('min-height: 48px')
  })

  it('replaces prototype overlays with typed routes and shared feedback', async () => {
    const [app, model] = await Promise.all([
      readText('src/renderer/tauri/mobile-app.tsx'),
      readText('src/renderer/tauri/mobile-shell-model.ts'),
    ])
    expect(app).toContain('<MobileAppShell')
    expect(app).toContain('<ConfirmDialog')
    expect(app).toContain("replaceTabRoot(current, 'dictionary', { name: 'dictionary', mode: 'vocabulary' })")
    expect(app).not.toContain('window.confirm(')
    expect(app).not.toContain('vocabularyOpen')
    expect(app).not.toContain('studyOpen')
    expect(model).toContain("'fpr.android.shell.v1'")
    expect(model).not.toMatch(/(?:apiKey|secret|credential)/i)
  })
})
