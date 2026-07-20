import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const safeStorage = vi.hoisted(() => ({
  decryptStringAsync: vi.fn(async (value: Buffer) => ({
    result: value.toString('utf8'),
    shouldReEncrypt: false,
  })),
  encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
  isAsyncEncryptionAvailable: vi.fn(async () => true),
}))

vi.mock('electron', () => ({ safeStorage }))

import { SecretStore } from '../src/main/secret-store'

const roots: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('formal secret storage', () => {
  it('reads provider credentials from the current encrypted file', async () => {
    const root = temporaryRoot()
    fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
      version: 2,
      providerApiKeys: { deepseek: Buffer.from('formal-secret-key').toString('base64') },
    }))

    await expect(new SecretStore(root).getApiKey()).resolves.toBe('formal-secret-key')
  })

  it('rejects the legacy single-provider secret file instead of upgrading it', async () => {
    const root = temporaryRoot()
    fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
      version: 1,
      deepseekApiKey: Buffer.from('legacy-secret-key').toString('base64'),
    }))

    await expect(new SecretStore(root).getApiKey()).rejects.toThrow('无法读取已保存的 API Key')
  })

  it('atomically stores a credential bundle and only exposes a generic mask', async () => {
    const root = temporaryRoot()
    const store = new SecretStore(root)

    await store.saveApiKeys({
      'baidu-dictionary-api-key': 'dictionary-api-key-value',
      'baidu-dictionary-secret-key': 'dictionary-secret-key-value',
    })

    await expect(store.getApiKey('baidu-dictionary-api-key')).resolves.toBe('dictionary-api-key-value')
    await expect(store.getApiKey('baidu-dictionary-secret-key')).resolves.toBe('dictionary-secret-key-value')
    await expect(store.status('baidu-dictionary-api-key')).resolves.toEqual({
      configured: true,
      masked: '••••••••',
    })
    expect(fs.readdirSync(root).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('atomically restores a partial credential bundle after a failed replacement', async () => {
    const root = temporaryRoot()
    const store = new SecretStore(root)
    await store.saveApiKeys({
      'baidu-dictionary-api-key': 'previous-api-key-value',
      unrelated: 'unrelated-secret-value',
    })

    await store.replaceApiKeys(
      { 'baidu-dictionary-api-key': 'restored-api-key-value' },
      ['baidu-dictionary-secret-key'],
    )

    await expect(store.getApiKey('baidu-dictionary-api-key')).resolves.toBe('restored-api-key-value')
    await expect(store.getApiKey('baidu-dictionary-secret-key')).resolves.toBeNull()
    await expect(store.getApiKey('unrelated')).resolves.toBe('unrelated-secret-value')
    expect(fs.readdirSync(root).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('deletes a credential bundle in one update without affecting other providers', async () => {
    const root = temporaryRoot()
    const store = new SecretStore(root)
    await store.saveApiKeys({
      'baidu-dictionary-api-key': 'dictionary-api-key-value',
      'baidu-dictionary-secret-key': 'dictionary-secret-key-value',
      deepseek: 'deepseek-secret-value',
    })

    await store.deleteApiKeys(['baidu-dictionary-api-key', 'baidu-dictionary-secret-key'])

    await expect(store.getApiKey('baidu-dictionary-api-key')).resolves.toBeNull()
    await expect(store.getApiKey('baidu-dictionary-secret-key')).resolves.toBeNull()
    await expect(store.getApiKey('deepseek')).resolves.toBe('deepseek-secret-value')
  })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-secrets-'))
  roots.push(root)
  return root
}
