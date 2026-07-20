import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { SqliteApplicationRepository } = require('../dist-electron/main/database.js')
const { EpubImporter } = require('../dist-electron/main/epub-importer.js')
const { LibraryService } = require('../dist-electron/main/library-service.js')
const { PublicationFormatRegistry } = require('../dist-electron/core/importing/publication-formats.js')

const [mode, sourcePath, root] = process.argv.slice(2)
if (!['bytes', 'file'].includes(mode) || !sourcePath || !root) throw new Error('用法：import-memory-probe.mjs <bytes|file> <source> <root>')

const workerImporter = new EpubImporter()
const importer = mode === 'file'
  ? workerImporter
  : {
      parse: async (data) => {
        // Reproduce the pre-fast-path flow for an apples-to-apples benchmark:
        // the main process retained the file Buffer, workerData cloned it, the
        // worker made another Uint8Array, and postMessage cloned every asset.
        const workerDataClone = Uint8Array.from(data)
        const result = await workerImporter.parse(workerDataClone)
        const originalAssets = result.assets
        const clonedAssets = new Map([...originalAssets].map(([name, value]) => [name, Uint8Array.from(value)]))
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { ...result, assets: clonedAssets }
      },
      cancel: () => workerImporter.cancel(),
    }
const formats = new PublicationFormatRegistry([{
  id: 'epub', name: 'EPUB 电子刊物', extensions: ['epub'], maxBytes: 500 * 1024 * 1024,
  importer,
}])
const baseline = process.memoryUsage().rss
let peak = baseline
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
const database = await SqliteApplicationRepository.open(path.join(root, 'data'), 'performance-probe')
try {
  await new LibraryService(database, formats, path.join(root, 'data')).importFile(sourcePath)
  peak = Math.max(peak, process.memoryUsage().rss)
} finally {
  clearInterval(sampler)
  database.close()
}

process.stdout.write(JSON.stringify({
  mode,
  baselineMiB: round(baseline / 1024 / 1024),
  peakMiB: round(peak / 1024 / 1024),
  peakDeltaMiB: round((peak - baseline) / 1024 / 1024),
}))

function round(value) { return Math.round(value * 100) / 100 }
