import { readFile } from 'node:fs/promises'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  MOBILE_ONLINE_SERVICES_CONTRACT_VERSION,
  type MobileSpeechClient,
  type MobileTranslationClient,
} from '../src/shared/mobile-online-services'
import {
  TauriMobileSpeechClient,
  TauriMobileTranslationClient,
} from '../src/renderer/tauri/mobile-online-client'

const readText = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')

describe('Android E4 online and system service boundary', () => {
  it('forwards explicit retranslation without forcing ordinary cache reads', async () => {
    const calls: unknown[] = []
    const client = new TauriMobileTranslationClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]); return undefined as T
    })
    await client.translateArticle('article')
    await client.translateArticle('article', true)
    expect(calls).toEqual([
      ['translate_mobile_article', { articleId: 'article', force: false }],
      ['translate_mobile_article', { articleId: 'article', force: true }],
    ])
  })
  it('connects contents, custom models and the selected connection test through native commands', async () => {
    const calls: unknown[] = []
    const client = new TauriMobileTranslationClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]); return undefined as T
    })
    const preferences = { providerId: 'openai', modelId: 'custom/model:1' }
    await client.getContents('publication')
    await client.translateContents('publication', true)
    await client.cancelContents('publication')
    await client.deleteModel(preferences)
    await client.testConnection(preferences)
    expect(calls).toEqual([
      ['get_mobile_contents_translation', { publicationId: 'publication' }],
      ['translate_mobile_contents', { publicationId: 'publication', force: true }],
      ['cancel_mobile_translation', { articleId: 'publication' }],
      ['delete_mobile_translation_model', { preferences }],
      ['get_mobile_translation_settings', undefined],
      ['test_mobile_translation_connection', { preferences }],
    ])
  })

  it('keeps renderer clients on versioned logical commands', async () => {
    expect(MOBILE_ONLINE_SERVICES_CONTRACT_VERSION).toBe(1)
    expectTypeOf<TauriMobileTranslationClient>().toMatchTypeOf<MobileTranslationClient>()
    expectTypeOf<TauriMobileSpeechClient>().toMatchTypeOf<MobileSpeechClient>()

    const calls: string[] = []
    const invoke = async <T>(command: string): Promise<T> => { calls.push(command); return undefined as T }
    const speech = new TauriMobileSpeechClient(invoke)
    await speech.pause(); await speech.resume(); await speech.stop()
    expect(calls).toEqual([
      'pause_mobile_speech', 'resume_mobile_speech', 'stop_mobile_speech',
    ])
  })

  it('registers the learning service commands', async () => {
    const commands = (await Promise.all([
      readText('src-tauri/src/commands/dictionary.rs'),
      readText('src-tauri/src/commands/study.rs'),
    ])).join('\n')
    for (const command of [
      'hydrate_mobile_study_examples',
      'get_mobile_study_debug_state',
      'set_mobile_study_developer_mode',
      'delete_mobile_study_plan',
      'reset_mobile_study_progress',
      'force_mobile_next_study_day',
    ]) expect(commands).toContain(command)
  })

  it('does not expose provider URLs, local paths, SQL, or native network primitives', async () => {
    const [contract, client] = await Promise.all([
      readText('src/shared/mobile-online-services.ts'),
      readText('src/renderer/tauri/mobile-online-client.ts'),
    ])
    expect(contract).not.toMatch(/https?:\/\/|databasePath|absolutePath|filePath|\bsql\b|networkExecute/i)
    expect(client).not.toMatch(/https?:\/\/|@tauri-apps\/plugin-(?:http|fs|sql)/i)
  })

  it('ships a restrictive CSP and a diagnostics-only FileProvider path', async () => {
    const [configText, filePaths, manifest, pluginBuild] = await Promise.all([
      readText('src-tauri/tauri.conf.json'),
      readText('src-tauri/gen/android/app/src/main/res/xml/file_paths.xml'),
      readText('src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
      readText('src-tauri/plugins/fpr-platform/build.rs'),
    ])
    const config = JSON.parse(configText)
    expect(config.app.security.csp).toContain("default-src 'self'")
    expect(config.app.security.csp).toContain("object-src 'none'")
    expect(config.app.security.csp).toContain('img-src \'self\' reader-asset: http://reader-asset.localhost')
    expect(config.app.security.csp).not.toContain('https:')
    expect(filePaths).toContain('path="diagnostics/"')
    expect(filePaths).not.toMatch(/external-path|path="\."/)
    expect(manifest).toContain('android:allowBackup="false"')
    expect(pluginBuild).toContain('"system_tts_capability"')
  })

  it('keeps secret values and article text out of diagnostic metadata', async () => {
    const [maintenance, logger] = await Promise.all([
      readText('src-tauri/src/mobile_maintenance.rs'),
      readText('src-tauri/src/diagnostic_logger.rs'),
    ])
    expect(maintenance).toContain('fpr-diagnostics-v1')
    expect(maintenance).not.toMatch(/secret_load|translation_key|article\.text/i)
    expect(logger).toContain('"authorization"')
    expect(logger).toContain('"body"')
    expect(logger).toContain('[redacted]')
  })
})
