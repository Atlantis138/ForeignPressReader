import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { SqliteApplicationRepository } from '../src/main/database'
import { MIGRATIONS } from '../src/main/migrations'
import { READER_MIGRATION_SQL } from '../src/main/reader-migration'
import {
  SyncDataService,
  stablePayloadSha256,
  validateBatchEnvelope,
} from '../src/main/sync-data-service'
import { LibraryService } from '../src/main/library-service'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import { PortableDataService } from '../src/main/portable-data-service'
import type { ParsedPublicationPlan } from '../src/shared/types'

const devices: Array<{ root: string; database: SqliteApplicationRepository }> =
  []
const plan = JSON.parse(
  fs.readFileSync('test-vectors/epub-content-v2.json', 'utf8'),
).expectedPlan as ParsedPublicationPlan
const article = plan.sections[0].articles[0]
const another = {
  ...article,
  id: 'article_second_fixture',
  sourceKey: 'second.xhtml',
  sourceHref: 'second.xhtml',
  position: 1,
  blocks: [
    {
      ...article.blocks.find((block) => block.text)!,
      id: 'block_second_fixture',
      sourceKey: 'second-block',
      text: 'Independent reading position.',
    },
  ],
}
afterEach(() => {
  for (const device of devices.splice(0)) {
    device.database.close()
    fs.rmSync(device.root, { recursive: true, force: true })
  }
})

async function device() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-v4-'))
  const database = await SqliteApplicationRepository.open(
    root,
    'reader-v4-test',
  )
  devices.push({ root, database })
  const library = new LibraryService(
    database,
    new PublicationFormatRegistry([]),
    root,
  )
  database.savePublication(
    {
      ...structuredClone(plan),
      sections: [{ ...plan.sections[0], articles: [article, another] }],
      assets: new Map(),
    },
    'epub',
  )
  for (const asset of plan.assetPaths) {
    const dest = path.join(root, 'library', plan.id, 'assets', asset)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from('ffd8ffd9', 'hex'))
  }
  return {
    root,
    database,
    library,
    sync: new SyncDataService(database, library, root),
  }
}

it('keeps independent article positions across restart and indexed body search/marks', async () => {
  const source = await device()
  source.database.savePosition(plan.id, article.id, 213)
  source.database.savePosition(plan.id, another.id, 57)
  source.database.close()
  source.database = await SqliteApplicationRepository.open(
    source.root,
    'reader-v4-test',
  )
  devices[0].database = source.database
  expect(source.database.getArticle(article.id).savedPosition.scrollTop).toBe(
    213,
  )
  expect(source.database.getArticle(another.id).savedPosition.scrollTop).toBe(
    57,
  )
  source.database.changeReadingData(article.id, {
    kind: 'bookmark',
    value: true,
  })
  source.database.changeReadingData(another.id, { kind: 'read', value: true })
  const query = {
    text: '',
    filter: 'bookmarked' as const,
    offset: 0,
    limit: 30,
  }
  expect(
    source.database.searchArticles(query).items.map((item) => item.articleId),
  ).toEqual([article.id])
  expect(
    source.database
      .searchArticles({ ...query, filter: 'unread' })
      .items.map((item) => item.articleId),
  ).toEqual([article.id])
  expect(
    source.database
      .searchArticles({ ...query, text: 'independ', filter: 'all' })
      .items.map((item) => item.articleId),
  ).toEqual([another.id])
  expect(
    source.database.searchArticles({
      ...query,
      text: '" OR 1=1 --',
      filter: 'all',
    }).items,
  ).toEqual([])
  source.database
    .getConnection()
    .prepare('UPDATE blocks SET text=? WHERE id=?')
    .run('Replacement indexed content.', another.blocks[0].id)
  expect(
    source.database.searchArticles({
      ...query,
      text: 'independ',
      filter: 'all',
    }).total,
  ).toBe(0)
  expect(
    source.database.searchArticles({
      ...query,
      text: 'replacement',
      filter: 'all',
    }).total,
  ).toBe(1)
})

it('preserves translation versions through cache clearing, backup restore, and repeated merge', async () => {
  const source = await device(),
    target = await device()
  const block = article.blocks.find((block) => block.type === 'paragraph')!
  const hash = createHash('sha256').update(block.text!).digest('hex')
  source.database.saveTranslation(
    block.id,
    hash,
    '第一份保留译文',
    'fixture-model',
    'fixture-prompt',
  )
  const first = source.database.preserveTranslations(article.id)!
  source.database.saveTranslation(
    block.id,
    hash,
    '第二份保留译文',
    'fixture-model',
    'fixture-prompt',
  )
  const second = source.database.preserveTranslations(article.id)!
  expect(first).not.toBe(second)
  expect(source.database.preserveTranslations(article.id)).toBe(second)
  source.database.changeReadingData(article.id, {
    kind: 'translation-selection',
    value: first,
  })
  source.database.getConnection().exec('DELETE FROM translations')
  expect(
    source.database
      .getArticle(article.id)
      .blocks.find((value) => value.id === block.id)?.translation,
  ).toBe('第一份保留译文')
  const backup = path.join(source.root, 'reader.fprbackup')
  const exporter = new PortableDataService(
    source.database,
    source.library,
    source.root,
    'test',
    () => {},
  )
  const importer = new PortableDataService(
    target.database,
    target.library,
    target.root,
    'test',
    () => {},
  )
  await exporter.exportPortable(backup)
  for (let repeat = 0; repeat < 2; repeat++) {
    const preview = await importer.inspectImport(backup)
    await importer.confirmImport(preview.token)
  }
  expect(target.database.getReadingData(article.id).versions).toHaveLength(2)
  expect(
    target.database
      .getArticle(article.id)
      .blocks.find((value) => value.id === block.id)?.translation,
  ).toBe('第一份保留译文')
})

it('selects only changed logical data during incremental prepare, preview, and apply', async () => {
  const source = await device(),
    target = await device()
  await source.sync.syncTo(target.sync)
  source.database.changeReadingData(article.id, {
    kind: 'bookmark',
    value: true,
  })
  const sourceExport = vi.spyOn(source.database, 'exportPortableUserData')
  const targetExport = vi.spyOn(target.database, 'exportPortableUserData')
  const transfer = await source.sync.prepareSyncTo(target.sync)
  try {
    expect(transfer.batch.records.map((record) => record.type)).toEqual([
      'reader-record',
    ])
    target.sync.previewIncomingBatch(transfer.batch)
    await target.sync.applyPreparedTransfer(transfer)
    expect(target.database.getReadingData(article.id).bookmarked).toBe(true)
    for (const call of [...sourceExport.mock.calls, ...targetExport.mock.calls])
      expect(call[0]).toHaveLength(1)
  } finally {
    await source.sync.cleanupPreparedTransfer(transfer)
  }
})

it('upgrades v3 positions and rolls the whole v4 migration back on failure', async () => {
  expect(READER_MIGRATION_SQL).toBe(
    fs.readFileSync('src-tauri/migrations/0004_reader_records.sql', 'utf8'),
  )
  for (const fail of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-v4-upgrade-'))
    const file = path.join(root, 'reader.sqlite')
    const old = new DatabaseSync(file)
    for (const migration of MIGRATIONS.slice(0, 3)) {
      migration.up(old)
      old
        .prepare('INSERT INTO migration_history VALUES(?,?,?,?)')
        .run(
          migration.version,
          migration.name,
          '2026-09-01T00:00:00.000Z',
          'v3',
        )
    }
    old.exec(`INSERT INTO publications(id,hash,source_key,profile_id,title,source_path,imported_at,article_count,section_count) VALUES('publication_fixture','${'a'.repeat(64)}','source','generic','Title','','2026-09-01T00:00:00.000Z',1,0);
      INSERT INTO articles(id,publication_id,source_key,title,position,source_href) VALUES('article_fixture','publication_fixture','source','Article',0,'article.xhtml');
      INSERT INTO reading_positions(publication_id,article_id,scroll_top,updated_at,device_id) VALUES('publication_fixture','article_fixture',72,'2026-09-01T00:00:00.000Z','device_fixture'); PRAGMA user_version=3;`)
    old.close()
    const original = MIGRATIONS[3].up
    if (fail)
      MIGRATIONS[3].up = (db) => {
        original(db)
        throw new Error('v4 injected failure')
      }
    try {
      if (fail)
        await expect(
          SqliteApplicationRepository.open(root, 'test'),
        ).rejects.toThrow('v4 injected failure')
      else {
        const upgraded = await SqliteApplicationRepository.open(root, 'test')
        try {
          expect(
            upgraded.getArticle('article_fixture').savedPosition.scrollTop,
          ).toBe(72)
        } finally {
          upgraded.close()
        }
      }
    } finally {
      MIGRATIONS[3].up = original
    }
    const check = new DatabaseSync(file, { readOnly: true })
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({
        user_version: fail ? 3 : 4,
      })
      expect(
        check
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name='reader_records'",
          )
          .get(),
      ).toEqual({ n: fail ? 0 : 1 })
    } finally {
      check.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

it('keeps the v3 vector valid and validates v4 without changing content identity', () => {
  for (const version of [3, 4]) {
    const vector = JSON.parse(
      fs.readFileSync(`test-vectors/sync-model-v${version}.json`, 'utf8'),
    )
    validateBatchEnvelope(vector.batch, vector.batch.recipientDeviceId)
    expect(stablePayloadSha256(vector.batch)).toBe(
      vector.expectedStablePayloadSha256,
    )
  }
})

it('pages incoming changes using only the visible records', async () => {
  const source = await device(),
    target = await device()
  await source.sync.syncTo(target.sync)
  source.database.changeReadingData(article.id, {
    kind: 'bookmark',
    value: true,
  })
  source.database.changeReadingData(another.id, { kind: 'read', value: true })
  const transfer = await source.sync.prepareSyncTo(target.sync)
  const spy = vi.spyOn(target.database, 'exportPortableUserData')
  try {
    const first = target.sync.previewRecordPage(transfer.batch, 0, 1)
    const second = target.sync.previewRecordPage(transfer.batch, 1, 1)
    expect(first.items[0].label).toBeTruthy()
    expect(first.items[0].after).toMatch(/已加书签|已读/)
    expect(first.total).toBe(2)
    expect(first.items[0].action).toBe('new')
    expect(second.items[0].key).not.toBe(first.items[0].key)
    expect(first.items[0].after.length).toBeLessThanOrEqual(500)
    expect(spy.mock.calls.every((call) => call[0]?.length === 1)).toBe(true)
    expect(target.sync.previewRecordPage(transfer.batch, 2, 1).items).toEqual(
      [],
    )
    expect(() =>
      target.sync.previewRecordPage(transfer.batch, -1, 25),
    ).toThrow()
  } finally {
    await source.sync.cleanupPreparedTransfer(transfer)
  }
})

it('repairs omitted content under the same EPUB hash and syncs it without losing reading data', async () => {
  const source = await device(),
    target = await device()
  await source.sync.syncTo(target.sync)
  source.database.changeReadingData(article.id, {
    kind: 'bookmark',
    value: true,
  })
  source.database.savePosition(plan.id, article.id, 42)
  const before = source.database.getPublicationContentHash(plan.id)
  const repaired = structuredClone(plan)
  repaired.sections[0].articles[0].blocks.push({
    ...article.blocks.find((b) => b.text)!,
    id: 'block_new_recovered',
    sourceKey: 'recovered-block',
    position: 99,
    text: 'A recovered omitted paragraph.',
  })
  expect(source.database.repairPublication(repaired)).toBe(true)
  expect(source.database.getPublicationContentHash(plan.id)).not.toBe(before)
  expect(source.database.repairPublication(repaired)).toBe(false)
  const transfer = await source.sync.prepareSyncTo(target.sync)
  try {
    expect(transfer.batch.blobs).toHaveLength(1)
    await target.sync.applyPreparedTransfer(transfer)
    expect(
      target.database
        .getArticle(article.id)
        .blocks.some((b) => b.id === 'block_new_recovered'),
    ).toBe(true)
    expect(target.database.getArticle(article.id).savedPosition.scrollTop).toBe(
      42,
    )
    expect(target.database.getReadingData(article.id).bookmarked).toBe(true)
    expect(target.database.getArticle(another.id).id).toBe(another.id)
    expect(target.database.getPublicationContentHash(plan.id)).toBe(
      source.database.getPublicationContentHash(plan.id),
    )
    const invalid = structuredClone(repaired)
    invalid.sections[0].articles[0].blocks[0].text = 'Changed immutable text'
    const digest = source.database.getPublicationContentHash(plan.id)
    expect(() => source.database.repairPublication(invalid)).toThrow()
    expect(source.database.getPublicationContentHash(plan.id)).toBe(digest)
  } finally {
    await source.sync.cleanupPreparedTransfer(transfer)
  }
})

it('matches the cross-platform reader and parsed-content identity vector', async () => {
  const source = await device()
  const vector = JSON.parse(
    fs.readFileSync('test-vectors/reader-records-v4.json', 'utf8'),
  )
  // The shared digest fixture contains only the original article.
  source.database
    .getConnection()
    .prepare('DELETE FROM articles WHERE id=?')
    .run(another.id)
  expect(source.database.getPublicationContentHash(plan.id)).toBe(
    vector.publicationContentHash,
  )
  source.database.saveTranslation(
    vector.blockId,
    vector.sourceHash,
    vector.translation,
    vector.model,
    vector.promptVersion,
  )
  expect(source.database.preserveTranslations(article.id)).toBe(
    vector.versionId,
  )
  const record = source.database
    .exportPortableUserData()
    .readerRecords!.find((r) => r.kind === 'translation')!
  expect(record.payload).toBe(vector.record.payload)
})

it('tracks metadata-only reparsing changes so they can be synchronized',async()=>{
 const source=await device(); const reparsed=structuredClone(plan)
 reparsed.sections[0].articles[0].title='Recovered article title'
 const before=source.database.getSyncRevision()
 expect(source.database.repairPublication(reparsed)).toBe(true)
 expect(source.database.getSyncRevision()).toBeGreaterThan(before)
 expect(source.database.getArticle(article.id).title).toBe('Recovered article title')
 expect(source.database.repairPublication(reparsed)).toBe(false)
})
