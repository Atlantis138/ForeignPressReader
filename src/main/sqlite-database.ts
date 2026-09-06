import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SCHEMA_GENERATION,
} from './migrations'

type Row = Record<string, unknown>

/** Owns the Electron SQLite lifecycle; domain queries live in repositories. */
export class AppDatabase {
  private readonly db: DatabaseSync
  private readonly backupsRoot: string
  private deviceIdValue = ''

  private constructor(
    userDataPath: string,
    private readonly appVersion: string,
  ) {
    fs.mkdirSync(userDataPath, { recursive: true })
    this.backupsRoot = path.join(userDataPath, 'backups', 'migrations')
    this.db = new DatabaseSync(path.join(userDataPath, 'reader.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  }

  static async open(userDataPath: string, appVersion = '0.0.0'): Promise<AppDatabase> {
    const databasePath = path.join(userDataPath, 'reader.sqlite')
    const existed = fs.existsSync(databasePath)
    if (existed) AppDatabase.validateExisting(databasePath)
    const database = new AppDatabase(userDataPath, appVersion)
    try {
      await database.initialize(existed)
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  get connection(): DatabaseSync { return this.db }
  get deviceId(): string { return this.deviceIdValue }
  get schemaVersion(): number {
    const row = this.db.prepare('SELECT user_version FROM pragma_user_version').get() as Row
    return Number(row.user_version)
  }

  close(): void { this.db.close() }

  async createSafetyBackup(label = 'manual'): Promise<string> {
    fs.mkdirSync(this.backupsRoot, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'backup'
    const destination = path.join(this.backupsRoot, `reader-v${this.schemaVersion}-${safeLabel}-${timestamp}.sqlite`)
    const temporary = `${destination}.partial`
    try {
      await sqliteBackup(this.db, temporary, { rate: 256 })
      const verification = new DatabaseSync(temporary, { readOnly: true })
      try {
        this.assertIntegrity(verification)
      } finally {
        verification.close()
      }
      fs.renameSync(temporary, destination)
      this.pruneMigrationBackups(5)
      return destination
    } finally {
      fs.rmSync(temporary, { force: true })
      fs.rmSync(`${temporary}-wal`, { force: true })
      fs.rmSync(`${temporary}-shm`, { force: true })
    }
  }

  private async initialize(existed: boolean): Promise<void> {
    const versionRow = this.db.prepare('SELECT user_version FROM pragma_user_version').get() as Row
    const version = Number(versionRow.user_version)
    if (version < LATEST_SCHEMA_VERSION) {
      this.assertIntegrity(this.db)
      if (existed && version > 0) await this.createSafetyBackup(`before-v${LATEST_SCHEMA_VERSION}`)
      this.runMigrations(version)
      this.assertIntegrity(this.db)
    }
    let generation: Row | undefined
    try {
      generation = this.db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_generation'").get() as Row | undefined
    } catch {
      throw new Error('检测到不兼容的数据库；正式版不提供旧数据迁移，请使用新的数据目录')
    }
    if (String(generation?.value ?? '') !== SCHEMA_GENERATION) {
      throw new Error('数据库架构代次不兼容；请重置应用数据目录后重新导入 EPUB')
    }
    const device = this.db.prepare("SELECT value FROM app_metadata WHERE key = 'device_id'").get() as Row | undefined
    if (!device) throw new Error('数据库缺少设备标识')
    this.deviceIdValue = String(device.value)
  }

  private runMigrations(fromVersion: number): void {
    const pending = MIGRATIONS.filter((migration) => migration.version > fromVersion)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const migration of pending) migration.up(this.db)
      const history = this.db.prepare(`
        INSERT OR REPLACE INTO migration_history (version, name, applied_at, app_version)
        VALUES (?, ?, ?, ?)
      `)
      const now = new Date().toISOString()
      for (const migration of pending) history.run(migration.version, migration.name, now, this.appVersion)
      this.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private assertIntegrity(database: DatabaseSync): void {
    const row = database.prepare('PRAGMA quick_check').get() as Row | undefined
    if (!row || String(Object.values(row)[0]).toLowerCase() !== 'ok') throw new Error('SQLite 完整性检查失败')
  }

  private static validateExisting(databasePath: string): void {
    let database: DatabaseSync | null = null
    try {
      database = new DatabaseSync(databasePath, { readOnly: true })
      const version = Number((database.prepare('PRAGMA user_version').get() as Row).user_version)
      if (version > LATEST_SCHEMA_VERSION) {
        throw new Error('数据库版本高于当前正式版支持的版本；请勿使用该数据目录')
      }
      if (version === 0) {
        const objects = database.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE name NOT GLOB 'sqlite_*'
        `).get() as Row
        if (Number(objects.count) > 0) throw new Error('pre-formal database')
        return
      }
      const metadataExists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='app_metadata'").get()
      if (!metadataExists) throw new Error('pre-formal database')
      const generation = database.prepare(
        "SELECT value FROM app_metadata WHERE key = 'schema_generation'",
      ).get() as Row | undefined
      if (String(generation?.value ?? '') !== SCHEMA_GENERATION) throw new Error('pre-formal database')
    } catch (error) {
      if (error instanceof Error && error.message.includes('高于当前正式版')) throw error
      if (error instanceof Error && error.message === 'pre-formal database') {
        throw new Error('检测到不兼容的 Demo 或旧版数据库；正式版不提供旧数据迁移，请使用新的数据目录')
      }
      throw new Error('无法读取数据库，可能是文件损坏或无法访问。请保留数据目录，并从可用备份恢复。')
    } finally {
      database?.close()
    }
  }

  private pruneMigrationBackups(limit: number): void {
    const files = fs.readdirSync(this.backupsRoot)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => ({ name, time: fs.statSync(path.join(this.backupsRoot, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time)
    for (const file of files.slice(limit)) fs.rmSync(path.join(this.backupsRoot, file.name), { force: true })
  }
}
