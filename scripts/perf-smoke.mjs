import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { _electron: electron } = require('playwright')
const { SqliteApplicationRepository } = require('../dist-electron/main/database.js')
const { EpubImporter } = require('../dist-electron/main/epub-importer.js')
const { LibraryService } = require('../dist-electron/main/library-service.js')
const { PublicationFormatRegistry } = require('../dist-electron/core/importing/publication-formats.js')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = path.join(projectRoot, 'release', 'win-unpacked', '外刊阅读器.exe')
const artifactRoot = path.join(projectRoot, 'test-artifacts', 'perf')
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-reader-perf-'))
const epubPath = path.join(testRoot, 'performance.epub')
const samples = []
let application = null

if (process.platform !== 'win32') throw new Error('perf:smoke 当前只支持 Windows')
if (!fs.existsSync(executablePath)) throw new Error(`缺少发布目录：${executablePath}`)

try {
  fs.writeFileSync(epubPath, await createPerformanceEpub(36))
  const importComparison = await compareImportModes(epubPath)
  await seedData(testRoot, epubPath)
  await installSyntheticDictionary(testRoot)

  application = await electron.launch({
    executablePath,
    env: { ...process.env, READER_USER_DATA_PATH: testRoot },
  })
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.book-card:not(.add-card), .book-list-title').first().waitFor()

  samples.push(await sample(application, page, 'cold-library'))
  await openArticle(page, 0)
  samples.push(await sample(application, page, 'article'))

  await switchArea(page, '词典')
  await page.getByLabel('搜索词典').fill('America')
  await page.locator('.dictionary-results > button').first().waitFor({ timeout: 10_000 })
  samples.push(await sample(application, page, 'dictionary-active'))

  await switchArea(page, '背单词')
  await page.locator('.study-page, .study-session').first().waitFor()
  await switchArea(page, '设置')
  await page.locator('.settings-page').waitFor()
  await switchArea(page, '我的书库')
  await page.locator('.reader-article').waitFor()
  samples.push(await sample(application, page, 'workspace-cycle'))

  for (let index = 0; index < 30; index += 1) {
    await page.locator('.reader-toolbar .back-button').click()
    await page.locator('.toc-section button').first().waitFor()
    const articleCount = await page.locator('.toc-section button').count()
    await page.locator('.toc-section button').nth((index + 1) % articleCount).click()
    await page.locator('.reader-article').waitFor()
    if ((index + 1) % 10 === 0) samples.push(await sample(application, page, `article-switch-${index + 1}`))
  }

  await page.locator('.reader-toolbar .back-button').click()
  await page.locator('.contents-page > .back-button').click()
  await page.locator('.library-page').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(2_000)
  samples.push(await sample(application, page, 'post-navigation-gc'))

  await application.evaluate(({ app }) => { app.getAppMetrics() })
  await page.waitForTimeout(30_000)
  const idle = await sample(application, page, 'idle-30s')
  samples.push(idle)

  const byStage = Object.fromEntries(samples.map((entry) => [entry.stage, entry]))
  const heapGrowth = byStage['post-navigation-gc'].renderer.heapUsedMiB - byStage['cold-library'].renderer.heapUsedMiB
  const switchGrowth = percentGrowth(byStage['article-switch-20'].privateMiB, byStage['article-switch-30'].privateMiB)
  const checks = [
    check('冷启动私有提交 ≤ 260 MiB', byStage['cold-library'].privateMiB <= 260, byStage['cold-library'].privateMiB),
    check('普通文章私有提交 ≤ 330 MiB', byStage.article.privateMiB <= 330, byStage.article.privateMiB),
    check('词典活跃私有提交 ≤ 390 MiB', byStage['dictionary-active'].privateMiB <= 390, byStage['dictionary-active'].privateMiB),
    check('回收后 renderer 堆增长 ≤ 10 MiB', heapGrowth <= 10, round(heapGrowth)),
    check('最后十次切换私有提交增长 ≤ 20%', switchGrowth <= 20, round(switchGrowth)),
    check('闲置 CPU < 单核 1%', idle.cpuPercent < 1, idle.cpuPercent),
    check('EPUB 文件快速路径峰值降低 ≥ 30%', importComparison.reductionPercent >= 30, importComparison.reductionPercent),
  ]
  const report = {
    generatedAt: new Date().toISOString(),
    executablePath,
    thresholds: { coldMiB: 260, articleMiB: 330, dictionaryMiB: 390, heapGrowthMiB: 10, switchGrowthPercent: 20, idleCpuPercent: 1 },
    samples,
    importComparison,
    checks,
    passed: checks.every((item) => item.passed),
  }
  fs.mkdirSync(artifactRoot, { recursive: true })
  const outputPath = path.join(artifactRoot, `perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  printReport(report, outputPath)
  if (!report.passed) process.exitCode = 1
} finally {
  await application?.close().catch(() => undefined)
  fs.rmSync(testRoot, { recursive: true, force: true })
}

async function seedData(root, sourcePath) {
  const database = await SqliteApplicationRepository.open(root, 'performance')
  try {
    const formats = new PublicationFormatRegistry([{
      id: 'epub', name: 'EPUB 电子刊物', extensions: ['epub'], maxBytes: 500 * 1024 * 1024,
      importer: new EpubImporter(),
    }])
    await new LibraryService(database, formats, root).importFile(sourcePath)
  } finally {
    database.close()
  }
}

async function installSyntheticDictionary(root) {
  const sourceRoot = path.join(root, 'dictionary-source')
  const stagingRoot = path.join(root, 'dictionary-staging')
  const dictionariesRoot = path.join(root, 'dictionaries')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(dictionariesRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'ecdict.csv'), [
    'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail',
    'America,əˈmerɪkə,a country,n. 美国,n:100,5,1,,100,100,,',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'lemma.en.txt'), '', 'utf8')
  await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(projectRoot, 'dist-electron', 'main', 'dictionary-worker.js'), {
      workerData: { mode: 'local', stagingRoot, csvPath: path.join(sourceRoot, 'ecdict.csv'), lemmaPath: path.join(sourceRoot, 'lemma.en.txt') },
    })
    worker.on('message', (message) => {
      if (message.type === 'done') resolve()
      if (message.type === 'error') reject(new Error(String(message.message)))
    })
    worker.on('error', reject)
  })
  fs.renameSync(path.join(stagingRoot, 'ecdict-base.sqlite'), path.join(dictionariesRoot, 'ecdict-base.sqlite'))
}

async function openArticle(page, index) {
  await page.locator('.book-card:not(.add-card), .book-list-title').first().click()
  await page.locator('.toc-section button').first().waitFor()
  await page.locator('.toc-section button').nth(index).click()
  await page.locator('.reader-article').waitFor()
  await page.waitForTimeout(500)
}

async function switchArea(page, label) {
  await page.locator('.app-sidebar nav button').filter({ hasText: label }).click()
  await page.waitForTimeout(300)
}

async function sample(app, page, stage) {
  const processes = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name ?? null,
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetMiB: metric.memory.workingSetSize / 1024,
    privateMiB: (metric.memory.privateBytes ?? 0) / 1024,
  })))
  const session = await page.context().newCDPSession(page)
  const [heap, dom] = await Promise.all([
    session.send('Runtime.getHeapUsage'),
    session.send('Memory.getDOMCounters'),
  ])
  return {
    stage,
    capturedAt: new Date().toISOString(),
    privateMiB: round(processes.reduce((sum, item) => sum + item.privateMiB, 0)),
    workingSetMiB: round(processes.reduce((sum, item) => sum + item.workingSetMiB, 0)),
    cpuPercent: round(processes.reduce((sum, item) => sum + item.cpuPercent, 0)),
    processes: processes.map((item) => ({ ...item, cpuPercent: round(item.cpuPercent), workingSetMiB: round(item.workingSetMiB), privateMiB: round(item.privateMiB) })),
    renderer: {
      heapUsedMiB: round(heap.usedSize / 1024 / 1024),
      heapTotalMiB: round(heap.totalSize / 1024 / 1024),
      documents: dom.documents,
      domNodes: dom.nodes,
      eventListeners: dom.jsEventListeners,
    },
  }
}

async function createPerformanceEpub(articleCount) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
  const spine = []
  const nav = []
  for (let index = 0; index < articleCount; index += 1) {
    manifest.push(`<item id="a${index}" href="article-${index}.xhtml" media-type="application/xhtml+xml"/><item id="i${index}" href="image-${index}.jpg" media-type="image/jpeg"/>`)
    spine.push(`<itemref idref="a${index}"/>`)
    nav.push(`<li><a href="article-${index}.xhtml">Performance article ${index + 1}</a></li>`)
    const paragraphs = Array.from({ length: 12 }, (_, paragraph) => `<p>America appears in performance article ${index + 1}, paragraph ${paragraph + 1}. This sufficiently long editorial sentence exercises lookup token rendering, reading layout, search indexing and memory reclamation while navigating between many articles.</p>`).join('')
    zip.file(`EPUB/article-${index}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Performance article ${index + 1}</title></head><body><h1>Performance article ${index + 1}</h1><img src="image-${index}.jpg" alt="Performance illustration"/>${paragraphs}</body></html>`)
    zip.file(`EPUB/image-${index}.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { compression: 'STORE' })
  }
  for (let index = 0; index < 8; index += 1) {
    const name = `bulk-${index}.jpg`
    manifest.push(`<item id="bulk${index}" href="${name}" media-type="image/jpeg"/>`)
    zip.file(`EPUB/${name}`, pseudoRandomBytes(4 * 1024 * 1024, index + 1), { compression: 'STORE' })
  }
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Performance Weekly</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`)
  zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>${nav.join('')}</ol></nav></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function compareImportModes(sourcePath) {
  const probe = path.join(projectRoot, 'scripts', 'import-memory-probe.mjs')
  const legacy = await runImportProbe(probe, 'bytes', sourcePath)
  const file = await runImportProbe(probe, 'file', sourcePath)
  return {
    sourceMiB: round(fs.statSync(sourcePath).size / 1024 / 1024),
    legacyPeakDeltaMiB: legacy.peakDeltaMiB,
    filePeakDeltaMiB: file.peakDeltaMiB,
    reductionPercent: round(legacy.peakDeltaMiB > 0
      ? ((legacy.peakDeltaMiB - file.peakDeltaMiB) / legacy.peakDeltaMiB) * 100
      : 0),
  }
}

function runImportProbe(script, mode, sourcePath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `foreign-reader-import-${mode}-`))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, mode, sourcePath, root], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => {
      fs.rmSync(root, { recursive: true, force: true })
      if (code !== 0) { reject(new Error(`导入内存探针失败（${mode}）：${stderr || stdout}`)); return }
      try { resolve(JSON.parse(stdout.trim())) }
      catch (error) { reject(new Error(`导入内存探针输出无效（${mode}）：${error instanceof Error ? error.message : String(error)}`)) }
    })
  })
}

function pseudoRandomBytes(length, seed) {
  const value = Buffer.allocUnsafe(length)
  let state = seed >>> 0
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    value[index] = state >>> 24
  }
  return value
}

function check(name, passed, actual) { return { name, passed, actual } }
function round(value) { return Math.round(value * 100) / 100 }
function percentGrowth(before, after) { return before > 0 ? ((after - before) / before) * 100 : 0 }

function printReport(report, outputPath) {
  console.table(report.samples.map((entry) => ({
    stage: entry.stage,
    privateMiB: entry.privateMiB,
    workingSetMiB: entry.workingSetMiB,
    cpuPercent: entry.cpuPercent,
    heapMiB: entry.renderer.heapUsedMiB,
    domNodes: entry.renderer.domNodes,
  })))
  console.table(report.checks.map((item) => ({ check: item.name, passed: item.passed, actual: item.actual })))
  console.log(`性能报告：${outputPath}`)
}
