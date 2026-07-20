import { BrowserWindow } from 'electron'
import { isTrustedRendererUrl, rendererEntryUrl } from './renderer-security'

export interface MainWindowOptions {
  preloadPath: string
  devServerUrl?: string
  onRendererGone(details: Electron.RenderProcessGoneDetails): void
  onUnresponsive(): void
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f6f3ed',
    title: '外刊阅读器',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('render-process-gone', (_event, details) => options.onRendererGone(details))
  window.on('unresponsive', options.onUnresponsive)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, options.devServerUrl)) event.preventDefault()
  })
  window.webContents.on('will-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, options.devServerUrl)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, options.devServerUrl)) event.preventDefault()
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  void window.loadURL(rendererEntryUrl(options.devServerUrl))
  return window
}
