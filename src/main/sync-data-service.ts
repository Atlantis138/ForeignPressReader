import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  buildSyncBatch,
  planSyncSelection,
} from '../core/sync-engine'
import {
  LAN_SYNC_BATCH_STREAM_VERSION,
  LAN_SYNC_LIMITS,
  parseLanSyncBatchLineV2,
  serializeLanSyncBatchV2,
  type LanSyncBatchHeaderLineV2,
} from '../core/sync-wire'
import {
  SYNC_MODEL_VERSION,
  type JsonObject,
  type JsonValue,
  type LogicalRecordV1,
  type PublicationPackageBlobRefV2,
  type SyncApplyResult,
  type SyncBatch,
  type SyncBatchV2,
  type SyncEntityRef,
  type SyncEntityType,
  type SyncPeerSummaryV2,
} from '../core/sync-model'
import type {
  PortableSettingRecord,
  PortableStudyLexemeResetRecord,
  PortableStudyPlanExclusionRecord,
  PortableStudyPlanOriginRecord,
  PortableStudyPlanRecord,
  PortableStudyPlanSourceRecord,
  PortableStudyProgressStateRecord,
  PortableSchedulerProfileRecord,
  PortableReviewCardRecord,
  PortableReviewEventRecord,
  PortableReinforcementEventRecord,
  PortableReviewSuspensionRecord,
  PortableUserData,
} from '../core/portable-data'
import type { SyncDataRepository } from './database-ports'
import type { LibraryService } from './library-service'
import { PublicationPackageService, publicationPackageExpandedBytes } from './publication-package-service'

const ENTITY_TYPE_BY_TABLE = {
  publication_lifecycle: 'publication-lifecycle',
  settings: 'setting',
  reading_positions: 'reading-position',
  user_lexemes: 'user-lexeme',
  lexeme_examples: 'lexeme-example',
  vocabulary_sources: 'vocabulary-source',
  saved_contexts: 'saved-context',
  study_plans: 'study-plan',
  study_plan_sources: 'study-plan-source',
  study_plan_lexeme_origins: 'study-plan-origin',
  study_plan_exclusions: 'study-plan-exclusion',
  scheduler_profiles: 'scheduler-profile',
  review_cards: 'review-card',
  review_events: 'review-event',
  reinforcement_events: 'reinforcement-event',
  review_suspensions: 'review-suspension',
  study_progress_state: 'study-progress-state',
  study_lexeme_resets: 'study-lexeme-reset',
} as const satisfies Record<string, SyncEntityType>

type DatabaseEntityType = keyof typeof ENTITY_TYPE_BY_TABLE

export interface PreparedSyncTransfer<TBatch extends SyncBatch = SyncBatch> {
  batch: TBatch
  payloadSha256: string
  blobSourcePaths: Record<string, string>
  payloadPath?: string
  payloadByteLength?: number
  transferRoot?: string
  updatedAt?: string
  expiresAt?: string
}

interface PersistedOutgoingTransfer {
  version: 2
  peerDeviceId: string
  batchId: string
  payloadSha256: string
  payloadByteLength: number
  totalByteLength: number
  blobSourcePaths: Record<string, string>
  updatedAt: string
  expiresAt: string
}

export interface SyncToResult {
  batch: SyncBatchV2
  result: SyncApplyResult
}

export interface IncomingSyncPreviewPlan {
  totalRecords: number
  newPublications: number
  updatedRecords: number
  deletedPublications: number
  missingBlobHashes: string[]
  totalBytes: number
}

interface SyncLibraryAdapter {
  importFile(sourceFile: string): ReturnType<LibraryService['importFile']>
  restoreParsedPublication: LibraryService['restoreParsedPublication']
  purgeImportedPublications(publicationIds: string[]): ReturnType<LibraryService['purgeImportedPublications']>
}

/**
 * Node/Electron adapter for the transport-neutral sync model.
 *
 * It intentionally exposes a loopback transfer object instead of sockets. A
 * later HTTPS transport can serialize `batch`, stream the referenced blobs,
 * and call the same receiver-side apply method.
 */
export class SyncDataService {
  private readonly publicationPackages: PublicationPackageService
  private readonly syncOutbox: string

  constructor(
    private readonly database: SyncDataRepository,
    private readonly library: SyncLibraryAdapter,
    private readonly userDataPath: string,
  ) {
    this.publicationPackages = new PublicationPackageService(database, library, userDataPath)
    this.syncOutbox = path.join(userDataPath, 'sync-outbox')
    fs.mkdirSync(this.syncOutbox, { recursive: true })
    this.removeExpiredOutgoingTransfersSync()
  }

  get deviceId(): string { return this.database.getDeviceId() }

  getPeerInspectedRevision(peerDeviceId: string): number {
    return this.database.getSyncPeerState(peerDeviceId)?.peerInspectedRevision ?? 0
  }

  duplicateReceiptResult(senderDeviceId: string, batchId: string, payloadSha256: string): SyncApplyResult | null {
    if (!this.database.hasSyncReceipt(senderDeviceId, batchId, payloadSha256)) return null
    return {
      batchId,
      status: 'duplicate',
      appliedRecords: 0,
      unchangedRecords: 0,
      importedBlobs: 0,
      senderRevision: 0,
      localRevision: this.database.getSyncRevision(),
    }
  }

  async expandedPublicationBytes(blobPaths: Record<string, string>): Promise<number> {
    let total = 0
    for (const filePath of Object.values(blobPaths)) {
      total += await publicationPackageExpandedBytes(filePath)
      if (!Number.isSafeInteger(total)) throw new Error('刊物包展开大小无效')
    }
    return total
  }

  /** Prepare, deliver, acknowledge, and return one in-process push. */
  async syncTo(target: SyncDataService): Promise<SyncToResult> {
    const transfer = await this.prepareSyncTo(target)
    try {
      const result = await target.applyPreparedTransfer(transfer)
      this.acknowledgeTransfer(target.deviceId, transfer.batch.senderRevision, result.localRevision)
      return { batch: transfer.batch, result }
    } finally {
      await this.cleanupPreparedTransfer(transfer)
    }
  }

  /** Build a deterministic logical payload plus local paths for required blobs. */
  async prepareSyncTo(target: SyncDataService): Promise<PreparedSyncTransfer<SyncBatchV2>> {
    if (target.deviceId === this.deviceId) throw new Error('不能向当前设备自身同步')

    const peerState = this.database.getSyncPeerState(target.deviceId)
    const summary = target.createPeerSummary(
      this.deviceId,
      peerState?.peerInspectedRevision ?? 0,
    )
    return this.prepareSyncForPeer(target.deviceId, summary)
  }

  /** Build a transfer from a summary obtained through any transport. */
  async prepareSyncForPeer(
    peerDeviceId: string,
    summary: SyncPeerSummaryV2,
  ): Promise<PreparedSyncTransfer<SyncBatchV2>> {
    if (peerDeviceId === this.deviceId || summary.deviceId !== peerDeviceId) {
      throw new Error('同步目标设备身份不匹配')
    }
    if (summary.modelVersion !== SYNC_MODEL_VERSION) throw new Error('同步模型版本不兼容')

    const resumable = await this.loadResumableTransfer(peerDeviceId)
    if (resumable) return resumable

    const peerState = this.database.getSyncPeerState(peerDeviceId)
    const revisionByIdentity = this.currentRevisionByIdentity()
    const records = portableDataToLogicalRecords(
      this.database.exportPortableUserData(),
      (type, key) => revisionByIdentity.get(entityIdentity(type, key)) ?? 0,
    )
    const currentEntities = records.map(recordRef)
    const localChanges = this.database.listSyncEntityRevisions(0).map(databaseEntityRef)
    const selection = planSyncSelection({
      localRevision: this.database.getSyncRevision(),
      currentEntities,
      localChanges,
      peer: peerState ? summary : null,
    })
    const recordByIdentity = new Map(records.map((record) => [entityIdentity(record.type, record.key), record]))
    const selectedRecords = selection.entities.map((ref) => {
      const record = recordByIdentity.get(entityIdentity(ref.type, ref.key))
      if (!record) throw new Error(`同步实体缺少当前逻辑状态：${ref.type}/${ref.key}`)
      return record
    })

    const availableHashes = new Set(summary.availableBlobHashes)
    const booksByHash = new Map(this.database.listPortableBooks().map((book) => [book.hash, book]))
    const blobs: PublicationPackageBlobRefV2[] = []
    const blobSourcePaths: Record<string, string> = {}
    const batchId = crypto.randomUUID()
    const transferRoot = path.join(this.syncOutbox, batchId)
    await fs.promises.mkdir(transferRoot, { recursive: true })
    try {
      for (const record of selectedRecords) {
        if (record.type !== 'publication-lifecycle' || record.value.state !== 'present') continue
        if (availableHashes.has(record.value.contentHash)) continue
        const book = booksByHash.get(record.value.contentHash)
        if (!book || book.publicationId !== record.value.publicationId) {
          throw new Error(`活动刊物缺少解析内容：${record.value.title}`)
        }
        const created = await this.publicationPackages.createPackage(
          book,
          path.join(transferRoot, `${book.hash}.fprpub`),
        )
        blobs.push({
          kind: 'publication-package',
          publicationId: book.publicationId,
          formatId: book.formatId,
          contentSha256: book.hash,
          sha256: created.payloadSha256,
          byteLength: created.byteLength,
          mediaType: 'application/vnd.foreign-press-reader.publication+zip',
        })
        blobSourcePaths[created.payloadSha256] = created.path
      }
      const batch = buildSyncBatch({
        batchId,
        senderDeviceId: this.deviceId,
        recipientDeviceId: peerDeviceId,
        createdAt: new Date().toISOString(),
        selection,
        records: selectedRecords,
        blobs,
      })
      const payloadPath = path.join(transferRoot, 'batch.ndjson')
      const payload = await writeBatchPayload(payloadPath, batch)
      const updatedAt = new Date().toISOString()
      const expiresAt = new Date(Date.now() + LAN_SYNC_LIMITS.transferLifetimeMs).toISOString()
      const totalByteLength = payload.byteLength + blobs.reduce((sum, blob) => sum + blob.byteLength, 0)
      const transfer: PreparedSyncTransfer<SyncBatchV2> = {
        batch,
        payloadSha256: payload.sha256,
        payloadPath,
        payloadByteLength: payload.byteLength,
        blobSourcePaths,
        transferRoot,
        updatedAt,
        expiresAt,
      }
      await writeJsonAtomic(path.join(transferRoot, 'state.json'), {
        version: 2,
        peerDeviceId,
        batchId,
        payloadSha256: payload.sha256,
        payloadByteLength: payload.byteLength,
        totalByteLength,
        blobSourcePaths,
        updatedAt,
        expiresAt,
      } satisfies PersistedOutgoingTransfer)
      return transfer
    } catch (error) {
      await fs.promises.rm(transferRoot, { recursive: true, force: true })
      throw error
    }
  }

  /** Apply one already prepared transport payload. Replays are receipt-idempotent. */
  async applyPreparedTransfer(transfer: PreparedSyncTransfer): Promise<SyncApplyResult> {
    const { batch } = transfer
    validateBatchEnvelope(batch, this.deviceId)
    const actualPayloadHash = transfer.payloadPath
      ? await sha256File(transfer.payloadPath)
      : stablePayloadSha256(batch)
    if (actualPayloadHash !== transfer.payloadSha256) throw new Error('同步批次内容校验失败')

    if (this.database.hasSyncReceipt(batch.senderDeviceId, batch.batchId, actualPayloadHash)) {
      return {
        batchId: batch.batchId,
        status: 'duplicate',
        appliedRecords: 0,
        unchangedRecords: batch.records.length,
        importedBlobs: 0,
        senderRevision: batch.senderRevision,
        localRevision: this.database.getSyncRevision(),
      }
    }

    const importedPublicationIds: string[] = []
    let mergeCommitted = false
    try {
      const importedBlobs = await this.importMissingBlobs(transfer, importedPublicationIds)
      const currentData = this.database.exportPortableUserData()
      const before = logicalValuesByIdentity(portableDataToLogicalRecords(currentData, () => 0))
      const portable = logicalRecordsToPortableData(batch.records, currentData.settings)
      this.database.applyIncomingSyncData(portable, {
        senderDeviceId: batch.senderDeviceId,
        batchId: batch.batchId,
        payloadSha256: actualPayloadHash,
        senderThroughRevision: batch.senderRevision,
      })
      mergeCommitted = true

      const after = logicalValuesByIdentity(portableDataToLogicalRecords(
        this.database.exportPortableUserData(),
        () => 0,
      ))
      let appliedRecords = 0
      for (const record of batch.records) {
        const identity = entityIdentity(record.type, record.key)
        const incomingValue = stableJson(record.value)
        if (after.get(identity) === incomingValue && before.get(identity) !== incomingValue) appliedRecords++
      }

      // Database visibility, receipt and inbound cursor are already committed
      // atomically. Physical source cleanup is best-effort and can be retried
      // later without exposing a deleted publication again.
      await this.removeDeletedPublicationFiles(batch.records).catch(() => undefined)

      return {
        batchId: batch.batchId,
        status: 'applied',
        appliedRecords,
        unchangedRecords: batch.records.length - appliedRecords,
        importedBlobs,
        senderRevision: batch.senderRevision,
        localRevision: this.database.getSyncRevision(),
      }
    } catch (error) {
      if (!mergeCommitted && importedPublicationIds.length > 0) {
        try {
          await this.library.purgeImportedPublications(importedPublicationIds)
        } catch {
          // Preserve the original validation/merge error; a future retry is
          // still safe because content hashes make imported blobs idempotent.
        }
      }
      throw error
    }
  }

  createPeerSummary(senderDeviceId: string, changedSinceRevision: number): SyncPeerSummaryV2 {
    if (!senderDeviceId || senderDeviceId === this.deviceId) throw new Error('同步发送设备无效')
    if (!Number.isSafeInteger(changedSinceRevision) || changedSinceRevision < 0) {
      throw new Error('同步 revision 无效')
    }
    const peer = this.database.getSyncPeerState(senderDeviceId)
    return {
      modelVersion: SYNC_MODEL_VERSION,
      deviceId: this.deviceId,
      currentRevision: this.database.getSyncRevision(),
      lastAppliedSenderRevision: peer?.inboundAppliedRevision ?? 0,
      changedEntitiesSinceRevision: changedSinceRevision,
      changedEntities: this.database.listSyncEntityRevisions(changedSinceRevision).map(databaseEntityRef),
      availableBlobHashes: [...new Set(this.database.listPortableBooks().map((book) => book.hash))].sort(),
    }
  }

  previewIncomingBatch(batch: SyncBatchV2): IncomingSyncPreviewPlan {
    validateBatchEnvelope(batch, this.deviceId)
    const current = new Map(portableDataToLogicalRecords(
      this.database.exportPortableUserData(),
      () => 0,
    ).map((record) => [entityIdentity(record.type, record.key), record]))
    let newPublications = 0
    let updatedRecords = 0
    let deletedPublications = 0

    for (const record of batch.records) {
      const existing = current.get(entityIdentity(record.type, record.key))
      if (existing && stableJson(existing.value) === stableJson(record.value)) continue
      if (existing && isImmutableSyncRecord(record.type)) {
        throw new Error('同步批次中的不可变学习记录与本机数据冲突')
      }

      if (record.type === 'publication-lifecycle') {
        const currentState = existing?.type === 'publication-lifecycle' ? existing.value.state : null
        if (record.value.state === 'present' && currentState !== 'present') {
          newPublications++
          continue
        }
        if (record.value.state === 'deleted' && currentState === 'present') {
          deletedPublications++
          continue
        }
      }
      updatedRecords++
    }

    const missingBlobs = batch.blobs.filter((blob) =>
      !this.database.findPublicationIdByHash(blob.contentSha256),
    )
    const totalBytes = missingBlobs.reduce((sum, blob) => sum + blob.byteLength, 0)
    if (!Number.isSafeInteger(totalBytes)) throw new Error('同步刊物包总大小无效')
    return {
      totalRecords: batch.records.length,
      newPublications,
      updatedRecords,
      deletedPublications,
      missingBlobHashes: missingBlobs.map((blob) => blob.sha256),
      totalBytes,
    }
  }

  private currentRevisionByIdentity(): Map<string, number> {
    return new Map(this.database.listSyncEntityRevisions(0).map((row) => {
      const ref = databaseEntityRef(row)
      return [entityIdentity(ref.type, ref.key), ref.revision]
    }))
  }

  acknowledgeTransfer(peerDeviceId: string, senderRevision: number, peerRevision: number): void {
    const current = this.database.getSyncPeerState(peerDeviceId)
    this.database.saveSyncPeerState(peerDeviceId, {
      outboundAckedRevision: Math.max(current?.outboundAckedRevision ?? 0, senderRevision),
      inboundAppliedRevision: current?.inboundAppliedRevision ?? 0,
      // The loopback call is serialized. Advancing through the receiver's
      // post-apply revision suppresses echoes generated by this same push.
      peerInspectedRevision: Math.max(current?.peerInspectedRevision ?? 0, peerRevision),
    })
  }

  private async importMissingBlobs(
    transfer: PreparedSyncTransfer,
    importedPublicationIds: string[],
  ): Promise<number> {
    let importedBlobs = 0
    for (const blob of transfer.batch.blobs) {
      const contentHash = blob.kind === 'publication-package' ? blob.contentSha256 : blob.sha256
      if (this.database.findPublicationIdByHash(contentHash)) continue
      const sourcePath = transfer.blobSourcePaths[blob.sha256]
      if (!sourcePath) throw new Error(`同步批次缺少刊物文件：${blob.sha256}`)
      const stat = await fs.promises.stat(sourcePath)
      if (!stat.isFile() || stat.size !== blob.byteLength) throw new Error('同步刊物文件大小不一致')
      if (await sha256File(sourcePath) !== blob.sha256) throw new Error('同步刊物文件哈希不一致')
      const imported = blob.kind === 'publication-package'
        ? await this.publicationPackages.importPackage(sourcePath, {
            publicationId: blob.publicationId,
            sourceFormat: blob.formatId,
            sourceContentSha256: blob.contentSha256,
          })
        : await this.library.importFile(sourcePath)
      if (imported.publication.id !== blob.publicationId) {
        if (!imported.duplicate) await this.library.purgeImportedPublications([imported.publication.id])
        throw new Error('同步刊物稳定标识不一致')
      }
      if (!imported.duplicate) {
        importedPublicationIds.push(imported.publication.id)
        // Import creates receiver provenance. Remove it before applying the
        // sender's lifecycle record so the transported provenance wins.
        this.database.clearPublicationLifecycleForRestore(imported.publication.id)
        importedBlobs++
      }
    }
    return importedBlobs
  }

  async cleanupPreparedTransfer(transfer: PreparedSyncTransfer): Promise<void> {
    await fs.promises.rm(transfer.transferRoot ?? path.join(this.syncOutbox, transfer.batch.batchId), { recursive: true, force: true })
  }

  async discardPreparedTransfer(transferId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(transferId)) throw new Error('同步批次标识无效')
    await fs.promises.rm(path.join(this.syncOutbox, transferId), { recursive: true, force: true })
  }

  async listResumableTransfers(): Promise<Array<Pick<PersistedOutgoingTransfer,
    'peerDeviceId' | 'batchId' | 'payloadByteLength' | 'totalByteLength' | 'updatedAt' | 'expiresAt'>>> {
    const result: Array<Pick<PersistedOutgoingTransfer,
      'peerDeviceId' | 'batchId' | 'payloadByteLength' | 'totalByteLength' | 'updatedAt' | 'expiresAt'>> = []
    for (const directory of await fs.promises.readdir(this.syncOutbox, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const root = path.join(this.syncOutbox, directory.name)
      const state = await readOutgoingState(path.join(root, 'state.json'))
      if (!state || state.batchId !== directory.name || Date.parse(state.expiresAt) <= Date.now()) {
        await fs.promises.rm(root, { recursive: true, force: true })
        continue
      }
      result.push(state)
    }
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  private async loadResumableTransfer(peerDeviceId: string): Promise<PreparedSyncTransfer<SyncBatchV2> | null> {
    const candidates = await this.listResumableTransfers()
    for (const candidate of candidates) {
      if (candidate.peerDeviceId !== peerDeviceId) continue
      const transferRoot = path.join(this.syncOutbox, candidate.batchId)
      const state = await readOutgoingState(path.join(transferRoot, 'state.json'))
      if (!state) continue
      try {
        const payloadPath = path.join(transferRoot, 'batch.ndjson')
        const stat = await fs.promises.stat(payloadPath)
        if (!stat.isFile() || stat.size !== state.payloadByteLength
          || await sha256File(payloadPath) !== state.payloadSha256) throw new Error('同步恢复载荷已变化')
        const batch = await readBatchPayload(payloadPath)
        if (batch.batchId !== state.batchId || batch.recipientDeviceId !== peerDeviceId) {
          throw new Error('同步恢复批次身份不匹配')
        }
        for (const blob of batch.blobs) {
          const sourcePath = state.blobSourcePaths[blob.sha256]
          if (!sourcePath) throw new Error('同步恢复刊物包未声明')
          const blobStat = await fs.promises.stat(sourcePath)
          if (!blobStat.isFile() || blobStat.size !== blob.byteLength
            || await sha256File(sourcePath) !== blob.sha256) throw new Error('同步恢复刊物包已变化')
        }
        return {
          batch,
          payloadSha256: state.payloadSha256,
          payloadPath,
          payloadByteLength: state.payloadByteLength,
          blobSourcePaths: state.blobSourcePaths,
          transferRoot,
          updatedAt: state.updatedAt,
          expiresAt: state.expiresAt,
        }
      } catch {
        await fs.promises.rm(transferRoot, { recursive: true, force: true })
      }
    }
    return null
  }

  private removeExpiredOutgoingTransfersSync(): void {
    for (const directory of fs.readdirSync(this.syncOutbox, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const root = path.join(this.syncOutbox, directory.name)
      try {
        const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')) as PersistedOutgoingTransfer
        if (!validOutgoingState(state) || Date.parse(state.expiresAt) <= Date.now()) {
          fs.rmSync(root, { recursive: true, force: true })
        }
      } catch {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  }

  private async removeDeletedPublicationFiles(records: readonly LogicalRecordV1[]): Promise<void> {
    const deletedIds = records
      .filter((record): record is Extract<LogicalRecordV1, { type: 'publication-lifecycle' }> =>
        record.type === 'publication-lifecycle' && record.value.state === 'deleted')
      .map((record) => record.value.publicationId)
    await Promise.all([...new Set(deletedIds)].map((publicationId) =>
      fs.promises.rm(path.join(this.userDataPath, 'library', publicationId), {
        recursive: true,
        force: true,
      }),
    ))
  }
}

export function databaseEntityRef(row: {
  entityType: string
  entityKey: string
  revision: number
}): SyncEntityRef {
  const type = ENTITY_TYPE_BY_TABLE[row.entityType as DatabaseEntityType]
  if (!type) throw new Error(`未知同步实体表：${row.entityType}`)
  return { type, key: row.entityKey, revision: row.revision }
}

export function portableDataToLogicalRecords(
  data: PortableUserData,
  revisionFor: (type: SyncEntityType, key: string) => number = () => 0,
): LogicalRecordV1[] {
  const records: LogicalRecordV1[] = []
  const add = <T extends LogicalRecordV1>(record: Omit<T, 'revision'>) => {
    records.push({ ...record, revision: revisionFor(record.type, record.key) } as T)
  }

  for (const row of data.publicationLifecycle) add({
    type: 'publication-lifecycle', key: row.publicationId,
    value: {
      publicationId: row.publicationId,
      contentHash: row.contentHash,
      formatId: row.formatId,
      title: row.titleSnapshot,
      state: row.state,
      changedAt: row.changedAt,
      deviceId: row.deviceId,
    },
  })
  for (const row of data.settings) add({
    type: 'setting', key: row.key,
    value: {
      key: row.key,
      value: projectSettingValue(row.key, parseJsonValue(row.value)),
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
    },
  })
  for (const row of data.readingPositions) add({
    type: 'reading-position', key: row.publicationId,
    value: {
      publicationId: row.publicationId,
      articleId: row.articleId,
      scrollTop: row.scrollTop,
      blockId: row.anchorBlockId,
      tokenIndex: row.anchorTokenIndex,
      blockFraction: row.anchorFraction,
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
    },
  })
  for (const row of data.userLexemes) add({
    type: 'user-lexeme', key: row.lexemeKey,
    value: {
      lexemeKey: row.lexemeKey,
      lemmaSnapshot: row.lemmaSnapshot,
      phoneticSnapshot: row.phoneticSnapshot,
      briefMeanings: parseJsonArray(row.briefMeaningsJson),
      senseGroups: parseJsonArray(row.senseGroupsJson),
      bncRank: row.bncRank,
      frequencyRank: row.frequencyRank,
      manualState: row.manualState,
      manualFamiliarity: row.manualFamiliarity,
      createdAt: row.createdAt,
      snapshotProvider:row.snapshotProvider,snapshotQuality:row.snapshotQuality,
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
    },
  })
  for(const row of data.lexemeExamples)add({type:'lexeme-example',key:row.exampleId,value:{...row}})
  for (const row of data.vocabularySources) add({
    type: 'vocabulary-source', key: row.sourceId,
    value: {
      sourceId: row.sourceId,
      lexemeKey: row.lexemeKey,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      active: row.active,
      addedAt: row.addedAt,
      removedAt: row.removedAt,
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
    },
  })
  for (const row of data.savedContexts) add({
    type: 'saved-context', key: row.contextId,
    value: {
      contextId: row.contextId,
      lexemeKey: row.lexemeKey,
      surface: row.surface,
      publicationId: row.publicationId,
      publicationTitle: row.publicationTitle,
      articleId: row.articleId,
      articleTitle: row.articleTitle,
      blockId: row.blockId,
      tokenIndex: row.tokenIndex,
      sentence: row.sentence,
      paragraph: row.paragraph,
      sentenceHash: row.sentenceHash,
      active: row.active,
      savedAt: row.savedAt,
      removedAt: row.removedAt,
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
    },
  })

  for (const row of data.studyPlans) add({
    type: 'study-plan', key: row.planId,
    value: jsonObject({
      planId: row.planId, name: row.name, status: row.status,
      dailyNewLimit: row.dailyNewLimit, dailyReviewLimit: row.dailyReviewLimit,
      newOrder: row.newOrder, createdAt: row.createdAt, updatedAt: row.updatedAt,
      deviceId: row.deviceId, deletedAt: row.deletedAt,
    }),
  })
  for (const row of data.studyPlanSources) add({
    type: 'study-plan-source', key: row.sourceId,
    value: jsonObject({
      sourceId: row.sourceId, planId: row.planId, sourceType: row.sourceType,
      sourceRef: row.sourceRef, active: row.active, addedAt: row.addedAt,
      removedAt: row.removedAt, updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.studyPlanOrigins) add({
    type: 'study-plan-origin', key: row.originId,
    value: jsonObject({
      originId: row.originId, planId: row.planId, planSourceId: row.planSourceId,
      lexemeKey: row.lexemeKey, active: row.active, discoveredAt: row.discoveredAt,
      removedAt: row.removedAt, updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.studyPlanExclusions) add({
    type: 'study-plan-exclusion', key: studyPlanExclusionKey(row.planId, row.lexemeKey),
    value: jsonObject({
      planId: row.planId, lexemeKey: row.lexemeKey, excluded: row.excluded,
      excludedAt: row.excludedAt, restoredAt: row.restoredAt,
      updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.schedulerProfiles) add({
    type: 'scheduler-profile', key: row.profileId,
    value: jsonObject({
      profileId: row.profileId, fsrsVersion: row.fsrsVersion,
      parametersJson: row.parametersJson, parametersHash: row.parametersHash,
      createdAt: row.createdAt,
    }),
  })
  for (const row of data.reviewCards) add({
    type: 'review-card', key: row.lexemeKey,
    value: jsonObject({
      lexemeKey: row.lexemeKey, dueAt: row.dueAt, stability: row.stability,
      difficulty: row.difficulty, elapsedDays: row.elapsedDays,
      scheduledDays: row.scheduledDays, learningSteps: row.learningSteps,
      reps: row.reps, lapses: row.lapses, state: row.state,
      lastReviewAt: row.lastReviewAt, updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.reviewEvents) add({
    type: 'review-event', key: row.eventId,
    value: jsonObject({
      eventId: row.eventId, commandId: row.commandId, lexemeKey: row.lexemeKey,
      planId: row.planId, answer: row.answer, rating: row.rating,
      profileId: row.profileId, preCardJson: row.preCardJson,
      postCardJson: row.postCardJson, logJson: row.logJson,
      reviewedAt: row.reviewedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.reinforcementEvents) add({
    type: 'reinforcement-event', key: row.eventId,
    value: jsonObject({
      eventId: row.eventId, commandId: row.commandId, lexemeKey: row.lexemeKey,
      planId: row.planId, answer: row.answer,
      consecutiveBefore: row.consecutiveBefore, consecutiveAfter: row.consecutiveAfter,
      createdAt: row.createdAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.reviewSuspensions) add({
    type: 'review-suspension', key: row.lexemeKey,
    value: jsonObject({
      lexemeKey: row.lexemeKey, active: row.active, reason: row.reason,
      suspendedAt: row.suspendedAt, restoredAt: row.restoredAt,
      updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.studyProgressState) add({
    type: 'study-progress-state', key: row.stateId,
    value: jsonObject({
      stateId: row.stateId, resetAt: row.resetAt,
      updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  for (const row of data.studyLexemeResets) add({
    type: 'study-lexeme-reset', key: row.lexemeKey,
    value: jsonObject({
      lexemeKey: row.lexemeKey, resetAt: row.resetAt,
      updatedAt: row.updatedAt, deviceId: row.deviceId,
    }),
  })
  return records
}

export function logicalRecordsToPortableData(
  records: readonly LogicalRecordV1[],
  currentSettings: readonly PortableSettingRecord[] = [],
): PortableUserData {
  const data = emptyPortableUserData()
  const currentSettingValues = new Map(currentSettings.map((setting) => [
    setting.key,
    parseJsonValue(setting.value),
  ]))
  for (const record of records) {
    switch (record.type) {
      case 'publication-lifecycle': data.publicationLifecycle.push({
        publicationId: record.value.publicationId,
        contentHash: record.value.contentHash,
        formatId: record.value.formatId,
        titleSnapshot: record.value.title,
        state: record.value.state,
        changedAt: record.value.changedAt,
        deviceId: record.value.deviceId,
      }); break
      case 'setting': data.settings.push({
        key: record.value.key,
        value: stableJson(mergeSettingProjection(
          record.value.key,
          currentSettingValues.get(record.value.key),
          record.value.value,
        )),
        updatedAt: record.value.updatedAt,
        deviceId: record.value.deviceId,
      }); break
      case 'reading-position': data.readingPositions.push({
        publicationId: record.value.publicationId,
        articleId: record.value.articleId,
        scrollTop: record.value.scrollTop,
        anchorBlockId: record.value.blockId,
        anchorTokenIndex: record.value.tokenIndex,
        anchorFraction: record.value.blockFraction ?? 0,
        updatedAt: record.value.updatedAt,
        deviceId: record.value.deviceId,
      }); break
      case 'user-lexeme': data.userLexemes.push({
        lexemeKey: record.value.lexemeKey,
        lemmaSnapshot: record.value.lemmaSnapshot,
        phoneticSnapshot: record.value.phoneticSnapshot,
        briefMeaningsJson: stableJson(record.value.briefMeanings),
        senseGroupsJson: stableJson(record.value.senseGroups),
        bncRank: record.value.bncRank,
        frequencyRank: record.value.frequencyRank,
        manualState: record.value.manualState,
        manualFamiliarity: record.value.manualFamiliarity,
        createdAt: record.value.createdAt,
        updatedAt: record.value.updatedAt,
        deviceId: record.value.deviceId,
        snapshotProvider:record.value.snapshotProvider,snapshotQuality:record.value.snapshotQuality,
      }); break
      case 'lexeme-example': data.lexemeExamples.push({...record.value}); break
      case 'vocabulary-source': data.vocabularySources.push({
        sourceId: record.value.sourceId,
        lexemeKey: record.value.lexemeKey,
        sourceType: record.value.sourceType,
        sourceRef: record.value.sourceRef,
        active: record.value.active,
        addedAt: record.value.addedAt,
        removedAt: record.value.removedAt,
        updatedAt: record.value.updatedAt,
        deviceId: record.value.deviceId,
      }); break
      case 'saved-context': data.savedContexts.push({
        contextId: record.value.contextId,
        lexemeKey: record.value.lexemeKey,
        surface: record.value.surface,
        publicationId: record.value.publicationId,
        publicationTitle: record.value.publicationTitle,
        articleId: record.value.articleId,
        articleTitle: record.value.articleTitle,
        blockId: record.value.blockId,
        tokenIndex: record.value.tokenIndex,
        sentence: record.value.sentence,
        paragraph: record.value.paragraph,
        sentenceHash: record.value.sentenceHash,
        active: record.value.active,
        savedAt: record.value.savedAt,
        removedAt: record.value.removedAt,
        updatedAt: record.value.updatedAt,
        deviceId: record.value.deviceId,
      }); break
      case 'study-plan': data.studyPlans.push(portableStudyPlan(record.value)); break
      case 'study-plan-source': data.studyPlanSources.push(portableStudyPlanSource(record.value)); break
      case 'study-plan-origin': data.studyPlanOrigins.push(portableStudyPlanOrigin(record.value)); break
      case 'study-plan-exclusion': data.studyPlanExclusions.push(portableStudyPlanExclusion(record.value)); break
      case 'scheduler-profile': data.schedulerProfiles.push(portableSchedulerProfile(record.value)); break
      case 'review-card': data.reviewCards.push(portableReviewCard(record.value)); break
      case 'review-event': data.reviewEvents.push(portableReviewEvent(record.value)); break
      case 'reinforcement-event': data.reinforcementEvents.push(portableReinforcementEvent(record.value)); break
      case 'review-suspension': data.reviewSuspensions.push(portableReviewSuspension(record.value)); break
      case 'study-progress-state': data.studyProgressState.push(portableStudyProgressState(record.value)); break
      case 'study-lexeme-reset': data.studyLexemeResets.push(portableStudyLexemeReset(record.value)); break
    }
  }
  return data
}

export function stablePayloadSha256(batch: SyncBatch): string {
  return crypto.createHash('sha256').update(stableJson(batch)).digest('hex')
}

function emptyPortableUserData(): PortableUserData {
  return {
    publicationLifecycle: [], settings: [], readingPositions: [], userLexemes: [], lexemeExamples: [],
    vocabularySources: [], savedContexts: [], studyPlans: [], studyPlanSources: [],
    studyPlanOrigins: [], studyPlanExclusions: [], schedulerProfiles: [], reviewCards: [],
    reviewEvents: [], reinforcementEvents: [], reviewSuspensions: [],
    studyProgressState: [], studyLexemeResets: [],
  }
}

export function validateBatchEnvelope(batch: SyncBatch, recipientDeviceId: string): void {
  if (batch.modelVersion !== 1 && batch.modelVersion !== SYNC_MODEL_VERSION) throw new Error('同步模型版本不兼容')
  if (batch.recipientDeviceId !== recipientDeviceId) throw new Error('同步批次接收设备不匹配')
  if (!batch.senderDeviceId || batch.senderDeviceId === recipientDeviceId) throw new Error('同步批次发送设备无效')
  if (!batch.batchId) throw new Error('同步批次缺少标识')
  if (!Number.isSafeInteger(batch.senderRevision) || batch.senderRevision < 0) throw new Error('同步批次 revision 无效')
  if (!Number.isFinite(Date.parse(batch.createdAt))) throw new Error('同步批次时间无效')
  const recordIdentities = new Set<string>()
  const presentPublications = new Map<string, Extract<LogicalRecordV1, {type:'publication-lifecycle'}>['value']>()
  for (const record of batch.records) {
    if (!record.key || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('同步逻辑记录无效')
    const identity = entityIdentity(record.type, record.key)
    if (recordIdentities.has(identity)) throw new Error('同步批次包含重复逻辑记录')
    recordIdentities.add(identity)
    if (logicalRecordKey(record) !== record.key) throw new Error('同步逻辑记录标识不一致')
    if (record.type === 'publication-lifecycle') {
      if (!/^[a-f0-9]{64}$/.test(record.value.contentHash) || !['present','deleted'].includes(record.value.state)) throw new Error('同步刊物生命周期无效')
      if (record.value.state === 'present') presentPublications.set(record.value.contentHash, record.value)
    }
  }
  const blobs = new Map(batch.blobs.map((blob) => [blob.sha256, blob]))
  if (blobs.size !== batch.blobs.length) throw new Error('同步批次包含重复大对象')
  for (const blob of batch.blobs) {
    if (!/^[a-f0-9]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0) throw new Error('同步大对象描述无效')
    if ((batch.modelVersion === 1 && blob.kind !== 'publication-source')
      || (batch.modelVersion === SYNC_MODEL_VERSION && blob.kind !== 'publication-package')) {
      throw new Error('同步模型与刊物对象类型不一致')
    }
    const contentHash = blob.kind === 'publication-package' ? blob.contentSha256 : blob.sha256
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('同步刊物内容身份无效')
    const lifecycle = presentPublications.get(contentHash)
    if (!lifecycle || lifecycle.publicationId !== blob.publicationId || lifecycle.formatId !== blob.formatId) {
      throw new Error('同步大对象缺少对应的活动刊物记录')
    }
  }
}

function logicalRecordKey(record: LogicalRecordV1): string {
  switch (record.type) {
    case 'publication-lifecycle': return record.value.publicationId
    case 'setting': return record.value.key
    case 'reading-position': return record.value.publicationId
    case 'user-lexeme': return record.value.lexemeKey
    case 'lexeme-example': return record.value.exampleId
    case 'vocabulary-source': return record.value.sourceId
    case 'saved-context': return record.value.contextId
    case 'study-plan': return requireString(record.value, 'planId')
    case 'study-plan-source': return requireString(record.value, 'sourceId')
    case 'study-plan-origin': return requireString(record.value, 'originId')
    case 'study-plan-exclusion': return studyPlanExclusionKey(requireString(record.value, 'planId'), requireString(record.value, 'lexemeKey'))
    case 'scheduler-profile': return requireString(record.value, 'profileId')
    case 'review-card': return requireString(record.value, 'lexemeKey')
    case 'review-event':
    case 'reinforcement-event': return requireString(record.value, 'eventId')
    case 'review-suspension': return requireString(record.value, 'lexemeKey')
    case 'study-progress-state': return requireString(record.value, 'stateId')
    case 'study-lexeme-reset': return requireString(record.value, 'lexemeKey')
  }
}

function recordRef(record: LogicalRecordV1): SyncEntityRef {
  return { type: record.type, key: record.key, revision: record.revision }
}

function entityIdentity(type: SyncEntityType, key: string): string {
  return `${type}\u0000${key}`
}

function isImmutableSyncRecord(type: SyncEntityType): boolean {
  return type === 'scheduler-profile' || type === 'review-event' || type === 'reinforcement-event'
}

function studyPlanExclusionKey(planId: string, lexemeKey: string): string {
  return `${planId}\u001f${lexemeKey}`
}

function logicalValuesByIdentity(records: readonly LogicalRecordV1[]): Map<string, string> {
  return new Map(records.map((record) => [
    entityIdentity(record.type, record.key),
    stableJson(record.value),
  ]))
}

function projectSettingValue(key: string, value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value
  switch (key) {
    case 'reader.preferences': return pickJson(value, ['theme', 'fontSize', 'lineHeight', 'paperTint'])
    case 'speech.preferences': return pickJson(value, [
      'locale', 'rate', 'autoPlayStudy', 'wordProviderId', 'articleProviderId', 'providerSettings',
    ])
    case 'library.management': return pickJson(value, ['categories', 'items'])
    default: return value
  }
}

function mergeSettingProjection(key: string, current: JsonValue | undefined, incoming: JsonValue): JsonValue {
  if (!isJsonObject(incoming)) return incoming
  if (!['reader.preferences', 'speech.preferences', 'library.management'].includes(key)) return incoming
  return { ...(isJsonObject(current) ? current : {}), ...incoming }
}

function pickJson(value: JsonObject, keys: readonly string[]): JsonObject {
  const result: JsonObject = {}
  for (const key of keys) if (key in value) result[key] = value[key]
  return result
}

function parseJsonValue(value: string): JsonValue {
  return JSON.parse(value) as JsonValue
}

function parseJsonArray(value: string): JsonValue[] {
  const parsed = parseJsonValue(value)
  if (!Array.isArray(parsed)) throw new Error('同步 JSON 字段必须是数组')
  return parsed
}

function jsonObject<T extends Record<string, JsonValue>>(value: T): T & JsonObject { return value }
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: JsonObject, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`同步学习记录字段无效：${key}`)
  return field
}
function optionalString(value: JsonObject, key: string): string | null {
  const field = value[key]
  if (field === null) return null
  if (typeof field !== 'string') throw new Error(`同步学习记录字段无效：${key}`)
  return field
}
function requireNumber(value: JsonObject, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new Error(`同步学习记录字段无效：${key}`)
  return field
}
function requireBoolean(value: JsonObject, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`同步学习记录字段无效：${key}`)
  return field
}

function portableStudyPlan(value: JsonObject): PortableStudyPlanRecord {
  const status = requireString(value, 'status')
  const newOrder = requireString(value, 'newOrder')
  if (!['active', 'paused', 'archived'].includes(status)) throw new Error('同步学习计划状态无效')
  if (!['reader_first_frequency', 'deterministic_random'].includes(newOrder)) throw new Error('同步学习计划顺序无效')
  return {
    planId: requireString(value, 'planId'), name: requireString(value, 'name'),
    status: status as PortableStudyPlanRecord['status'],
    dailyNewLimit: requireNumber(value, 'dailyNewLimit'),
    dailyReviewLimit: requireNumber(value, 'dailyReviewLimit'),
    newOrder: newOrder as PortableStudyPlanRecord['newOrder'],
    createdAt: requireString(value, 'createdAt'), updatedAt: requireString(value, 'updatedAt'),
    deviceId: requireString(value, 'deviceId'), deletedAt: optionalString(value, 'deletedAt'),
  }
}

function portableStudyPlanSource(value: JsonObject): PortableStudyPlanSourceRecord {
  const sourceType = requireString(value, 'sourceType')
  if (!['reader_manual', 'exam_collection'].includes(sourceType)) throw new Error('同步学习来源类型无效')
  return {
    sourceId: requireString(value, 'sourceId'), planId: requireString(value, 'planId'),
    sourceType: sourceType as PortableStudyPlanSourceRecord['sourceType'],
    sourceRef: requireString(value, 'sourceRef'), active: requireBoolean(value, 'active'),
    addedAt: requireString(value, 'addedAt'), removedAt: optionalString(value, 'removedAt'),
    updatedAt: requireString(value, 'updatedAt'), deviceId: requireString(value, 'deviceId'),
  }
}

function portableStudyPlanOrigin(value: JsonObject): PortableStudyPlanOriginRecord {
  return {
    originId: requireString(value, 'originId'), planId: requireString(value, 'planId'),
    planSourceId: requireString(value, 'planSourceId'), lexemeKey: requireString(value, 'lexemeKey'),
    active: requireBoolean(value, 'active'), discoveredAt: requireString(value, 'discoveredAt'),
    removedAt: optionalString(value, 'removedAt'), updatedAt: requireString(value, 'updatedAt'),
    deviceId: requireString(value, 'deviceId'),
  }
}

function portableStudyPlanExclusion(value: JsonObject): PortableStudyPlanExclusionRecord {
  return {
    planId: requireString(value, 'planId'), lexemeKey: requireString(value, 'lexemeKey'),
    excluded: requireBoolean(value, 'excluded'), excludedAt: optionalString(value, 'excludedAt'),
    restoredAt: optionalString(value, 'restoredAt'), updatedAt: requireString(value, 'updatedAt'),
    deviceId: requireString(value, 'deviceId'),
  }
}

function portableSchedulerProfile(value: JsonObject): PortableSchedulerProfileRecord {
  return {
    profileId: requireString(value, 'profileId'), fsrsVersion: requireString(value, 'fsrsVersion'),
    parametersJson: requireString(value, 'parametersJson'), parametersHash: requireString(value, 'parametersHash'),
    createdAt: requireString(value, 'createdAt'),
  }
}

function portableReviewCard(value: JsonObject): PortableReviewCardRecord {
  return {
    lexemeKey: requireString(value, 'lexemeKey'), dueAt: requireString(value, 'dueAt'),
    stability: requireNumber(value, 'stability'), difficulty: requireNumber(value, 'difficulty'),
    elapsedDays: requireNumber(value, 'elapsedDays'), scheduledDays: requireNumber(value, 'scheduledDays'),
    learningSteps: requireNumber(value, 'learningSteps'), reps: requireNumber(value, 'reps'),
    lapses: requireNumber(value, 'lapses'), state: requireNumber(value, 'state'),
    lastReviewAt: optionalString(value, 'lastReviewAt'), updatedAt: requireString(value, 'updatedAt'),
    deviceId: requireString(value, 'deviceId'),
  }
}

function portableReviewEvent(value: JsonObject): PortableReviewEventRecord {
  const answer = requireString(value, 'answer')
  if (!['known', 'unknown'].includes(answer)) throw new Error('同步复习答案无效')
  return {
    eventId: requireString(value, 'eventId'), commandId: requireString(value, 'commandId'),
    lexemeKey: requireString(value, 'lexemeKey'), planId: optionalString(value, 'planId'),
    answer: answer as PortableReviewEventRecord['answer'], rating: requireNumber(value, 'rating'),
    profileId: requireString(value, 'profileId'), preCardJson: requireString(value, 'preCardJson'),
    postCardJson: requireString(value, 'postCardJson'), logJson: requireString(value, 'logJson'),
    reviewedAt: requireString(value, 'reviewedAt'), deviceId: requireString(value, 'deviceId'),
  }
}

function portableReinforcementEvent(value: JsonObject): PortableReinforcementEventRecord {
  const answer = requireString(value, 'answer')
  if (!['known', 'unknown', 'too_easy'].includes(answer)) throw new Error('同步强化答案无效')
  return {
    eventId: requireString(value, 'eventId'), commandId: requireString(value, 'commandId'),
    lexemeKey: requireString(value, 'lexemeKey'), planId: optionalString(value, 'planId'),
    answer: answer as PortableReinforcementEventRecord['answer'],
    consecutiveBefore: requireNumber(value, 'consecutiveBefore'),
    consecutiveAfter: requireNumber(value, 'consecutiveAfter'),
    createdAt: requireString(value, 'createdAt'), deviceId: requireString(value, 'deviceId'),
  }
}

function portableReviewSuspension(value: JsonObject): PortableReviewSuspensionRecord {
  return {
    lexemeKey: requireString(value, 'lexemeKey'), active: requireBoolean(value, 'active'),
    reason: requireString(value, 'reason'), suspendedAt: requireString(value, 'suspendedAt'),
    restoredAt: optionalString(value, 'restoredAt'), updatedAt: requireString(value, 'updatedAt'),
    deviceId: requireString(value, 'deviceId'),
  }
}

function portableStudyProgressState(value: JsonObject): PortableStudyProgressStateRecord {
  if (requireString(value, 'stateId') !== 'global') throw new Error('同步学习重置状态无效')
  return {
    stateId: 'global', resetAt: optionalString(value, 'resetAt'),
    updatedAt: requireString(value, 'updatedAt'), deviceId: requireString(value, 'deviceId'),
  }
}

function portableStudyLexemeReset(value: JsonObject): PortableStudyLexemeResetRecord {
  return {
    lexemeKey: requireString(value, 'lexemeKey'), resetAt: requireString(value, 'resetAt'),
    updatedAt: requireString(value, 'updatedAt'), deviceId: requireString(value, 'deviceId'),
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]))
  }
  return value
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function writeBatchPayload(
  destination: string,
  batch: SyncBatchV2,
): Promise<{ sha256: string; byteLength: number }> {
  const temporary = `${destination}.part`
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  const digest = crypto.createHash('sha256')
  let byteLength = 0
  try {
    for (const line of serializeLanSyncBatchV2(batch)) {
      const chunk = Buffer.from(line, 'utf8')
      byteLength += chunk.length
      if (byteLength > LAN_SYNC_LIMITS.batchMetadataBytes) throw new Error('同步批次元数据超过 512 MiB 限制')
      digest.update(chunk)
      if (!output.write(chunk)) await once(output, 'drain')
    }
    output.end()
    await once(output, 'close')
    await fs.promises.rename(temporary, destination)
    return { sha256: digest.digest('hex'), byteLength }
  } catch (error) {
    output.destroy()
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
}

export async function readBatchPayload(source: string): Promise<SyncBatchV2> {
  const stat = await fs.promises.stat(source)
  if (!stat.isFile() || stat.size <= 0 || stat.size > LAN_SYNC_LIMITS.batchMetadataBytes) {
    throw new Error('同步批次文件大小无效')
  }
  const input = fs.createReadStream(source)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let header: LanSyncBatchHeaderLineV2 | null = null
  const records: LogicalRecordV1[] = []
  const blobs: PublicationPackageBlobRefV2[] = []
  let blobSection = false
  try {
    for await (const sourceLine of lines) {
      const line = parseLanSyncBatchLineV2(sourceLine)
      if (!header) {
        if (line.kind !== 'header' || line.streamVersion !== LAN_SYNC_BATCH_STREAM_VERSION
          || line.modelVersion !== SYNC_MODEL_VERSION) throw new Error('同步批次头无效')
        if (!Number.isSafeInteger(line.recordCount) || line.recordCount < 0
          || line.recordCount > LAN_SYNC_LIMITS.records || !Number.isSafeInteger(line.blobCount)
          || line.blobCount < 0 || line.blobCount > LAN_SYNC_LIMITS.blobs) {
          throw new Error('同步批次声明数量超出限制')
        }
        header = line
        continue
      }
      if (line.kind === 'header') throw new Error('同步批次包含重复批次头')
      if (line.kind === 'record') {
        if (blobSection) throw new Error('同步批次记录顺序无效')
        records.push(line.record)
        if (records.length > header.recordCount) throw new Error('同步批次记录数量不匹配')
      } else {
        blobSection = true
        blobs.push(line.blob)
        if (blobs.length > header.blobCount) throw new Error('同步批次 Blob 数量不匹配')
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  if (!header || records.length !== header.recordCount || blobs.length !== header.blobCount) {
    throw new Error('同步批次内容不完整')
  }
  return {
    modelVersion: SYNC_MODEL_VERSION,
    batchId: header.batchId,
    senderDeviceId: header.senderDeviceId,
    recipientDeviceId: header.recipientDeviceId,
    createdAt: header.createdAt,
    mode: header.mode,
    fromSenderRevisionExclusive: header.fromSenderRevisionExclusive,
    senderRevision: header.senderRevision,
    inspectedPeerRevision: header.inspectedPeerRevision,
    records,
    blobs,
  }
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.part`
  await fs.promises.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await fs.promises.rename(temporary, destination)
}

async function readOutgoingState(source: string): Promise<PersistedOutgoingTransfer | null> {
  try {
    const value = JSON.parse(await fs.promises.readFile(source, 'utf8')) as PersistedOutgoingTransfer
    return validOutgoingState(value) ? value : null
  } catch {
    return null
  }
}

function validOutgoingState(value: PersistedOutgoingTransfer): boolean {
  return value?.version === 2
    && typeof value.peerDeviceId === 'string' && value.peerDeviceId.length > 0
    && /^[a-f0-9-]{36}$/i.test(value.batchId)
    && /^[a-f0-9]{64}$/i.test(value.payloadSha256)
    && Number.isSafeInteger(value.payloadByteLength) && value.payloadByteLength > 0
    && value.payloadByteLength <= LAN_SYNC_LIMITS.batchMetadataBytes
    && Number.isSafeInteger(value.totalByteLength) && value.totalByteLength >= value.payloadByteLength
    && value.blobSourcePaths != null && typeof value.blobSourcePaths === 'object'
    && Number.isFinite(Date.parse(value.updatedAt)) && Number.isFinite(Date.parse(value.expiresAt))
}
