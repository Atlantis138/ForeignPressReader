import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { resolveBundledRendererPath } from './renderer-security'

export function registerRendererProtocol(rendererRoot: string): void {
  const allowlist = rendererAllowlist(rendererRoot)
  if (!allowlist.has('index.html')) throw new Error('生产 renderer 缺少 index.html')
  protocol.handle('fpr-app', async (request) => {
    if (request.method !== 'GET') return response('Method not allowed', 405)
    const filePath = resolveBundledRendererPath(request.url, rendererRoot, allowlist)
    if (!filePath) return response('Not found', 404)
    try {
      const source = await net.fetch(pathToFileURL(filePath).toString(), { cache: 'no-store' })
      const headers = new Headers(source.headers)
      headers.set('Cache-Control', 'no-store, max-age=0')
      headers.set('Pragma', 'no-cache')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(source.body, { status: source.status, statusText: source.statusText, headers })
    } catch {
      return response('Not found', 404)
    }
  })
}

function rendererAllowlist(rendererRoot: string): Set<string> {
  const root = path.resolve(rendererRoot)
  const result = new Set<string>()
  const addFile = (filePath: string) => {
    if (!fs.statSync(filePath).isFile()) return
    result.add(path.relative(root, filePath).split(path.sep).join('/'))
  }
  const index = path.join(root, 'index.html')
  if (fs.existsSync(index)) addFile(index)
  const assets = path.join(root, 'assets')
  if (fs.existsSync(assets)) {
    for (const entry of fs.readdirSync(assets, { withFileTypes: true })) {
      if (entry.isFile()) addFile(path.join(assets, entry.name))
    }
  }
  return result
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}
