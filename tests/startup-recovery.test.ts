import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { MIGRATIONS } from '../src/main/migrations'
import { restoreStartupSnapshot } from '../src/main/startup-recovery'

it('validates and upgrades a recovery snapshot before replacing the failed database, retaining original files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-recovery-'))
  try {
    const snapshot = path.join(root, 'backup.sqlite'),
      current = path.join(root, 'reader.sqlite')
    const db = new DatabaseSync(snapshot)
    for (const m of MIGRATIONS.slice(0, 3)) {
      m.up(db)
      db.prepare('INSERT INTO migration_history VALUES(?,?,?,?)').run(
        m.version,
        m.name,
        '2026-09-01T00:00:00Z',
        'old',
      )
    }
    db.exec('PRAGMA user_version=3')
    db.close()
    fs.writeFileSync(current, 'damaged original')
    fs.writeFileSync(current + '-wal', 'retained sidecar')
    const originals = await restoreStartupSnapshot(root, snapshot, 'test')
    expect(fs.readFileSync(path.join(originals, 'reader.sqlite'), 'utf8')).toBe(
      'damaged original',
    )
    expect(
      fs.readFileSync(path.join(originals, 'reader.sqlite-wal'), 'utf8'),
    ).toBe('retained sidecar')
    const restored = new DatabaseSync(current, { readOnly: true })
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 4,
      })
      expect(restored.prepare('PRAGMA quick_check').get()).toEqual({
        quick_check: 'ok',
      })
    } finally {
      restored.close()
    }
    const old = new DatabaseSync(snapshot, { readOnly: true })
    try {
      expect(old.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 3,
      })
    } finally {
      old.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
it('rejects an invalid or future snapshot without touching the current database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-recovery-reject-'))
  try {
    const current = path.join(root, 'reader.sqlite'),
      snapshot = path.join(root, 'backup.sqlite')
    fs.writeFileSync(current, 'preserve me')
    fs.writeFileSync(snapshot, 'invalid')
    await expect(
      restoreStartupSnapshot(root, snapshot, 'test'),
    ).rejects.toThrow()
    fs.unlinkSync(snapshot)
    const db = new DatabaseSync(snapshot)
    MIGRATIONS[0].up(db)
    db.exec('PRAGMA user_version=99')
    db.close()
    await expect(
      restoreStartupSnapshot(root, snapshot, 'test'),
    ).rejects.toThrow()
    expect(fs.readFileSync(current, 'utf8')).toBe('preserve me')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
