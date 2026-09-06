import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { PublicationFormatRegistry } from '../src/core/importing/publication-formats'
import type { PortableUserData } from '../src/core/portable-data'
import type { SyncBatchV2, SyncBatchV3 } from '../src/core/sync-model'
import { SqliteApplicationRepository } from '../src/main/database'
import { EpubImporter } from '../src/main/epub-importer'
import { LibraryService } from '../src/main/library-service'
import { SqliteStudyRepository } from '../src/main/study-repository'
import {
  SyncDataService,
  portableDataToLogicalRecords,
  stablePayloadSha256,
  validateBatchEnvelope,
} from '../src/main/sync-data-service'

interface TestDevice {
  root: string
  database: SqliteApplicationRepository
  library: LibraryService
  sync: SyncDataService
}

const devices: TestDevice[] = []

afterEach(() => {
  for (const device of devices.splice(0)) {
    device.database.close()
    fs.rmSync(device.root, { recursive: true, force: true })
  }
})

describe('main-process loopback sync adapter', () => {
  it('matches the shared normalized-publication Sync Model v2 vector', () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'sync-model-v2.json'),
      'utf8',
    )) as { expectedStablePayloadSha256: string; batch: SyncBatchV2 }

    expect(vector.batch.modelVersion).toBe(2)
    expect(vector.batch.blobs[0].kind).toBe('publication-package')
    expect(() => validateBatchEnvelope(vector.batch, vector.batch.recipientDeviceId)).not.toThrow()
    expect(stablePayloadSha256(vector.batch)).toBe(vector.expectedStablePayloadSha256)
  })

  it('matches and validates the shared fine-grained-library Sync Model v3 vector', () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'sync-model-v3.json'),
      'utf8',
    )) as { expectedStablePayloadSha256: string; batch: SyncBatchV3 }
    expect(() => validateBatchEnvelope(vector.batch, vector.batch.recipientDeviceId)).not.toThrow()
    expect(stablePayloadSha256(vector.batch)).toBe(vector.expectedStablePayloadSha256)
  })

  it('rejects malformed batch identities, revision ranges and package descriptors', () => {
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'sync-model-v2.json'),
      'utf8',
    )) as { batch: SyncBatchV2 }
    const recipient = vector.batch.recipientDeviceId
    const validBatch = {
      ...vector.batch,
      batchId: '22222222-2222-4222-8222-222222222222',
    }

    expect(() => validateBatchEnvelope({ ...validBatch, batchId: '../invalid' }, recipient))
      .toThrow('标识')
    expect(() => validateBatchEnvelope({
      ...validBatch,
      mode: 'incremental',
      fromSenderRevisionExclusive: null,
      inspectedPeerRevision: null,
    }, recipient)).toThrow('revision 范围')
    expect(() => validateBatchEnvelope({
      ...validBatch,
      records: validBatch.records.map((record, index) => index === 0
        ? { ...record, revision: validBatch.senderRevision + 1 }
        : record),
    }, recipient)).toThrow('逻辑记录')
    expect(() => validateBatchEnvelope({
      ...validBatch,
      blobs: validBatch.blobs.map((blob) => ({
        ...blob,
        mediaType: 'application/zip',
      })) as SyncBatchV2['blobs'],
    }, recipient)).toThrow('媒体类型')
    expect(() => validateBatchEnvelope({
      ...validBatch,
      blobs: validBatch.blobs.map((blob) => ({ ...blob, formatId: '../epub' })) as SyncBatchV2['blobs'],
    }, recipient)).toThrow('大对象描述')

    const unsafePublication = structuredClone(validBatch)
    const lifecycle = unsafePublication.records.find((record) => record.type === 'publication-lifecycle')
    if (!lifecycle || lifecycle.type !== 'publication-lifecycle') throw new Error('lifecycle fixture missing')
    lifecycle.key = '..\\..\\outside'
    lifecycle.value.publicationId = '..\\..\\outside'
    expect(() => validateBatchEnvelope(unsafePublication, recipient)).toThrow('刊物生命周期')
  })

  it('previews only changes and publication packages that the receiver still lacks', async () => {
    const source = await createDevice('preview-source')
    const target = await createDevice('preview-target')
    const fixturePath = path.join(source.root, 'preview.epub')
    fs.writeFileSync(fixturePath, await syntheticEpub())
    await source.library.importFile(fixturePath)
    const transfer = await source.sync.prepareSyncTo(target.sync)

    const before = target.sync.previewIncomingBatch(transfer.batch)
    expect(before).toMatchObject({
      totalRecords: transfer.batch.records.length,
      newPublications: 1,
      deletedPublications: 0,
      missingBlobHashes: [transfer.batch.blobs[0].sha256],
      totalBytes: transfer.batch.blobs[0].byteLength,
    })
    await target.sync.applyPreparedTransfer(transfer)
    await source.sync.cleanupPreparedTransfer(transfer)
    expect(target.sync.previewIncomingBatch((await source.sync.prepareSyncTo(target.sync)).batch)).toMatchObject({
      newPublications: 0,
      updatedRecords: 0,
      deletedPublications: 0,
      missingBlobHashes: [],
      totalBytes: 0,
    })
    await source.sync.cleanupPreparedTransfer(transfer)
  })

  it('imports only a missing normalized publication package, then syncs incremental state and deletion', async () => {
    const source = await createDevice('source')
    const target = await createDevice('target')
    const fixturePath = path.join(source.root, 'fixture.epub')
    fs.writeFileSync(fixturePath, await syntheticEpub())
    const imported = await source.library.importFile(fixturePath)
    const firstImportedAt = '2024-02-03T04:05:06.000Z'
    setPublicationImportTime(source, imported.publication.id, firstImportedAt)
    expect(fs.existsSync(fixturePath)).toBe(true)
    expect(fs.existsSync(path.join(source.root, 'library', imported.publication.id, 'source.epub'))).toBe(false)
    source.database.savePreferences({
      theme: 'dark', fontSize: 23, lineHeight: 1.9, columnWidth: 610, paperTint: 64,
    })
    target.database.savePreferences({
      theme: 'light', fontSize: 18, lineHeight: 1.6, columnWidth: 920, paperTint: 30,
    })

    const first = await source.sync.syncTo(target.sync)
    expect(first.batch.mode).toBe('snapshot')
    expect(first.batch.blobs).toHaveLength(1)
    expect(first.batch.blobs[0]).toMatchObject({ kind: 'publication-package', contentSha256: source.database.listPortableBooks()[0].hash })
    expect(first.result).toMatchObject({ status: 'applied', importedBlobs: 1 })
    expect(target.database.listPortableBooks()).toHaveLength(1)
    expect(target.database.listPortableBooks()[0].hash).toBe(source.database.listPortableBooks()[0].hash)
    expect(target.database.listPublications()[0].importedAt).toBe(firstImportedAt)
    expect(fs.existsSync(path.join(target.root, 'library', imported.publication.id, 'source.epub'))).toBe(false)
    expect(target.database.getArticle(imported.publication.unsectionedArticles[0].id).blocks.length).toBeGreaterThan(0)
    // Desktop-only column width remains local while portable reader fields follow the sender.
    expect(target.database.getPreferences()).toEqual({
      theme: 'dark', fontSize: 23, lineHeight: 1.9, columnWidth: 920, paperTint: 64,
    })

    const empty = await source.sync.syncTo(target.sync)
    expect(empty.batch.mode).toBe('incremental')
    expect(empty.batch.records).toEqual([])
    expect(empty.batch.blobs).toEqual([])

    const articleId = imported.publication.unsectionedArticles[0].id
    const blockId = source.database.getArticle(articleId).blocks[0].id
    source.database.savePosition(imported.publication.id, articleId, {
      scrollTop: 321, anchorBlockId: blockId, anchorTokenIndex: 4, anchorFraction: 0.35,
    })
    const positionOnly = await source.sync.syncTo(target.sync)
    expect(positionOnly.batch.records.map((record) => `${record.type}:${record.key}`)).toEqual([
      `reading-position:${imported.publication.id}`,
      `reader-record:position:${articleId}`,
    ])
    expect(target.database.getArticle(articleId).savedPosition).toEqual({
      scrollTop: 321, anchorBlockId: blockId, anchorTokenIndex: 4, anchorFraction: 0.35,
    })

    source.database.savePreferences({
      theme: 'light', fontSize: 25, lineHeight: 2, columnWidth: 600, paperTint: 71,
    })
    const settingOnly = await source.sync.syncTo(target.sync)
    expect(settingOnly.batch.records.map((record) => `${record.type}:${record.key}`)).toEqual([
      'setting:reader.preferences',
    ])
    expect(settingOnly.batch.blobs).toEqual([])
    expect(target.database.getPreferences()).toMatchObject({
      theme: 'light', fontSize: 25, lineHeight: 2, columnWidth: 920, paperTint: 71,
    })

    // The receiver has a newer timestamp, but an explicit A -> B push still makes A win.
    updateReaderSetting(source, {
      theme: 'dark', fontSize: 21, lineHeight: 1.7, columnWidth: 580, paperTint: 48,
    }, '2025-01-01T00:00:00.000Z')
    updateReaderSetting(target, {
      theme: 'light', fontSize: 29, lineHeight: 2.1, columnWidth: 960, paperTint: 99,
    }, '2035-01-01T00:00:00.000Z')
    target.database.saveSpeechPreferences({
      locale: 'en-GB', voiceId: 'receiver-voice', rate: 1.2,
      autoPlayStudy: true, wordProviderId: 'system', articleProviderId: 'google',
      providerSettings: {
        google: { modelId: 'standard', voiceId: 'en-GB-Standard-A' },
        minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
      },
    })
    const senderWins = await source.sync.syncTo(target.sync)
    expect(senderWins.batch.records.map((record) => record.key)).toEqual(['reader.preferences'])
    expect(target.database.getPreferences()).toEqual({
      theme: 'dark', fontSize: 21, lineHeight: 1.7, columnWidth: 960, paperTint: 48,
    })
    expect(target.database.getSpeechPreferences()).toEqual({
      locale: 'en-GB', voiceId: 'receiver-voice', rate: 1.2,
      autoPlayStudy: true, wordProviderId: 'system', articleProviderId: 'google',
      providerSettings: {
        google: { modelId: 'standard', voiceId: 'en-GB-Standard-A' },
        minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
      },
    })

    await target.library.removeImportedPublication(imported.publication.id)
    const restored = await source.sync.syncTo(target.sync)
    expect(restored.batch.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'publication-lifecycle', key: imported.publication.id }),
      expect.objectContaining({ type: 'reading-position', key: imported.publication.id }),
    ]))
    expect(target.database.getArticle(articleId).savedPosition).toEqual({
      scrollTop: 321, anchorBlockId: blockId, anchorTokenIndex: 4, anchorFraction: 0.35,
    })

    await source.library.removeImportedPublication(imported.publication.id)
    const deletion = await source.sync.syncTo(target.sync)
    expect(deletion.batch.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'publication-lifecycle',
        value: expect.objectContaining({ state: 'deleted' }),
      }),
    ]))
    expect(target.database.listPortableBooks()).toEqual([])
    expect(target.database.getPublicationLifecycle(imported.publication.id)?.state).toBe('deleted')
    expect(fs.existsSync(path.join(target.root, 'library', imported.publication.id))).toBe(false)
  })

  it('keeps the earliest product import time when both devices already contain the publication', async () => {
    const source = await createDevice('import-time-source')
    const target = await createDevice('import-time-target')
    const fixture = await syntheticEpub()
    const sourcePath = path.join(source.root, 'same.epub')
    const targetPath = path.join(target.root, 'same.epub')
    fs.writeFileSync(sourcePath, fixture)
    fs.writeFileSync(targetPath, fixture)
    const sourceImport = await source.library.importFile(sourcePath)
    const targetImport = await target.library.importFile(targetPath)
    const earliest = '2023-01-02T03:04:05.000Z'
    setPublicationImportTime(source, sourceImport.publication.id, earliest)
    setPublicationImportTime(target, targetImport.publication.id, '2026-07-19T10:00:00.000Z')

    const transfer = await source.sync.prepareSyncTo(target.sync)
    expect(transfer.batch.blobs).toEqual([])
    await target.sync.applyPreparedTransfer(transfer)

    expect(target.database.listPublications()[0].importedAt).toBe(earliest)
  })

  it('deduplicates an identical prepared batch by receipt and rejects batch-id content collisions', async () => {
    const source = await createDevice('receipt-source')
    const target = await createDevice('receipt-target')
    source.database.savePreferences({
      theme: 'dark', fontSize: 22, lineHeight: 1.8, columnWidth: 700, paperTint: 55,
    })
    const transfer = await source.sync.prepareSyncTo(target.sync)
    const first = await target.sync.applyPreparedTransfer(transfer)
    const replay = await target.sync.applyPreparedTransfer(transfer)

    expect(first.status).toBe('applied')
    expect(replay).toMatchObject({
      status: 'duplicate', appliedRecords: 0, importedBlobs: 0,
    })
    expect(target.database.getPreferences().theme).toBe('dark')

    const conflicting = structuredClone(transfer)
    const setting = conflicting.batch.records.find((record) => record.type === 'setting')
    if (!setting || setting.type !== 'setting') throw new Error('setting fixture missing')
    setting.value.value = { theme: 'light' }
    conflicting.payloadSha256 = stablePayloadSha256(conflicting.batch)
    await expect(target.sync.applyPreparedTransfer(conflicting)).rejects.toThrow('批次')
  })

  it('reuses a complete outgoing payload after interruption and replaces corrupted staging', async () => {
    const source = await createDevice('resume-source')
    const target = await createDevice('resume-target')
    source.database.savePreferences({
      theme: 'dark', fontSize: 22, lineHeight: 1.8, columnWidth: 700, paperTint: 55,
    })
    const first = await source.sync.prepareSyncTo(target.sync)
    expect(first.payloadPath && fs.existsSync(first.payloadPath)).toBe(true)
    expect(await source.sync.listResumableTransfers()).toEqual([
      expect.objectContaining({
        batchId: first.batch.batchId,
        payloadByteLength: first.payloadByteLength,
        totalByteLength: first.payloadByteLength,
      }),
    ])

    const reopened = new SyncDataService(source.database, source.library, source.root)
    const resumed = await reopened.prepareSyncTo(target.sync)
    expect(resumed.batch.batchId).toBe(first.batch.batchId)
    expect(resumed.payloadSha256).toBe(first.payloadSha256)

    fs.appendFileSync(resumed.payloadPath!, '\n')
    const afterCorruption = await reopened.prepareSyncTo(target.sync)
    expect(afterCorruption.batch.batchId).not.toBe(first.batch.batchId)
    expect(fs.existsSync(first.transferRoot!)).toBe(false)
    await reopened.cleanupPreparedTransfer(afterCorruption)
  })

  it('cleans expired outgoing state and rejects a changed NDJSON payload before database apply', async () => {
    const source = await createDevice('integrity-source')
    const target = await createDevice('integrity-target')
    source.database.savePreferences({
      theme: 'dark', fontSize: 24, lineHeight: 1.9, columnWidth: 720, paperTint: 61,
    })
    const changed = await source.sync.prepareSyncTo(target.sync)
    fs.appendFileSync(changed.payloadPath!, '\n')
    await expect(target.sync.applyPreparedTransfer(changed)).rejects.toThrow('校验')
    expect(target.database.getPreferences().theme).not.toBe('dark')
    await source.sync.cleanupPreparedTransfer(changed)

    const expiring = await source.sync.prepareSyncTo(target.sync)
    const statePath = path.join(expiring.transferRoot!, 'state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { expiresAt: string }
    fs.writeFileSync(statePath, JSON.stringify({ ...state, expiresAt: '2000-01-01T00:00:00.000Z' }))
    const reopened = new SyncDataService(source.database, source.library, source.root)
    expect(await reopened.listResumableTransfers()).toEqual([])
    expect(fs.existsSync(expiring.transferRoot!)).toBe(false)
  })

  it('round-trips every non-publication Sync Model v3 record family', async () => {
    const source = await createDevice('all-records-source')
    const target = await createDevice('all-records-target')
    const vector = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'test-vectors', 'portable-v2-interop.json'),
      'utf8',
    )) as { portableData: PortableUserData }
    source.database.mergePortableUserData(vector.portableData)

    const sourceRecords = portableDataToLogicalRecords(
      source.database.exportPortableUserData(),
      () => 0,
    )
    const transfer = await source.sync.syncTo(target.sync)
    const targetRecords = portableDataToLogicalRecords(
      target.database.exportPortableUserData(),
      () => 0,
    )

    expect(new Set(transfer.batch.records.map((record) => record.type))).toEqual(
      new Set(sourceRecords.map((record) => record.type)),
    )
    expect(targetRecords).toEqual(sourceRecords)
    expect(sourceRecords.map((record) => record.type)).toEqual(expect.arrayContaining([
      'setting',
      'user-lexeme',
      'lexeme-example',
      'vocabulary-source',
      'saved-context',
      'study-plan',
      'study-plan-source',
      'study-plan-origin',
      'study-plan-exclusion',
      'scheduler-profile',
      'review-card',
      'review-event',
      'reinforcement-event',
      'study-progress-state',
      'study-lexeme-reset',
    ]))
  })

  it('propagates received logical changes through a third device without SQL-shaped study fields', async () => {
    const first = await createDevice('chain-a')
    const second = await createDevice('chain-b')
    const third = await createDevice('chain-c')
    first.database.savePreferences({
      theme: 'dark', fontSize: 24, lineHeight: 1.95, columnWidth: 740, paperTint: 67,
    })

    const ab = await first.sync.syncTo(second.sync)
    expect(ab.result.status).toBe('applied')
    const bc = await second.sync.syncTo(third.sync)
    expect(bc.batch.mode).toBe('snapshot')
    expect(third.database.getPreferences()).toMatchObject({
      theme: 'dark', fontSize: 24, lineHeight: 1.95, paperTint: 67,
    })

    const now = '2026-07-10T12:00:00.000Z'
    const deviceId = first.database.getDeviceId()
    first.database.getConnection().prepare(`
      INSERT INTO study_plans (
        plan_id,name,status,daily_new_limit,daily_review_limit,new_order,
        created_at,updated_at,device_id,deleted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,NULL)
    `).run('plan-sync', 'Sync plan', 'active', 5, 20, 'reader_first_frequency', now, now, deviceId)
    const records = portableDataToLogicalRecords(first.database.exportPortableUserData())
    const plan = records.find((record) => record.type === 'study-plan' && record.key === 'plan-sync')
    expect(plan?.value).toMatchObject({ planId: 'plan-sync', dailyNewLimit: 5 })
    expect(Object.keys(plan?.value ?? {}).some((key) => key.includes('_'))).toBe(false)

    await first.sync.syncTo(second.sync)
    await second.sync.syncTo(third.sync)
    expect(third.database.exportPortableUserData().studyPlans).toEqual(expect.arrayContaining([
      expect.objectContaining({ planId: 'plan-sync', name: 'Sync plan' }),
    ]))
  })

  it('retires receiver-local queue items when a synchronized plan is deleted', async () => {
    const source = await createDevice('plan-delete-source')
    const target = await createDevice('plan-delete-target')
    let sourceNow = new Date('2026-07-31T08:00:00.000Z')
    const sourceStudy = new SqliteStudyRepository(source.database, () => sourceNow)
    const planId = sourceStudy.createPlan(studyPlan('Delete through sync'))
    sourceStudy.applySourceSnapshot(
      String(sourceStudy.activeSources(planId)[0].source_id),
      [studyWord('stale-queue')],
      'reader:1',
    )
    await source.sync.syncTo(target.sync)

    const targetStudy = new SqliteStudyRepository(
      target.database,
      () => new Date('2026-07-31T09:00:00.000Z'),
    )
    const session = targetStudy.openToday()
    expect(target.database.getConnection().prepare('SELECT plan_id FROM study_session_items WHERE item_id=?')
      .get(session.current!.itemId)).toMatchObject({ plan_id: planId })
    expect(countRows(target, "study_session_items WHERE status IN ('pending','revealed')")).toBe(1)

    sourceNow = new Date('2026-07-31T10:00:00.000Z')
    sourceStudy.setDeveloperMode(true)
    sourceStudy.deletePlan(planId, 'Delete through sync', { resetWordProgress: false })
    const deletion = await source.sync.syncTo(target.sync)

    expect(deletion.batch.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'study-plan',
        value: expect.objectContaining({ planId, deletedAt: sourceNow.toISOString() }),
      }),
    ]))
    expect(targetStudy.listPlans(true)).toEqual([])
    expect(countRows(target, "study_session_items WHERE status IN ('pending','revealed')")).toBe(0)
    expect(target.database.getConnection().prepare('SELECT status FROM study_sessions WHERE session_id=?')
      .get(session.sessionId)).toMatchObject({ status: 'completed' })
  })

  it('applies a global progress reset to receiver-local cards and activity sessions', async () => {
    const source = await createDevice('global-reset-source')
    const target = await createDevice('global-reset-target')
    let sourceNow = new Date('2026-07-31T08:00:00.000Z')
    const sourceStudy = new SqliteStudyRepository(source.database, () => sourceNow)
    const planId = sourceStudy.createPlan(studyPlan('Reset through sync'))
    sourceStudy.applySourceSnapshot(
      String(sourceStudy.activeSources(planId)[0].source_id),
      [studyWord('reset-queue')],
      'reader:1',
    )
    await source.sync.syncTo(target.sync)

    const targetStudy = new SqliteStudyRepository(
      target.database,
      () => new Date('2026-07-31T09:00:00.000Z'),
    )
    let session = targetStudy.openToday()
    session = targetStudy.stageAnswer({
      sessionId: session.sessionId,
      itemId: session.current!.itemId,
      expectedVersion: session.current!.version,
      answer: 'known',
    })
    targetStudy.commitAnswer({
      sessionId: session.sessionId,
      itemId: session.current!.itemId,
      expectedVersion: session.current!.version,
      commandId: crypto.randomUUID(),
      answer: 'known',
    })
    expect(countRows(target, 'review_cards')).toBe(1)
    expect(countRows(target, 'study_sessions')).toBe(1)

    sourceNow = new Date('2026-07-31T10:00:00.000Z')
    sourceStudy.setDeveloperMode(true)
    sourceStudy.resetAllProgress('RESET_ALL_STUDY_PROGRESS')
    const reset = await source.sync.syncTo(target.sync)

    expect(reset.batch.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'study-progress-state' }),
    ]))
    expect(countRows(target, 'review_cards')).toBe(0)
    expect(countRows(target, 'review_events')).toBe(0)
    expect(countRows(target, 'study_sessions')).toBe(0)
  })

  it('merges receiver-only library categories and propagates category tombstones without losing local titles', async () => {
    const source = await createDevice('library-source')
    const target = await createDevice('library-target')
    const duplicateName = '分类'.repeat(50)
    const sourceCategory = source.database.createLibraryCategory(duplicateName).categories[0]
    const targetCategory = target.database.createLibraryCategory(duplicateName).categories[0]
    const targetEpub = path.join(target.root, 'receiver-only.epub')
    fs.writeFileSync(targetEpub, await syntheticEpub())
    const receiverPublication = await target.library.importFile(targetEpub)

    const initialLibrarySync = await source.sync.syncTo(target.sync)
    expect(initialLibrarySync.batch.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'setting', key: 'library.management' }),
    ]))
    expect(target.database.getLibraryState().categories.map((category) => category.id).sort()).toEqual(
      [sourceCategory.id, targetCategory.id].sort(),
    )
    const mergedNames = target.database.getLibraryState().categories.map((category) => category.name)
    expect(new Set(mergedNames).size).toBe(2)
    expect(mergedNames.every((name) => Array.from(name).length <= 100)).toBe(true)

    target.database.renameLibraryPublication(receiverPublication.publication.id, 'Receiver title')
    target.database.assignLibraryPublications([receiverPublication.publication.id], sourceCategory.id)
    target.database.getConnection().prepare('UPDATE settings SET updated_at=? WHERE key=?').run(
      '2099-01-01T00:00:00.000Z',
      `library.item.${receiverPublication.publication.id}`,
    )
    source.database.deleteLibraryCategory(sourceCategory.id)
    const deletion = await source.sync.syncTo(target.sync)

    expect(deletion.batch.modelVersion).toBe(4)
    expect(deletion.batch.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'setting',
        key: `library.category.${sourceCategory.id}`,
        value: expect.objectContaining({
          value: expect.objectContaining({ state: 'deleted' }),
        }),
      }),
    ]))
    const state = target.database.getLibraryState()
    expect(state.categories.map((category) => category.id)).toEqual([targetCategory.id])
    expect(state.publications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: receiverPublication.publication.id,
        title: 'Receiver title',
        categoryId: null,
      }),
    ]))
    const item = target.database.getConnection().prepare('SELECT value,updated_at FROM settings WHERE key=?')
      .get(`library.item.${receiverPublication.publication.id}`) as { value: string; updated_at: string }
    expect(JSON.parse(item.value)).toMatchObject({
      publicationId: receiverPublication.publication.id,
      customTitle: 'Receiver title',
      categoryId: null,
      state: 'present',
    })
    expect(item.updated_at > '2099-01-01T00:00:00.000Z').toBe(true)

    await target.sync.syncTo(source.sync)
    expect(source.database.getLibraryState().publications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: receiverPublication.publication.id,
        title: 'Receiver title',
        categoryId: null,
      }),
    ]))
  })
})

async function createDevice(label: string): Promise<TestDevice> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `reader-sync-${label}-`))
  const database = await SqliteApplicationRepository.open(root, '0.8.0-test')
  const library = new LibraryService(database, epubFormats(), root)
  const device = { root, database, library, sync: new SyncDataService(database, library, root) }
  devices.push(device)
  return device
}

function updateReaderSetting(
  device: TestDevice,
  value: { theme: string; fontSize: number; lineHeight: number; columnWidth: number; paperTint: number },
  updatedAt: string,
): void {
  device.database.getConnection().prepare(`
    INSERT INTO settings(key,value,updated_at,device_id) VALUES('reader.preferences',?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id
  `).run(JSON.stringify(value), updatedAt, device.database.getDeviceId())
}

function setPublicationImportTime(device: TestDevice, publicationId: string, importedAt: string): void {
  const database = device.database.getConnection()
  database.prepare('UPDATE publications SET imported_at=? WHERE id=?').run(importedAt, publicationId)
  database.prepare("UPDATE publication_lifecycle SET changed_at=? WHERE publication_id=? AND state='present'")
    .run(importedAt, publicationId)
}

function studyPlan(name: string) {
  return {
    name,
    dailyNewLimit: 20,
    dailyReviewLimit: 100,
    sources: [{ type: 'reader_manual' as const, ref: 'favorite' }],
  }
}

function studyWord(lemma: string) {
  return {
    lexemeKey: `lex_en_${lemma.replace(/[^a-z]/g, '').padEnd(24, '0').slice(0, 24)}`,
    lemma,
    phonetic: null,
    briefMeanings: [lemma],
    senses: [],
    bnc: 1,
    frequency: 1,
  }
}

function countRows(device: TestDevice, from: string): number {
  return Number((device.database.getConnection().prepare(`SELECT COUNT(*) count FROM ${from}`).get() as { count: number }).count)
}

function epubFormats(): PublicationFormatRegistry {
  return new PublicationFormatRegistry([{
    id: 'epub', name: 'EPUB', extensions: ['epub'], maxBytes: 20 * 1024 * 1024,
    importer: new EpubImporter(),
  }])
}

async function syntheticEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sync Weekly</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="article" href="article.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="article"/></spine></package>`)
  zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="article.xhtml">Sync article</a></li></ol></nav></body></html>`)
  zip.file('EPUB/article.xhtml', `<html><head><title>Sync article</title></head><body><h1>Sync article</h1><p>This deliberately substantial English paragraph gives the importer enough editorial content to build a stable article for the loopback synchronization test.</p><p>A second paragraph makes the synthetic publication representative while remaining compact and deterministic.</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
