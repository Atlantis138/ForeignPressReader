import { net, session } from 'electron'
import type { NetworkClient } from '../core/network-client'
import type { DiagnosticLogger } from './diagnostic-logger'

/**
 * The single desktop HTTP(S) adapter. Electron's network service follows the
 * operating-system proxy configuration, including PAC and authenticated proxy
 * handling supported by Chromium.
 */
export class ElectronNetworkClient implements NetworkClient {
  constructor(private readonly logger?: DiagnosticLogger) {}
  async initialize(): Promise<void> {
    try {
      await session.defaultSession.forceReloadProxyConfig()
    } catch {
      // Chromium can still resolve its proxy lazily; proxy refresh must not
      // prevent offline/local-only use of the application.
    }
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    const started = Date.now()
    const host = safeHost(input)
    try {
      const requestInit: RequestInit = init?.cache ? init : { ...init, cache: 'no-store' }
      const response = await net.fetch(input, requestInit)
      void this.logger?.log('info', 'network', 'request', {
        host, method: String(init?.method ?? 'GET').toUpperCase(), status: response.status,
        durationMs: Date.now() - started,
      })
      return response
    } catch (error) {
      void this.logger?.log('error', 'network', 'transport-error', {
        host, method: String(init?.method ?? 'GET').toUpperCase(), durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'network error',
      })
      throw error
    }
  }

  reloadProxyConfiguration(): Promise<void> {
    return session.defaultSession.forceReloadProxyConfig()
  }

  resolveProxy(url: string): Promise<string> {
    return session.defaultSession.resolveProxy(url)
  }
}

function safeHost(input: string): string {
  try { return new URL(input).hostname.slice(0, 200) } catch { return 'invalid-host' }
}
