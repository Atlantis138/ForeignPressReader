import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { AppDatabase } from './sqlite-database'
import { LATEST_SCHEMA_VERSION, SCHEMA_GENERATION } from './migrations'

export interface RecoverySnapshot {
  path: string
  name: string
  modifiedAt: number
}

export function listRecoverySnapshots(
  userDataPath: string,
): RecoverySnapshot[] {
  const root = path.join(userDataPath, 'backups', 'migrations')
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry) => {
      const file = path.join(root, entry.name)
      return {
        path: file,
        name: entry.name,
        modifiedAt: fs.statSync(file).mtimeMs,
      }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Stage and validate before touching the failed database. Keep every original file for recovery. */
export async function restoreStartupSnapshot(
  userDataPath: string,
  snapshotPath: string,
  appVersion: string,
): Promise<string> {
  const current = path.resolve(userDataPath, 'reader.sqlite')
  const selected = path.resolve(snapshotPath)
  if (current === selected) throw new Error('请选择独立的数据库备份文件')
  const root = path.join(userDataPath, 'recovery', crypto.randomUUID())
  const staged = path.join(root, 'validated')
  const originals = path.join(root, 'original')
  fs.mkdirSync(staged, { recursive: true })
  fs.mkdirSync(originals, { recursive: true })
  const source = new DatabaseSync(selected, { readOnly: true })
  try {
    const generation = source
      .prepare("SELECT value FROM app_metadata WHERE key='schema_generation'")
      .get()?.value
    const version = Number(
      source.prepare('PRAGMA user_version').get()?.user_version,
    )
    if (
      generation !== SCHEMA_GENERATION ||
      version < 1 ||
      version > LATEST_SCHEMA_VERSION
    )
      throw new Error('只能恢复受支持的正式版数据库备份')
    if (
      source.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      source.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('备份数据库完整性检查未通过')
    await backup(source, path.join(staged, 'reader.sqlite'))
  } finally {
    source.close()
  }
  const verified = await AppDatabase.open(staged, appVersion)
  try {
    if (
      verified.connection.prepare('PRAGMA quick_check').get()?.quick_check !==
      'ok'
    )
      throw new Error('备份升级后的完整性检查未通过')
  } finally {
    verified.close()
  }
  const moved: string[] = []
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = current + suffix
      if (fs.existsSync(file)) {
        fs.renameSync(file, path.join(originals, `reader.sqlite${suffix}`))
        moved.push(suffix)
      }
    }
    fs.renameSync(path.join(staged, 'reader.sqlite'), current)
  } catch (error) {
    for (const suffix of moved.reverse())
      fs.renameSync(
        path.join(originals, `reader.sqlite${suffix}`),
        current + suffix,
      )
    throw error
  }
  return originals
}
