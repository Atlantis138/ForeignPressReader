import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('portable core boundary', () => {
  it('uses the formal product identity and an isolated user data directory', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      name: string
      version: string
      build: { appId: string; productName: string; win: { artifactName: string } }
    }
    expect(packageJson.name).toBe('foreign-press-reader')
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(packageJson.build.appId).toBe('com.local.foreignpressreader')
    expect(packageJson.build.productName).toBe('外刊阅读器')
    expect(packageJson.build.win.artifactName).toBe('ForeignPressReader-${version}-Setup.exe')

    const main = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    expect(main).toContain("app.setName('外刊阅读器')")
    expect(main).toContain("path.join(app.getPath('appData'), '外刊阅读器')")
    expect(main).not.toContain('外刊阅读器 Demo')
  })

  it('does not import platform modules or expose platform binary/url types', () => {
    const root = path.join(process.cwd(), 'src', 'core')
    const files = walk(root).filter((file) => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"](?:node:|electron)/)
      expect(source, file).not.toMatch(/\bBuffer\b/)
      expect(source, file).not.toContain('reader-asset://')
    }
  })

  it('routes every outbound HTTP request through one Electron system-proxy adapter', () => {
    const sourceRoot = path.join(process.cwd(), 'src')
    const adapterPath = path.join(sourceRoot, 'main', 'electron-network-client.ts')
    const portPath = path.join(sourceRoot, 'core', 'network-client.ts')
    const adapter = fs.readFileSync(adapterPath, 'utf8')
    const main = fs.readFileSync(path.join(sourceRoot, 'main', 'index.ts'), 'utf8')

    expect(adapter).toContain("const requestInit: RequestInit = init?.cache ? init : { ...init, cache: 'no-store' }")
    expect(adapter).toContain('await net.fetch(input, requestInit)')
    expect(adapter).toContain('forceReloadProxyConfig()')
    expect(main).toContain('const network = new ElectronNetworkClient(diagnosticLogger)')
    expect(main).toContain('await network.initialize()')
    expect(main).toMatch(/new SpeechSynthesisService\([\s\S]*?speechProviders,[\s\S]*?network/)
    expect(main).toMatch(/new TranslationService\([\s\S]*?network, translationProviders\)/)
    expect(main).toMatch(/new DictionaryService\([\s\S]*?network,\s*\(texts\)=>translator\.translateTexts\(texts\),\s*\{[\s\S]*?translator\.completeJson\(systemPrompt, payload\)[\s\S]*?\}\)/)

    for (const [relative, call] of [
      [['core', 'translation-service.ts'], 'this.network.fetch('],
      [['main', 'speech-provider-adapters.ts'], 'network.fetch('],
      [['main', 'dictionary-service.ts'], 'network.fetch('],
      [['main', 'dictionary-installer.ts'], 'this.network.fetch('],
    ] as const) {
      expect(fs.readFileSync(path.join(sourceRoot, ...relative), 'utf8'), relative.join('/'))
        .toContain(call)
    }

    for (const file of walk(sourceRoot).filter((candidate) => (
      candidate.endsWith('.ts') && candidate !== adapterPath && candidate !== portPath
    ))) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/(?:^|[^\w.])fetch\s*\(/m)
    }
  })

  it('keeps Electron services behind narrow database capability ports', () => {
    const mainRoot = path.join(process.cwd(), 'src', 'main')
    const allowed = new Set(['database.ts', 'database-ports.ts', 'index.ts', 'ipc-registration.ts'])
    for (const file of fs.readdirSync(mainRoot).filter((name) => name.endsWith('.ts'))) {
      if (allowed.has(file)) continue
      const source = fs.readFileSync(path.join(mainRoot, file), 'utf8')
      expect(source, file).not.toMatch(/from\s+['"]\.\/database['"]/)
    }
  })
})

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}
