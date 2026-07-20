import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { KeyStatus } from '../shared/types'

interface SecretFile {
  version: 2
  providerApiKeys: Record<string, string>
}

export class SecretStore {
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'secrets.json')
  }

  async saveApiKey(value: string, providerId = 'deepseek'): Promise<KeyStatus> {
    await this.saveApiKeys({ [providerId]: value })
    return this.status(providerId)
  }

  async saveApiKeys(values: Record<string, string>): Promise<void> {
    await this.replaceApiKeys(values)
  }

  async replaceApiKeys(
    values: Record<string, string>,
    providerIdsToDelete: string[] = [],
  ): Promise<void> {
    const entries = Object.entries(values)
    if (entries.length === 0 && providerIdsToDelete.length === 0) {
      throw new Error('没有可保存或删除的密钥')
    }
    for (const [providerId, value] of entries) {
      assertProviderId(providerId)
      if (value.trim().length < 16) throw new Error('API Key 格式无效')
    }
    for (const providerId of providerIdsToDelete) {
      assertProviderId(providerId)
      if (Object.hasOwn(values, providerId)) throw new Error('同一密钥不能同时保存和删除')
    }
    if (entries.length > 0 && !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('当前系统无法使用安全密钥存储')
    }
    const data = await this.readEncryptedFile()
    for (const [providerId, value] of entries) {
      const encrypted = await safeStorage.encryptStringAsync(value.trim())
      data.providerApiKeys[providerId] = encrypted.toString('base64')
    }
    for (const providerId of providerIdsToDelete) delete data.providerApiKeys[providerId]
    if (Object.keys(data.providerApiKeys).length === 0) {
      await fs.promises.rm(this.filePath, { force: true })
    } else {
      await this.writeEncryptedFile(data)
    }
  }

  async getApiKey(providerId = 'deepseek'): Promise<string | null> {
    assertProviderId(providerId)
    try {
      const data = await this.readEncryptedFile()
      const encrypted = data.providerApiKeys[providerId]
      if (!encrypted) return null
      const result = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))
      if (result.shouldReEncrypt) await this.saveApiKey(result.result, providerId)
      return result.result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('无法读取已保存的 API Key，请删除后重新设置')
    }
  }

  async deleteApiKey(providerId = 'deepseek'): Promise<void> {
    await this.deleteApiKeys([providerId])
  }

  async deleteApiKeys(providerIds: string[]): Promise<void> {
    if (providerIds.length === 0) return
    await this.replaceApiKeys({}, providerIds)
  }

  async status(providerId = 'deepseek'): Promise<KeyStatus> {
    const key = await this.getApiKey(providerId)
    if (!key) return { configured: false, masked: null }
    return { configured: true, masked: '••••••••' }
  }

  private async readEncryptedFile(): Promise<SecretFile> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as SecretFile
      if (data.version !== 2 || !data.providerApiKeys || typeof data.providerApiKeys !== 'object') {
        throw new Error('unsupported secret file')
      }
      return { version: 2, providerApiKeys: { ...data.providerApiKeys } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, providerApiKeys: {} }
      }
      throw error
    }
  }

  private async writeEncryptedFile(data: SecretFile): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(data), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await fs.promises.rename(temporary, this.filePath)
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
  }
}

function assertProviderId(providerId: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(providerId)) throw new Error('服务供应商 ID 无效')
}
