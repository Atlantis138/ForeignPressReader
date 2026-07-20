import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  clearCache: vi.fn(async () => undefined),
  clearCodeCaches: vi.fn(async () => undefined),
  clearData: vi.fn(async () => undefined),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  session: { defaultSession: { clearCache: electron.clearCache, clearCodeCaches: electron.clearCodeCaches, clearData: electron.clearData } },
  shell: { openPath: vi.fn(async () => '') },
}))

import { SqliteApplicationRepository } from '../src/main/database'
import { SpeechAudioCache } from '../src/main/speech-audio-cache'
import { DiagnosticLogger } from '../src/main/diagnostic-logger'
import { StorageService } from '../src/main/storage-service'
import { isSafeResetTarget } from '../src/main/factory-reset-helper'
import type { SpeechSynthesisRequest } from '../src/shared/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('cross-provider speech cache', () => {
  it('isolates providers, reuses hits, hides text and prunes by global LRU size', async () => {
    const root = temporaryRoot()
    const cache = new SpeechAudioCache(root, 20)
    let produced = 0
    const google = request('google', 'standard', 'en-US-Standard-C', 'Private article sentence')
    const minimax = request('minimax', 'speech-2.8-turbo', 'English_expressive_narrator', 'Private article sentence')
    const produce = async () => {
      produced += 1
      const bytes = new Uint8Array(10).fill(produced)
      bytes.set([0x49, 0x44, 0x33])
      return { bytes, mimeType: 'audio/mpeg' as const }
    }
    await cache.getOrCreate(google, produce)
    await cache.getOrCreate(google, produce)
    const googleFiles = fs.readdirSync(path.join(root, 'app-cache', 'speech', 'google'))
    expect(googleFiles.join(' ')).not.toContain('Private')
    fs.writeFileSync(path.join(root, 'app-cache', 'speech', 'google', googleFiles[0]), Buffer.from('not an mp3'))
    await cache.getOrCreate(google, produce)
    expect(produced).toBe(2)
    await cache.getOrCreate(minimax, produce)
    expect(produced).toBe(3)
    expect(await cache.size()).toBe(20)
    await cache.getOrCreate({ ...minimax, voiceId: 'English_CalmWoman' }, produce)
    expect(await cache.size()).toBeLessThanOrEqual(20)
    expect(produced).toBe(4)
    expect(await cache.clear()).toBeGreaterThan(0)
    expect(await cache.size()).toBe(0)
  })
})

describe('storage classification and clearing', () => {
  it('separates resources, user data and caches without deleting user settings', async () => {
    const root = temporaryRoot()
    const database = await SqliteApplicationRepository.open(root, 'test')
    fs.mkdirSync(path.join(root, 'library', 'pub_test'), { recursive: true })
    fs.writeFileSync(path.join(root, 'library', 'pub_test', 'source.epub'), Buffer.alloc(100))
    fs.mkdirSync(path.join(root, 'dictionaries'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dictionaries', 'ecdict.sqlite'), Buffer.alloc(200))
    const speech = new SpeechAudioCache(root)
    await speech.getOrCreate(request('google', 'standard', 'en-US-Standard-C', 'Cache me'), async () => ({
      bytes: Uint8Array.from([0x49, 0x44, 0x33, ...new Uint8Array(27)]), mimeType: 'audio/mpeg',
    }))
    const db = database.getConnection()
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare("INSERT INTO translations VALUES('block_cache','hash','zh-CN','model','prompt','译文',?)").run(new Date().toISOString())
    db.prepare("INSERT INTO context_definitions VALUES('cache','lex','word','word',NULL,'block','sentence','dict','model','prompt','{}',?)").run(new Date().toISOString())
    db.exec('PRAGMA foreign_keys=ON')
    const service = new StorageService(database, root, speech, () => true)
    const report = await service.scan()
    expect(report.packaged).toBe(false)
    expect(report.categories.find(item => item.id === 'resources')!.bytes).toBeGreaterThan(250)
    expect(report.categories.find(item => item.id === 'cache')!.bytes).toBeGreaterThan(30)
    await service.clearSafeCache()
    expect(electron.clearCache).toHaveBeenCalled()
    expect(electron.clearData).toHaveBeenCalledWith({ dataTypes: ['cache'] })
    expect(db.prepare('SELECT COUNT(*) count FROM translations').get()).toEqual({ count: 1 })
    await service.clearAiTextCache('CLEAR_AI_TEXT_CACHE')
    expect(db.prepare('SELECT COUNT(*) count FROM translations').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) count FROM context_definitions').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) count FROM settings WHERE key='reader.preferences'").get()).toEqual({ count: 0 })
    database.close()
  })
})

describe('diagnostic safety', () => {
  it('stays off by default, redacts secrets, rotates and clears logs', async () => {
    const root = temporaryRoot()
    const logger = new DiagnosticLogger(root, 120, 2)
    await logger.log('info', 'test', 'disabled', { error: 'should not exist' })
    expect((await logger.stats()).files).toBe(0)
    logger.setEnabled(true)
    for (let index = 0; index < 8; index += 1) {
      await logger.log('error', 'network', 'failed', {
        error: `Bearer secret-value-${index} https://example.com/private?q=secret`,
        body: 'private article text',
      })
    }
    const stats = await logger.stats()
    expect(stats.files).toBeLessThanOrEqual(2)
    const content = fs.readdirSync(logger.directory).map(name => fs.readFileSync(path.join(logger.directory, name), 'utf8')).join('')
    expect(content).not.toContain('secret-value')
    expect(content).not.toContain('private article text')
    expect(content).toContain('[redacted]')
    await logger.clear()
    expect((await logger.stats()).bytes).toBe(0)
  })

  it('rejects reset targets that could remove the program, drive or home', () => {
    expect(isSafeResetTarget('C:\\', 'C:\\Program Files\\Reader', 'C:\\Users\\test')).toBe(false)
    expect(isSafeResetTarget('C:\\Program Files\\Reader', 'C:\\Program Files\\Reader', 'C:\\Users\\test')).toBe(false)
    expect(isSafeResetTarget('C:\\Users\\test', 'C:\\Program Files\\Reader', 'C:\\Users\\test')).toBe(false)
    expect(isSafeResetTarget('C:\\Users\\test\\AppData\\Roaming\\Reader', 'C:\\Program Files\\Reader', 'C:\\Users\\test')).toBe(true)
  })
})

function request(
  providerId: SpeechSynthesisRequest['providerId'], modelId: string, voiceId: string, text: string,
): SpeechSynthesisRequest {
  return { providerId, modelId, voiceId, text, locale: 'en-US', rate: 1 }
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-v085-'))
  roots.push(root)
  return root
}
