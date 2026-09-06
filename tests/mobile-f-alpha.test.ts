import { readFile } from 'node:fs/promises'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  MOBILE_PLATFORM_SERVICES_CONTRACT_VERSION,
  type MobileDataClient,
  type MobileDeveloperClient,
  type MobileStorageClient,
} from '../src/shared/mobile-platform-services'
import {
  TauriMobileDataClient,
  TauriMobileDeveloperClient,
  TauriMobileStorageClient,
} from '../src/renderer/tauri/mobile-platform-client'
import { normalizePlatformError } from '../src/renderer/tauri/platform-error'
import { readMobileAppSource } from './mobile-source'

const readText = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')

describe('Android stage F Alpha boundary', () => {
  it('normalizes native failures without echoing arbitrary exception text', () => {
    expect(normalizePlatformError(new Error('D:\\private\\secret.txt'))).toEqual({
      code: 'internal', message: '原生命令执行失败。', retryable: true,
    })
    expect(normalizePlatformError({ code: 'invalidInput', message: '输入无效。', retryable: false })).toEqual({
      code: 'invalidInput', message: '输入无效。', retryable: false,
    })
  })

  it('keeps data, storage, and developer clients behind versioned logical commands', async () => {
    expect(MOBILE_PLATFORM_SERVICES_CONTRACT_VERSION).toBe(1)
    expectTypeOf<TauriMobileDataClient>().toMatchTypeOf<MobileDataClient>()
    expectTypeOf<TauriMobileStorageClient>().toMatchTypeOf<MobileStorageClient>()
    expectTypeOf<TauriMobileDeveloperClient>().toMatchTypeOf<MobileDeveloperClient>()

    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args })
      return undefined as T
    }
    const storage = new TauriMobileStorageClient(invoke)
    const developer = new TauriMobileDeveloperClient(invoke)
    await storage.clearAiTextCache('CLEAR_AI_TEXT_CACHE')
    await storage.openAppStorageSettings()
    await developer.setEnabled(true)
    await developer.factoryReset('恢复出厂设置')
    expect(calls).toEqual([
      { command: 'clear_mobile_ai_text_cache', args: { confirmationToken: 'CLEAR_AI_TEXT_CACHE' } },
      { command: 'open_mobile_app_storage_settings', args: undefined },
      { command: 'set_mobile_developer_enabled', args: { enabled: true } },
      { command: 'factory_reset_mobile', args: { confirmationText: '恢复出厂设置' } },
    ])
  })

  it('matches the Windows settings surface while keeping developer access session-only', async () => {
    const [app, shell, entry, packageJson] = await Promise.all([
      readMobileAppSource(),
      readText('src/renderer/tauri/mobile-shell-model.ts'),
      readText('src/renderer/tauri/main.tsx'),
      readText('package.json'),
    ])
    for (const label of ['备份管理', '存储空间', '跨设备同步', '本地数据目录', '开发与调试', '学习调试', '日志模式', '恢复出厂设置']) {
      expect(app).toContain(label)
    }
    expect(app).toContain('settingsTitleTaps.current.length >= 10')
    expect(app).toContain('now - value <= 5_000')
    expect(shell).toContain("'fpr.android.shell.v1'")
    expect(shell).toContain("route.section === 'developer'")
    expect(entry).not.toMatch(/(?:prototype|fixture|diagnostics|d0)/i)
    expect(JSON.parse(packageJson).version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('retains immutable baselines alongside the current versioned contracts and rejects Demo backups', async () => {
    const [database, portable, desktopPortable, sync, contentIds] = await Promise.all([
      readText('src-tauri/src/database.rs'),
      readText('src-tauri/src/mobile_portable.rs'),
      readText('src/main/portable-data-service.ts'),
      readText('src/core/sync-model.ts'),
      readText('src/core/epub-importer.ts'),
    ])
    expect(database).toContain('formal-v1')
    expect(database).toContain('LATEST_SCHEMA_VERSION: i64 = 4')
    expect(portable).toContain('FORMAT_VERSION: i64 = 4')
    expect(desktopPortable).toContain('const FORMAT_VERSION = 4')
    expect(portable).toContain('rejects_demo_and_future_manifests')
    expect(sync).toContain('LEGACY_SYNC_MODEL_VERSION = 1 as const')
    expect(sync).toContain('PREVIOUS_SYNC_MODEL_VERSION = 2 as const')
    expect(sync).toContain('SYNC_MODEL_VERSION = 4 as const')
    expect(contentIds).toContain('CONTENT_ID_VERSION = 2')
    const paths = [
      'publication-lifecycle', 'settings', 'reading-positions', 'user-lexemes', 'lexeme-examples',
      'vocabulary-sources', 'saved-contexts', 'study-plans', 'study-plan-sources', 'study-plan-origins',
      'study-plan-exclusions', 'scheduler-profiles', 'review-cards', 'review-events',
      'reinforcement-events', 'review-suspensions', 'study-progress-state', 'study-lexeme-resets',
    ]
    for (const name of paths) {
      const path = name === 'settings' ? 'data/settings.json' : `data/${name}.ndjson`
      expect(portable).toContain(path)
      expect(desktopPortable).toContain(path)
    }
  })
})
