import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readText = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Android platform foundation boundary', () => {
  it('keeps renderer capabilities narrow and uses an internal bundled SQLite repository', async () => {
    const [capabilities, cargo, platformClient, mobileClient] = await Promise.all([
      readText('src-tauri/capabilities/default.json'),
      readText('src-tauri/Cargo.toml'),
      readText('src/renderer/tauri/mobile-platform-client.ts'),
      readText('src/renderer/tauri/mobile-client.ts'),
    ])

    expect(JSON.parse(capabilities).permissions).toEqual(['core:default'])
    expect(capabilities).not.toMatch(/(?:sql|fs|http|stronghold|log):/i)
    expect(cargo).toContain('rusqlite = { version = "0.40", features = ["backup", "bundled"] }')
    expect(cargo).not.toContain('tauri-plugin-sql')
    expect(platformClient).not.toContain('@tauri-apps/plugin-sql')
    expect(platformClient).not.toContain('@tauri-apps/plugin-fs')
    expect(platformClient).not.toContain('@tauri-apps/plugin-http')
    expect(mobileClient).not.toMatch(/@tauri-apps\/plugin-(?:sql|fs|dialog|http)/)
  })

  it('excludes Android private data from platform backup', async () => {
    const manifest = await readText('src-tauri/gen/android/app/src/main/AndroidManifest.xml')

    expect(manifest).toContain('android:allowBackup="false"')
    expect(manifest).toContain('android:fullBackupContent="false"')
  })

  it('ships only the formal Android entry and does not retain prototype routes', async () => {
    const [entry, learningContract] = await Promise.all([
      readText('src/renderer/tauri/main.tsx'),
      readText('src/shared/mobile-learning.ts'),
    ])
    expect(entry).toContain('<MobileReadingApp />')
    expect(entry).not.toMatch(/(?:prototype|fixture|diagnostics|d0)/i)
    expect(learningContract).not.toMatch(/(?:D0LearningProbe|databasePath|filePath|absolutePath|sql\s*[:(]|https?:\/\/)/i)
  })
})
