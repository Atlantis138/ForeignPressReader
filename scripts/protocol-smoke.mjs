import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { LATEST_SCHEMA_VERSION } = require(path.join(projectRoot, 'dist-electron/main/migrations.js'))
const mode = process.argv[2]
const packagedExecutable = path.join(projectRoot, 'release', 'win-unpacked', '外刊阅读器.exe')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-reader-protocol-'))
const env = { ...process.env, READER_USER_DATA_PATH: userData }
delete env.VITE_DEV_SERVER_URL
let application

if (!['--source', '--packaged'].includes(mode)) {
  throw new Error('usage: node scripts/protocol-smoke.mjs --source|--packaged')
}
if (mode === '--packaged' && !fs.existsSync(packagedExecutable)) {
  throw new Error(`缺少发布目录：${packagedExecutable}`)
}

try {
  application = await electron.launch(mode === '--packaged'
    ? { executablePath: packagedExecutable, env }
    : { args: [projectRoot], cwd: projectRoot, env })
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const entry = 'fpr-app://bundle/index.html'
  if (page.url() !== entry) throw new Error(`生产 renderer 入口不正确：${page.url()}`)
  const result = await page.evaluate(async () => {
    const api = globalThis.readerApi
    if (!api) throw new Error('preload AppApi 未暴露')
    const status = await api.data.getStatus()
    const unknown = await fetch('fpr-app://bundle/unknown.js')
    const popup = window.open('https://example.com', '_blank')
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<p>untrusted child</p>'
    document.body.append(iframe)
    await new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }))
    const childHasApi = typeof iframe.contentWindow?.readerApi !== 'undefined'
    iframe.remove()
    location.assign('https://example.com/blocked')
    return {
      schemaVersion: status.schemaVersion,
      unknownStatus: unknown.status,
      popupDenied: popup === null,
      childHasApi,
    }
  })
  await page.waitForTimeout(300)
  if (page.url() !== entry) throw new Error(`非法导航未被阻止：${page.url()}`)
  if (result.schemaVersion !== LATEST_SCHEMA_VERSION || result.unknownStatus !== 404
    || !result.popupDenied || result.childHasApi) {
    throw new Error(`renderer 安全探针失败：${JSON.stringify(result)}`)
  }
  console.log(JSON.stringify({ mode, entry: page.url(), ...result }))
} finally {
  await application?.close().catch(() => undefined)
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
