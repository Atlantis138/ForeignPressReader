import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersionedRecord } from '../src/core/portable-data'
import { SqliteApplicationRepository } from '../src/main/database'
import { MIGRATIONS, stableIdentity } from '../src/main/migrations'

interface FormalV1Vector {
  schemaGeneration: string
  schemaVersion: number
  contentIdVersion: number
  schemaFingerprint: string
  stableIdentities: Array<{ parts: string[]; sha256: string }>
  versionOrder: Array<{
    left: { updatedAt: string; deviceId: string }
    right: { updatedAt: string; deviceId: string }
    result: number
  }>
}

const roots: string[] = []
const vector = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'test-vectors', 'formal-v1.json'),
  'utf8',
)) as FormalV1Vector

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('formal-v1 cross-platform vector', () => {
  it('pins v4 independently of the earlier formal schemas', () => {
    const vector = JSON.parse(fs.readFileSync('test-vectors/formal-v4.json','utf8'))
    const connection = new DatabaseSync(':memory:')
    try { for (const migration of MIGRATIONS) migration.up(connection); expect(schemaFingerprint(connection)).toBe(vector.schemaFingerprint) }
    finally { connection.close() }
  })
  it('pins the published Electron schema and logical helpers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-v1-vector-'))
    roots.push(root)
    const database = new DatabaseSync(path.join(root, 'formal-v1.sqlite'))
    try {
      MIGRATIONS[0].up(database)
      database.exec(`PRAGMA user_version=${vector.schemaVersion}`)
      expect(Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(vector.schemaVersion)
      expect(database.prepare("SELECT value FROM app_metadata WHERE key='schema_generation'").get()).toEqual({
        value: vector.schemaGeneration,
      })
      expect(database.prepare("SELECT value FROM app_metadata WHERE key='content_id_version'").get()).toEqual({
        value: String(vector.contentIdVersion),
      })
      expect(schemaFingerprint(database)).toBe(vector.schemaFingerprint)
      for (const item of vector.stableIdentities) {
        expect(stableIdentity(...item.parts)).toBe(item.sha256)
      }
      for (const item of vector.versionOrder) {
        expect(Math.sign(compareVersionedRecord(item.left, item.right))).toBe(item.result)
      }
    } finally {
      database.close()
    }
  })

  it('pins the additive v2 schema without rewriting the v1 vector', async () => {
    const v2 = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'formal-v2.json'),
      'utf8',
    )) as FormalV1Vector
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-v2-vector-'))
    roots.push(root)
    const database = new DatabaseSync(path.join(root, 'formal-v2.sqlite'))
    try {
      MIGRATIONS[0].up(database)
      MIGRATIONS[1].up(database)
      database.exec(`PRAGMA user_version=${v2.schemaVersion}`)
      expect(schemaFingerprint(database)).toBe(v2.schemaFingerprint)
    } finally {
      database.close()
    }
  })

  it('pins the additive v3 schema without rewriting earlier vectors', async () => {
    const latest = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'formal-v3.json'),
      'utf8',
    )) as FormalV1Vector
    const connection = new DatabaseSync(':memory:')
    try { for (const migration of MIGRATIONS.slice(0,3)) migration.up(connection); expect(schemaFingerprint(connection)).toBe(latest.schemaFingerprint) }
    finally { connection.close() }
  })
})

function schemaFingerprint(database: ReturnType<SqliteApplicationRepository['getConnection']>): string {
  const rows = database.prepare(`
    SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name
  `).all().map((row) => {
    const value = row as Record<string, unknown>
    return [value.type, value.name, value.tbl_name, String(value.sql).split(/\s+/).filter(Boolean).join(' ')]
  })
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
