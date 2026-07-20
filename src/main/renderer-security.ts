import path from 'node:path'

export const PRODUCTION_RENDERER_ENTRY = 'fpr-app://bundle/index.html'

export interface RendererIpcTrustInput {
  senderIsMainWindow: boolean
  frameIsMainFrame: boolean
  url: string
}

export function rendererEntryUrl(devServerUrl?: string): string {
  if (!devServerUrl) return PRODUCTION_RENDERER_ENTRY
  const url = new URL(devServerUrl)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('VITE_DEV_SERVER_URL 必须是无凭据、查询参数和片段的 HTTP(S) 入口')
  }
  return url.href
}

export function isTrustedRendererUrl(candidate: string, devServerUrl?: string): boolean {
  try {
    const expected = new URL(rendererEntryUrl(devServerUrl))
    const actual = new URL(candidate)
    return actual.protocol === expected.protocol
      && actual.username === ''
      && actual.password === ''
      && actual.hostname === expected.hostname
      && actual.port === expected.port
      && actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === ''
      && actual.hash === ''
  } catch {
    return false
  }
}

export function isTrustedRendererIpcSource(
  input: RendererIpcTrustInput,
  devServerUrl?: string,
): boolean {
  return input.senderIsMainWindow
    && input.frameIsMainFrame
    && isTrustedRendererUrl(input.url, devServerUrl)
}

export function resolveBundledRendererPath(
  requestUrl: string,
  rendererRoot: string,
  allowlist: ReadonlySet<string>,
): string | null {
  try {
    const prefix = 'fpr-app://bundle'
    if (!requestUrl.startsWith(prefix)) return null
    const rawPath = requestUrl.slice(prefix.length).split(/[?#]/, 1)[0]
    const url = new URL(requestUrl)
    if (url.protocol !== 'fpr-app:' || url.hostname !== 'bundle' || url.port
      || url.username || url.password || url.search || url.hash) return null
    const decoded = decodeURIComponent(rawPath)
    if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return null
    const segments = decoded.slice(1).split('/')
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
    const relative = segments.join('/')
    if (!allowlist.has(relative)) return null
    const root = path.resolve(rendererRoot)
    const resolved = path.resolve(root, ...segments)
    return resolved.startsWith(`${root}${path.sep}`) ? resolved : null
  } catch {
    return null
  }
}
