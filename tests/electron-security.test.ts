import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isTrustedRendererIpcSource,
  isTrustedRendererUrl,
  PRODUCTION_RENDERER_ENTRY,
  rendererEntryUrl,
  resolveBundledRendererPath,
} from '../src/main/renderer-security'

describe('Electron renderer trust boundary', () => {
  it('accepts only the exact production entry URL', () => {
    expect(isTrustedRendererUrl(PRODUCTION_RENDERER_ENTRY)).toBe(true)
    for (const url of [
      'fpr-app://bundle.evil/index.html',
      'fpr-app://bundle/index.html.evil',
      'fpr-app://bundle/index.html?next=file://secret',
      'fpr-app://bundle/index.html#child',
      'fpr-app://bundle/other.html',
      'file:///app/index.html',
      'https://example.com/index.html',
    ]) expect(isTrustedRendererUrl(url), url).toBe(false)
  })

  it('uses an exact parsed development origin and path', () => {
    const dev = 'http://127.0.0.1:5173/app/'
    expect(rendererEntryUrl(dev)).toBe(dev)
    expect(isTrustedRendererUrl(dev, dev)).toBe(true)
    for (const url of [
      'http://127.0.0.1:5173/app',
      'http://127.0.0.1:5173/app/index.html',
      'http://127.0.0.1:5173/app/?debug=1',
      'http://127.0.0.1:5173/app/#frame',
      'http://127.0.0.1:51730/app/',
      'http://127.0.0.1.evil:5173/app/',
      'http://user@127.0.0.1:5173/app/',
    ]) expect(isTrustedRendererUrl(url, dev), url).toBe(false)
    expect(() => rendererEntryUrl('file:///tmp/index.html')).toThrow()
  })

  it('requires the current main window and its main frame for IPC', () => {
    expect(isTrustedRendererIpcSource({
      senderIsMainWindow: true,
      frameIsMainFrame: true,
      url: PRODUCTION_RENDERER_ENTRY,
    })).toBe(true)
    expect(isTrustedRendererIpcSource({
      senderIsMainWindow: false,
      frameIsMainFrame: true,
      url: PRODUCTION_RENDERER_ENTRY,
    })).toBe(false)
    expect(isTrustedRendererIpcSource({
      senderIsMainWindow: true,
      frameIsMainFrame: false,
      url: PRODUCTION_RENDERER_ENTRY,
    })).toBe(false)
  })

  it('maps only allowlisted bundle files and rejects traversal or directories', () => {
    const root = path.resolve('D:/app/dist')
    const allowlist = new Set(['index.html', 'assets/app-123.js', 'assets/app-123.css'])
    expect(resolveBundledRendererPath('fpr-app://bundle/index.html', root, allowlist))
      .toBe(path.join(root, 'index.html'))
    expect(resolveBundledRendererPath('fpr-app://bundle/assets/app-123.js', root, allowlist))
      .toBe(path.join(root, 'assets', 'app-123.js'))
    for (const url of [
      'fpr-app://bundle/',
      'fpr-app://bundle/assets',
      'fpr-app://bundle/unknown.js',
      'fpr-app://bundle/../index.html',
      'fpr-app://bundle/%2e%2e/index.html',
      'fpr-app://bundle/assets/%2e%2e/index.html',
      'fpr-app://bundle/assets%2f..%2findex.html',
      'fpr-app://bundle/assets\\app-123.js',
      'fpr-app://other/index.html',
      'fpr-app://bundle/index.html?path=C:/Users/user/data',
    ]) expect(resolveBundledRendererPath(url, root, allowlist), url).toBeNull()
  })
})
