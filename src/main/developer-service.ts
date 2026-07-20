import fs from 'node:fs'
import { shell } from 'electron'
import type { DeveloperDatabase } from './database-ports'
import type { DeveloperState } from '../shared/types'
import type { DiagnosticLogger } from './diagnostic-logger'

const MODE_KEY = 'study.developer-mode'
const LOG_KEY = 'developer.logging-enabled'

export class DeveloperService {
  constructor(
    private readonly database: DeveloperDatabase,
    private readonly logger: DiagnosticLogger,
    private readonly requestFactoryReset: () => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    const enabled = this.readBoolean(MODE_KEY)
    const logging = enabled && this.readBoolean(LOG_KEY)
    if (!enabled && this.readBoolean(LOG_KEY)) this.writeBoolean(LOG_KEY, false)
    this.logger.setEnabled(logging)
    await this.logger.log('info', 'app', 'startup')
  }

  async getState(): Promise<DeveloperState> {
    const stats = await this.logger.stats()
    const progress = this.database.getConnection().prepare(
      "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
    ).get() as { reset_at?: string | null } | undefined
    return {
      enabled: this.readBoolean(MODE_KEY), loggingEnabled: this.logger.isEnabled,
      logBytes: stats.bytes, logFileCount: stats.files,
      lastStudyResetAt: progress?.reset_at ?? null,
    }
  }

  async setEnabled(enabled: boolean): Promise<DeveloperState> {
    this.writeBoolean(MODE_KEY, enabled)
    if (!enabled) {
      this.writeBoolean(LOG_KEY, false)
      this.logger.setEnabled(false)
    }
    return this.getState()
  }

  async setLoggingEnabled(enabled: boolean): Promise<DeveloperState> {
    if (enabled && !this.readBoolean(MODE_KEY)) throw new Error('请先启用开发模式')
    this.writeBoolean(LOG_KEY, enabled)
    this.logger.setEnabled(enabled)
    await this.logger.log('info', 'developer', enabled ? 'logging-enabled' : 'logging-disabled')
    return this.getState()
  }

  async openLogDirectory(): Promise<void> {
    await fs.promises.mkdir(this.logger.directory, { recursive: true })
    const message = await shell.openPath(this.logger.directory)
    if (message) throw new Error(message)
  }

  async clearLogs(): Promise<DeveloperState> { await this.logger.clear(); return this.getState() }

  async factoryReset(confirmationToken: string): Promise<void> {
    if (!this.readBoolean(MODE_KEY)) throw new Error('请先启用开发模式')
    if (confirmationToken !== '恢复出厂设置') throw new Error('恢复出厂确认无效')
    await this.requestFactoryReset()
  }

  private readBoolean(key: string): boolean {
    const row = this.database.getConnection().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined
    return row?.value === 'true'
  }

  private writeBoolean(key: string, value: boolean): void {
    const now = new Date().toISOString()
    this.database.getConnection().prepare(`
      INSERT INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id
    `).run(key, String(value), now, this.database.getDeviceId())
  }
}
