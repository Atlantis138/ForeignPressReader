import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, SCHEMA_GENERATION } from '../src/main/migrations'

type Row = Record<string, unknown>

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('formal schema migrations', () => {
  it('creates v4 while preserving the immutable formal-v1 baseline', async () => {
    const root = temporaryRoot()
    const database = await SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')
    const connection = database.getConnection()

    expect(SCHEMA_GENERATION).toBe('formal-v1')
    expect(LATEST_SCHEMA_VERSION).toBe(4)
    expect(MIGRATIONS).toHaveLength(4)
    expect(MIGRATIONS[0]).toMatchObject({ version: 1, name: 'formal-v1' })
    expect(MIGRATIONS[1]).toMatchObject({ version: 2, name: 'parsed-publication-storage' })
    expect(MIGRATIONS[2]).toMatchObject({ version: 3, name: 'fine-grained-library-sync' })
    expect(connection.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(connection.prepare('SELECT version,name,app_version FROM migration_history').all()).toEqual([{
      version: 1,
      name: 'formal-v1',
      app_version: '1.0.0-alpha.1-test',
    }, {
      version: 2,
      name: 'parsed-publication-storage',
      app_version: '1.0.0-alpha.1-test',
    }, {
      version: 3,
      name: 'fine-grained-library-sync',
      app_version: '1.0.0-alpha.1-test',
    }, { version: 4, name: 'reader-records', app_version: '1.0.0-alpha.1-test' }])
    expect(connection.prepare("SELECT value FROM app_metadata WHERE key='schema_generation'").get()).toEqual({
      value: 'formal-v1',
    })
    expect(connection.prepare("SELECT value FROM app_metadata WHERE key='content_id_version'").get()).toEqual({
      value: '2',
    })
    expect(String((connection.prepare("SELECT value FROM app_metadata WHERE key='device_id'").get() as Row).value)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )

    expect(tableNames(connection, [
      'publications', 'reading_positions', 'user_lexemes', 'lexeme_examples', 'study_plans',
      'reinforcement_events', 'review_suspensions', 'study_progress_state',
      'publication_lifecycle', 'study_lexeme_resets', 'sync_clock',
      'sync_entity_revisions', 'sync_peer_state', 'sync_receipts',
    ])).toHaveLength(14)
    expect(columnNames(connection, 'reading_positions')).toEqual(expect.arrayContaining([
      'anchor_block_id', 'anchor_token_index', 'anchor_fraction',
    ]))
    expect(columnNames(connection, 'user_lexemes')).toEqual(expect.arrayContaining([
      'snapshot_provider', 'snapshot_quality',
    ]))
    expect(columnNames(connection, 'study_plan_sources')).toEqual(expect.arrayContaining([
      'sync_status', 'sync_version', 'member_count', 'last_synced_at', 'sync_error',
    ]))
    expect(columnNames(connection, 'publications')).toContain('source_storage')
    expect(connection.prepare('SELECT * FROM sync_clock').get()).toEqual({
      singleton: 1,
      current_revision: 0,
    })
    expect(connection.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })

    const trackedTables = [
      'reader_records',
      'publication_lifecycle', 'settings', 'reading_positions', 'user_lexemes', 'lexeme_examples',
      'vocabulary_sources', 'saved_contexts', 'study_plans', 'study_plan_sources',
      'study_plan_lexeme_origins', 'study_plan_exclusions', 'scheduler_profiles',
      'review_cards', 'review_events', 'reinforcement_events', 'review_suspensions',
      'study_progress_state', 'study_lexeme_resets',
    ]
    const triggers = connection.prepare(`
      SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_track_%'
    `).all() as Array<{ name: string }>
    expect(triggers.map((row) => row.name).sort()).toEqual(trackedTables.flatMap((table) => [
      `sync_track_${table}_insert`, `sync_track_${table}_update`,
    ]).sort())
    database.close()
  })

  it('rejects a Demo generation at schema version 1 without modifying it', async () => {
    const root = temporaryRoot()
    const file = path.join(root, 'reader.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_metadata VALUES ('schema_generation','v0.5.5-study-baseline');
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      INSERT INTO legacy_marker VALUES ('untouched');
      PRAGMA user_version=1;
    `)
    legacy.close()
    const before = fileHash(file)

    await expect(SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')).rejects.toThrow(/Demo 或旧版数据库/)
    expect(fileHash(file)).toBe(before)

    const verification = new DatabaseSync(file, { readOnly: true })
    expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(verification.prepare('SELECT value FROM legacy_marker').get()).toEqual({ value: 'untouched' })
    verification.close()
  })

  it('rejects a database newer than the latest formal schema without modifying it', async () => {
    const root = temporaryRoot()
    const file = path.join(root, 'reader.sqlite')
    const future = new DatabaseSync(file)
    future.exec(`
      CREATE TABLE future_marker (value TEXT NOT NULL);
      INSERT INTO future_marker VALUES ('untouched');
      PRAGMA user_version=99;
    `)
    future.close()
    const before = fileHash(file)

    await expect(SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')).rejects.toThrow(/高于当前正式版/)
    expect(fileHash(file)).toBe(before)

    const verification = new DatabaseSync(file, { readOnly: true })
    expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 })
    expect(verification.prepare('SELECT value FROM future_marker').get()).toEqual({ value: 'untouched' })
    verification.close()
  })

  it('indexes tracked inserts and updates while excluding caches, sessions, and local settings', async () => {
    const root = temporaryRoot()
    const database = await SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')
    const db = database.getConnection()
    const now = '2026-07-10T12:00:00.000Z'
    const deviceId = database.getDeviceId()

    db.prepare(`INSERT INTO publications (
      id,hash,source_key,profile_id,title,creator,language,cover_path,source_path,
      imported_at,article_count,section_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'pub_track', 'hash_track', 'source_track', 'epub-default', 'Tracked', null, 'en', null,
      'tracked.epub', now, 1, 1,
    )
    db.prepare('INSERT INTO sections VALUES (?,?,?,?,?)').run('section_track', 'pub_track', 'section-source', 'Section', 0)
    db.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?)').run(
      'article_track', 'pub_track', 'section_track', 'article-source', 'Article', null, null, 0, 'article.xhtml',
    )
    db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)').run(
      'block_track', 'article_track', 'block-source', 'paragraph', 0, 'Tracked text.', '<p>Tracked text.</p>', null, null,
    )
    db.prepare('INSERT INTO publication_lifecycle VALUES (?,?,?,?,?,?,?)').run(
      'pub_track', 'hash_track', 'epub', 'Tracked', 'present', now, deviceId,
    )
    db.prepare(`INSERT INTO reading_positions (
      publication_id,article_id,scroll_top,updated_at,device_id
    ) VALUES (?,?,?,?,?)`).run('pub_track', 'article_track', 10, now, deviceId)
    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('reader.preferences', '{}', now, deviceId)
    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run('study.developer-mode', 'true', now, deviceId)
    db.prepare('UPDATE settings SET value=? WHERE key=?').run('{"theme":"dark"}', 'reader.preferences')
    db.prepare('UPDATE settings SET value=? WHERE key=?').run('false', 'study.developer-mode')

    db.prepare(`INSERT INTO user_lexemes (
      lexeme_key,lemma_snapshot,phonetic_snapshot,brief_meanings_json,sense_groups_json,
      bnc_rank,frequency_rank,manual_state,manual_familiarity,created_at,updated_at,device_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'lex_track', 'track', null, '[]', '[]', null, null, 'unrated', null, now, now, deviceId,
    )
    db.prepare(`INSERT INTO study_plans (
      plan_id,name,status,daily_new_limit,daily_review_limit,new_order,created_at,updated_at,device_id
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'plan_track', 'Track plan', 'active', 10, 100, 'deterministic_random', now, now, deviceId,
    )
    db.prepare(`INSERT INTO study_plan_exclusions (
      plan_id,lexeme_key,excluded,excluded_at,restored_at,updated_at,device_id
    ) VALUES (?,?,?,?,?,?,?)`).run('plan_track', 'lex_track', 1, now, null, now, deviceId)

    const beforeExcludedWrites = Number((db.prepare('SELECT current_revision FROM sync_clock').get() as Row).current_revision)
    db.prepare(`INSERT INTO translations (
      block_id,source_hash,target_language,model,prompt_version,text,created_at
    ) VALUES (?,?,?,?,?,?,?)`).run('block_track', 'source-hash', 'zh-CN', 'test', 'v1', 'translation', now)
    db.prepare(`INSERT INTO context_definitions (
      cache_key,lexeme_key,word,lemma,article_id,block_id,sentence_hash,dictionary_version,
      model,prompt_version,result_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'cache-track', 'lex_track', 'track', 'track', 'article_track', 'block_track', 'sentence-hash',
      'dict-v1', 'test', 'v1', '{}', now,
    )
    db.prepare(`INSERT INTO study_sessions (
      session_id,day_sequence,logical_date,timezone,cutoff_hour,next_rollover_at,status,
      extra_batch_count,opened_at,completed_at,updated_at,device_id,debug_forced
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'session_track', 1, '2026-07-10', 'Asia/Shanghai', 4, '2026-07-11T04:00:00.000Z',
      'active', 0, now, null, now, deviceId, 0,
    )
    expect(db.prepare('SELECT current_revision FROM sync_clock').get()).toEqual({
      current_revision: beforeExcludedWrites,
    })

    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run(
      'library.management',
      JSON.stringify({ categories: [], items: {}, viewMode: 'grid' }),
      now,
      deviceId,
    )
    expect(db.prepare('SELECT current_revision FROM sync_clock').get()).toEqual({
      current_revision: beforeExcludedWrites,
    })
    const categoryId = `category_${'a'.repeat(32)}`
    db.prepare('INSERT INTO settings VALUES (?,?,?,?)').run(
      `library.category.${categoryId}`,
      JSON.stringify({
        id: categoryId,
        name: 'Tracked category',
        createdAt: now,
        state: 'present',
        deletedAt: null,
      }),
      now,
      deviceId,
    )
    expect(db.prepare('SELECT current_revision FROM sync_clock').get()).toEqual({
      current_revision: beforeExcludedWrites + 1,
    })

    expect(beforeExcludedWrites).toBe(8)
    expect(db.prepare("SELECT revision FROM sync_entity_revisions WHERE entity_type='settings' AND entity_key='reader.preferences'").get()).toEqual({ revision: 5 })
    expect(db.prepare("SELECT 1 AS present FROM sync_entity_revisions WHERE entity_type='settings' AND entity_key='study.developer-mode'").get()).toBeUndefined()
    expect(db.prepare("SELECT revision FROM sync_entity_revisions WHERE entity_type='study_plan_exclusions' AND entity_key=?").get(`plan_track\u001flex_track`)).toEqual({ revision: 8 })
    expect(db.prepare("SELECT 1 AS present FROM sync_entity_revisions WHERE entity_type='settings' AND entity_key='library.management'").get()).toBeUndefined()
    expect(db.prepare("SELECT revision FROM sync_entity_revisions WHERE entity_type='settings' AND entity_key=?").get(`library.category.${categoryId}`)).toEqual({ revision: 9 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM sync_entity_revisions WHERE entity_type IN ('translations','context_definitions','study_sessions')").get()).toEqual({ count: 0 })
    database.close()
  })

  it.each(['legacy_marker', 'publication_lifecycle'])(
    'rejects a non-empty pre-formal schema v0 database without modifying %s',
    async (table) => {
      const root = temporaryRoot()
      const file = path.join(root, 'reader.sqlite')
      const legacy = new DatabaseSync(file)
      legacy.exec(`CREATE TABLE ${table} (sentinel TEXT); INSERT INTO ${table} VALUES ('untouched')`)
      legacy.close()
      const before = fileHash(file)

      await expect(SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')).rejects.toThrow(/Demo 或旧版数据库/)
      expect(fileHash(file)).toBe(before)

      const verification = new DatabaseSync(file, { readOnly: true })
      expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      expect(verification.prepare(`SELECT sentinel FROM ${table}`).get()).toEqual({ sentinel: 'untouched' })
      expect(verification.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
      verification.close()
    },
  )

  it('allows an existing but truly empty SQLite file to establish the formal baseline', async () => {
    const root = temporaryRoot()
    const empty = new DatabaseSync(path.join(root, 'reader.sqlite'))
    empty.close()

    const database = await SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')
    expect(database.getSchemaStatus().schemaVersion).toBe(4)
    database.close()
  })

  it('rolls back the complete baseline when migration 1 fails', async () => {
    const root = temporaryRoot()
    const original = MIGRATIONS[0].up
    MIGRATIONS[0].up = (database) => {
      original(database)
      throw new Error('injected migration failure')
    }
    try {
      await expect(SqliteApplicationRepository.open(root, '1.0.0-alpha.1-test')).rejects.toThrow('injected migration failure')
    } finally {
      MIGRATIONS[0].up = original
    }

    const verification = new DatabaseSync(path.join(root, 'reader.sqlite'), { readOnly: true })
    expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(tableNames(verification, ['app_metadata', 'migration_history', 'sync_clock'])).toHaveLength(0)
    expect(verification.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    verification.close()
  })

  it('upgrades v1 rows through v3 and rolls a failed migration 2 back atomically', async () => {
    for (const fail of [false, true]) {
      const root = temporaryRoot()
      const file = path.join(root, 'reader.sqlite')
      const v1 = new DatabaseSync(file)
      MIGRATIONS[0].up(v1)
      v1.prepare(`
        INSERT INTO publications
          (id,hash,source_key,profile_id,title,creator,language,cover_path,source_path,imported_at,article_count,section_count)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        'pub_aaaaaaaaaaaaaaaaaaaaaaaa', 'a'.repeat(64), 'source', 'generic', 'Fixture', null, 'en', null,
        path.join(root, 'library', 'pub_aaaaaaaaaaaaaaaaaaaaaaaa', 'source.epub'),
        '2026-07-15T00:00:00.000Z', 1, 0,
      )
      v1.prepare('INSERT INTO migration_history(version,name,applied_at,app_version) VALUES(1,?,?,?)')
        .run('formal-v1', '2026-07-15T00:00:00.000Z', 'v1')
      v1.exec('PRAGMA user_version=1')
      v1.close()

      const original = MIGRATIONS[1].up
      if (fail) MIGRATIONS[1].up = (database) => { original(database); throw new Error('migration 2 failure') }
      try {
        if (fail) await expect(SqliteApplicationRepository.open(root, 'v2')).rejects.toThrow('migration 2 failure')
        else {
          const database = await SqliteApplicationRepository.open(root, 'v2')
          expect(database.getSchemaStatus().schemaVersion).toBe(4)
          expect(database.getConnection().prepare('SELECT source_storage FROM publications').get()).toEqual({ source_storage: 'retained' })
          database.close()
        }
      } finally {
        MIGRATIONS[1].up = original
      }

      const verification = new DatabaseSync(file, { readOnly: true })
      expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: fail ? 1 : 4 })
      if (fail) expect(() => verification.prepare('SELECT source_storage FROM publications')).toThrow()
      else expect(verification.prepare('SELECT COUNT(*) AS count FROM migration_history WHERE version=2').get()).toEqual({ count: 1 })
      verification.close()
    }
  })

  it('seeds fine-grained library records from v2 and rolls migration 3 back atomically', async () => {
    for (const fail of [false, true]) {
      const root = temporaryRoot()
      const file = path.join(root, 'reader.sqlite')
      const v2 = new DatabaseSync(file)
      MIGRATIONS[0].up(v2)
      MIGRATIONS[1].up(v2)
      const categoryId = `category_${'a'.repeat(32)}`
      const publicationId = 'pub_aaaaaaaaaaaaaaaaaaaaaaaa'
      v2.prepare('INSERT INTO migration_history(version,name,applied_at,app_version) VALUES(1,?,?,?)')
        .run('formal-v1', '2026-07-15T00:00:00.000Z', 'v1')
      v2.prepare('INSERT INTO migration_history(version,name,applied_at,app_version) VALUES(2,?,?,?)')
        .run('parsed-publication-storage', '2026-07-15T00:00:01.000Z', 'v2')
      v2.prepare('INSERT INTO settings(key,value,updated_at,device_id) VALUES(?,?,?,?)').run(
        'library.management',
        JSON.stringify({
          viewMode: 'grid', sortBy: 'importedAt', sortDirection: 'desc', activeCategoryId: categoryId,
          categories: [{ id: categoryId, name: '迁移分类', createdAt: '2026-07-15T00:00:00.000Z' }],
          items: { [publicationId]: { customTitle: '迁移刊名', categoryId } },
        }),
        '2026-07-15T00:00:02.000Z',
        'device-v2',
      )
      v2.exec('PRAGMA user_version=2')
      v2.close()

      const original = MIGRATIONS[2].up
      if (fail) MIGRATIONS[2].up = (database) => { original(database); throw new Error('migration 3 failure') }
      try {
        if (fail) await expect(SqliteApplicationRepository.open(root, 'v3')).rejects.toThrow('migration 3 failure')
        else {
          const database = await SqliteApplicationRepository.open(root, 'v3')
          expect(database.getSchemaStatus().schemaVersion).toBe(4)
          expect(database.getConnection().prepare("SELECT key FROM settings WHERE key LIKE 'library.category.%'").get())
            .toEqual({ key: `library.category.${categoryId}` })
          expect(database.getConnection().prepare("SELECT key FROM settings WHERE key LIKE 'library.item.%'").get())
            .toEqual({ key: `library.item.${publicationId}` })
          database.close()
        }
      } finally {
        MIGRATIONS[2].up = original
      }

      const verification = new DatabaseSync(file, { readOnly: true })
      expect(verification.prepare('PRAGMA user_version').get()).toEqual({ user_version: fail ? 2 : 4 })
      expect(verification.prepare("SELECT COUNT(*) count FROM settings WHERE key LIKE 'library.category.%' OR key LIKE 'library.item.%'").get())
        .toEqual({ count: fail ? 0 : 2 })
      verification.close()
    }
  })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-sync-migration-'))
  roots.push(root)
  return root
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function tableNames(database: DatabaseSync, names: string[]): string[] {
  const placeholders = names.map(() => '?').join(',')
  return (database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).all(...names) as Array<{ name: string }>).map((row) => row.name)
}

function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
