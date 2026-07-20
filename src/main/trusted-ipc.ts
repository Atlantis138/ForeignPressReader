import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererIpcSource } from './renderer-security'

export function createTrustedIpcMain(
  target: IpcMain,
  getMainWindow: () => BrowserWindow | null,
  devServerUrl?: string,
): Pick<IpcMain, 'handle'> {
  return {
    handle(channel, listener) {
      target.handle(channel, (event, ...args) => {
        assertTrustedIpcEvent(event, getMainWindow(), devServerUrl)
        return listener(event, ...args)
      })
    },
  }
}

function assertTrustedIpcEvent(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  devServerUrl?: string,
): void {
  const frame = event.senderFrame
  const trusted = window !== null
    && !window.isDestroyed()
    && isTrustedRendererIpcSource({
      senderIsMainWindow: event.sender === window.webContents,
      frameIsMainFrame: frame != null && frame === event.sender.mainFrame && frame.parent === null,
      url: frame?.url ?? '',
    }, devServerUrl)
  if (!trusted) throw new Error('拒绝来自未知页面或子 frame 的请求')
}
