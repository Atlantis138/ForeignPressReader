import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import Bonjour from 'bonjour-service'
import {
  LAN_SYNC_LIMITS,
  LAN_SYNC_BATCH_MEDIA_TYPE,
  LAN_SYNC_PORT,
  LAN_SYNC_PROTOCOL,
  LAN_SYNC_SERVICE_TYPE,
  LAN_SYNC_SUPPORTED_WIRE_VERSIONS,
  LAN_SYNC_WIRE_VERSION,
  assertLanSyncWireVersion,
  deriveLanSyncPairingCode,
  deriveLanSyncTrustToken,
  isLanSyncPeerVerificationFresh,
  lanSyncResponseTimeoutMs,
  shouldRetainLanSyncCandidate,
  type LanSyncCommitResponse,
  type LanSyncDiscoveryAnnouncementV2,
  type LanSyncVerifiedDiscoveryRecordV2,
  type LanSyncInfoResponseV2,
  type LanSyncPairPrepareRequest,
  type LanSyncPairPrepareResponse,
  type LanSyncPairStatusResponse,
  type LanSyncPeerIdentity,
  type LanSyncPrepareDescriptorV2,
  type LanSyncPrepareResponseV2,
  type LanSyncSummaryPageV2,
  type LanSyncTransferPreview,
  type LanSyncTransferStatusResponse,
} from '../core/sync-wire'
import {
  SYNC_MODEL_VERSION,
  type SyncApplyResult,
  type SyncBatchV2,
  type SyncPeerSummaryV2,
} from '../core/sync-model'
import type {
  SyncCompletedResult,
  SyncDeviceSummary,
  SyncOperationState,
  SyncPageState,
  SyncPairingState,
  SyncTransferPreview,
} from '../shared/types'
import {
  SyncDataService,
  readBatchPayload,
  validateBatchEnvelope,
  type PreparedSyncTransfer,
} from './sync-data-service'
import { SyncIdentityStore, type SyncTrustedPeer } from './sync-identity-store'
import {
  LanSyncActiveDiscovery,
  lanSyncScanHosts,
  type LanSyncDiscoveryCandidate,
} from './lan-sync-discovery'

const API_ROOT = '/fprsync/v2'
const POLL_MS = 700

interface DiscoveredPeer extends LanSyncVerifiedDiscoveryRecordV2 {
  host: string
  lastSeenAt: string
  lastVerifiedAt: string | null
  reachability: SyncDeviceSummary['reachability']
  diagnostic: SyncDeviceSummary['diagnostic']
}

interface PairingRuntime {
  state: SyncPairingState
  peerIdentity: LanSyncPeerIdentity
  endpoint: DiscoveredPeer | null
  nonce: string
  localSecret: string
  remoteSecret: string | null
  senderSecret: string | null
  senderConfirmed: boolean
  abort: AbortController
}

interface IncomingTransfer {
  id: string
  sender: LanSyncPeerIdentity
  batch: SyncBatchV2 | null
  payloadSha256: string
  payloadByteLength: number
  payloadPath: string
  recordCount: number
  blobCount: number
  preview: LanSyncTransferPreview | null
  root: string
  blobPaths: Record<string, string>
  missingBlobHashes: string[]
  status: 'awaiting-batch' | 'waiting' | 'accepted' | 'applying' | 'rejected' | 'cancelled' | 'expired' | 'committed'
  expiresAt: string
  result?: SyncApplyResult
}

interface SummarySnapshot {
  id: string
  peerDeviceId: string
  summary: ReturnType<SyncDataService['createPeerSummary']>
  expiresAt: string
}

interface PersistedIncomingTransfer {
  version: 2
  id: string
  senderDeviceId: string
  payloadSha256: string
  payloadByteLength: number
  recordCount: number
  blobCount: number
  preview: LanSyncTransferPreview
  missingBlobHashes: string[]
  completedBlobHashes: string[]
  status: 'waiting' | 'accepted'
  expiresAt: string
  updatedAt: string
}

export class LanSyncService {
  private readonly identityStore: SyncIdentityStore
  private readonly inboxRoot: string
  private server: https.Server | null = null
  private bonjour: Bonjour | null = null
  private browser: ReturnType<Bonjour['find']> | null = null
  private advertisement: ReturnType<Bonjour['publish']> | null = null
  private activeDiscovery: LanSyncActiveDiscovery | null = null
  private discoveryScanTimer: NodeJS.Timeout | null = null
  private discoveryScanAbort: AbortController | null = null
  private readonly verificationInFlight = new Map<string, Promise<void>>()
  private nearby = new Map<string, DiscoveredPeer>()
  private pairing: PairingRuntime | null = null
  private incoming = new Map<string, IncomingTransfer>()
  private summarySnapshots = new Map<string, SummarySnapshot>()
  private operation: SyncOperationState | null = null
  private operationAbort: AbortController | null = null
  private lastCompleted: SyncCompletedResult | null = null
  private diagnostic: string | null = null
  private resumableTransfers: SyncPageState['resumableTransfers'] = []
  private active = false
  private port = 0
  private lifecycle: Promise<void> = Promise.resolve()

  constructor(
    private readonly syncData: SyncDataService,
    private readonly userDataPath: string,
  ) {
    this.identityStore = new SyncIdentityStore(userDataPath)
    this.inboxRoot = path.join(userDataPath, 'sync-inbox')
  }

  openPage(): Promise<SyncPageState> {
    return this.serializeLifecycle(() => this.openPageNow())
  }

  private async openPageNow(): Promise<SyncPageState> {
    if (this.active) return this.getState()
    await this.identityStore.initialize(this.syncData.deviceId)
    await fs.promises.mkdir(this.inboxRoot, { recursive: true })
    await removePartialFiles(this.inboxRoot)
    await this.loadIncomingTransfers()
    await this.refreshResumableTransfers()
    this.server = https.createServer({
      cert: this.identityStore.identity.certificatePem,
      key: this.identityStore.identity.privateKeyPem,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      requestTimeout: LAN_SYNC_LIMITS.transferLifetimeMs,
      headersTimeout: LAN_SYNC_LIMITS.connectTimeoutMs,
    }, (request, response) => { void this.handleRequest(request, response) })
    this.server.timeout = LAN_SYNC_LIMITS.blobIdleTimeoutMs
    try {
      this.port = await listen(this.server, LAN_SYNC_PORT)
    } catch (error) {
      this.diagnostic = `固定端口 ${LAN_SYNC_PORT} 无法使用；请关闭占用该端口的程序后重试。`
      throw error
    }
    try {
      this.active = true
      await this.startDiscovery()
      this.diagnostic = null
    } catch (error) {
      await closeServer(this.server)
      this.server = null
      this.port = 0
      throw error
    }
    return this.getState()
  }

  closePage(): Promise<void> {
    return this.serializeLifecycle(() => this.closePageNow())
  }

  private async closePageNow(): Promise<void> {
    this.active = false
    this.operationAbort?.abort()
    this.operationAbort = null
    this.pairing?.abort.abort()
    this.pairing = null
    this.operation = null
    this.activeDiscovery?.stop()
    this.activeDiscovery = null
    if (this.discoveryScanTimer) clearTimeout(this.discoveryScanTimer)
    this.discoveryScanTimer = null
    this.discoveryScanAbort?.abort()
    this.discoveryScanAbort = null
    this.browser?.stop()
    this.browser = null
    this.advertisement?.stop()
    this.advertisement = null
    this.bonjour?.destroy()
    this.bonjour = null
    if (this.server) await closeServer(this.server)
    this.server = null
    this.port = 0
    await removePartialFiles(this.inboxRoot)
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  getState(): SyncPageState {
    this.expireRuntimeState()
    const identity = this.identityStore.currentIdentity
    const localDevice = identity ? this.deviceSummary(this.localIdentity(), true, this.active ? 'online' : 'offline') : null
    const nearbyDevices = [...this.nearby.values()]
      .filter((peer) => peer.deviceId !== this.syncData.deviceId)
      .map((peer) => this.deviceSummary(peer, Boolean(this.identityStore.getPeer(peer.deviceId)), peer.reachability))
      .sort((left, right) => left.name.localeCompare(right.name))
    const nearbyIds = new Set(nearbyDevices.map((peer) => peer.deviceId))
    const trustedDevices = this.identityStore.listPeers().map((peer) => {
      const discovered = this.nearby.get(peer.deviceId)
      const identityChanged = Boolean(discovered && discovered.certificateSha256 !== peer.certificateSha256)
      const reachability: SyncDeviceSummary['reachability'] = identityChanged
        ? 'identity-changed' : discovered?.reachability ?? 'offline'
      return this.deviceSummary(discovered ?? peer, true, reachability)
    }).sort((left, right) => left.name.localeCompare(right.name))
    for (const peer of trustedDevices) {
      if (nearbyIds.has(peer.deviceId)) continue
      peer.online = false
      peer.reachability = 'offline'
    }
    const incoming = [...this.incoming.values()]
      .find((transfer) => transfer.status === 'waiting')
    return {
      active: this.active,
      localDevice,
      nearbyDevices,
      trustedDevices,
      pairing: this.pairing?.state ?? null,
      incoming: incoming ? this.publicIncoming(incoming) : null,
      operation: this.operation,
      resumableTransfers: this.resumableTransfers,
      lastCompleted: this.lastCompleted,
      diagnostic: this.diagnostic,
    }
  }

  async refreshDiscovery(): Promise<SyncPageState> {
    this.assertActive()
    this.activeDiscovery?.refresh()
    await this.scanLocalSubnet()
    return this.getState()
  }

  async discardPendingTransfer(transferId: string): Promise<SyncPageState> {
    const incoming = this.incoming.get(transferId)
    if (incoming) {
      if (incoming.status === 'applying') throw new Error('同步数据正在应用，无法丢弃')
      incoming.status = 'cancelled'
      await fs.promises.rm(incoming.root, { recursive: true, force: true })
      this.incoming.delete(transferId)
    } else {
      await this.syncData.discardPreparedTransfer(transferId)
    }
    await this.refreshResumableTransfers()
    return this.getState()
  }

  async startPairing(deviceId: string): Promise<SyncPageState> {
    this.assertActive()
    if (this.pairing?.state.status === 'waiting') throw new Error('已有设备配对正在进行')
    this.pairing = null
    const endpoint = this.requireDiscovered(deviceId)
    if (this.identityStore.getPeer(deviceId)) throw new Error('该设备已经受信任')
    const nonce = crypto.randomBytes(24).toString('hex')
    const localSecret = crypto.randomBytes(32).toString('hex')
    const abort = new AbortController()
    const response = await this.requestJson<LanSyncPairPrepareResponse>(endpoint, `${API_ROOT}/pair/prepare`, {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      sender: this.localIdentity(),
      nonce,
      senderSecret: localSecret,
    } satisfies LanSyncPairPrepareRequest, null, abort.signal)
    assertLanSyncWireVersion(response.wireVersion)
    assertPeerMatchesDiscovery(response.receiver, endpoint)
    const code = deriveLanSyncPairingCode({
      nonce,
      leftDeviceId: this.syncData.deviceId,
      rightDeviceId: response.receiver.deviceId,
      leftCertificateSha256: this.identityStore.identity.certificateSha256,
      rightCertificateSha256: response.receiver.certificateSha256,
    })
    if (response.code !== code || !Number.isFinite(Date.parse(response.expiresAt))) {
      throw new Error('设备配对校验失败')
    }
    this.pairing = {
      state: {
        sessionId: response.sessionId,
        direction: 'outgoing',
        peer: this.deviceSummary(endpoint, false, 'online'),
        code,
        localConfirmed: false,
        remoteConfirmed: false,
        status: 'waiting',
        message: '请核对两台设备上的六位数字，并分别确认。',
        expiresAt: response.expiresAt,
      },
      peerIdentity: response.receiver,
      endpoint,
      nonce,
      localSecret,
      remoteSecret: null,
      senderSecret: null,
      senderConfirmed: false,
      abort,
    }
    return this.getState()
  }

  async confirmPairing(sessionId: string): Promise<SyncPageState> {
    const pairing = this.requirePairing(sessionId)
    pairing.state.localConfirmed = true
    if (pairing.state.direction === 'incoming') {
      if (pairing.senderConfirmed) await this.finalizeIncomingPairing(pairing)
    } else {
      pairing.state.message = '已确认，正在等待另一台设备。'
      void this.finishOutgoingPairing(pairing)
    }
    return this.getState()
  }

  async rejectPairing(sessionId: string): Promise<SyncPageState> {
    const pairing = this.requirePairing(sessionId)
    pairing.state.status = 'rejected'
    pairing.state.message = '配对已拒绝。'
    pairing.abort.abort()
    if (pairing.state.direction === 'outgoing' && pairing.endpoint) {
      void this.requestJson(pairing.endpoint, `${API_ROOT}/pair/confirm`, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        sessionId,
        senderConfirmed: false,
      }, null).catch(() => undefined)
    }
    return this.getState()
  }

  async sendTo(deviceId: string): Promise<SyncPageState> {
    this.assertActive()
    if (operationIsActive(this.operation)) throw new Error('已有同步传输正在进行')
    this.operation = null
    this.operationAbort = null
    const trusted = this.identityStore.getPeer(deviceId)
    if (!trusted) throw new Error('请先完成设备配对')
    const endpoint = this.requireDiscovered(deviceId)
    if (endpoint.certificateSha256 !== trusted.certificateSha256) {
      throw new Error('设备证书已变化；请撤销信任后重新配对')
    }
    const abort = new AbortController()
    this.operationAbort = abort
    this.operation = {
      operationId: crypto.randomUUID(),
      direction: 'sending',
      peer: this.deviceSummary(endpoint, true, 'online'),
      stage: 'verifying-device',
      message: '正在验证设备身份与连接…',
      completedBytes: 0,
      totalBytes: 0,
      resumable: false,
    }
    void this.runSend(endpoint, trusted, abort).catch((error) => {
      if (abort.signal.aborted) {
        this.operation = this.operation && { ...this.operation, stage: 'resumable', message: '连接已中断，可重新发送继续。', resumable: true }
      } else {
        this.operation = this.operation && { ...this.operation, stage: 'error', message: safeMessage(error) }
      }
    }).finally(() => { if (this.operationAbort === abort) this.operationAbort = null })
    return this.getState()
  }

  async acceptIncoming(transferId: string): Promise<SyncPageState> {
    const transfer = this.requireIncoming(transferId)
    if (transfer.status !== 'waiting') throw new Error('该同步请求已经处理')
    if (!transfer.preview || !transfer.batch) throw new Error('同步批次尚未验证完成')
    transfer.status = 'accepted'
    this.operation = {
      operationId: transfer.id,
      direction: 'receiving',
      peer: this.deviceSummary(transfer.sender, true, 'online'),
      stage: 'waiting-confirmation',
      message: '已接受，正在等待发送端上传缺失内容…',
      completedBytes: 0,
      totalBytes: transfer.preview.totalBytes,
      resumable: true,
    }
    await writeIncomingState(transfer)
    await this.refreshResumableTransfers()
    return this.getState()
  }

  async rejectIncoming(transferId: string): Promise<SyncPageState> {
    const transfer = this.requireIncoming(transferId)
    if (transfer.status !== 'waiting') throw new Error('该同步请求已经处理')
    transfer.status = 'rejected'
    await fs.promises.rm(transfer.root, { recursive: true, force: true })
    this.incoming.delete(transfer.id)
    await this.refreshResumableTransfers()
    return this.getState()
  }

  async cancelOperation(): Promise<SyncPageState> {
    if (this.operation?.stage === 'applying'
      || [...this.incoming.values()].some((transfer) => transfer.status === 'applying')) {
      throw new Error('同步数据正在提交，完成前不能取消')
    }
    this.operationAbort?.abort()
    this.operationAbort = null
    if (this.operation) this.operation = { ...this.operation, stage: 'cancelled', message: '同步已取消。' }
    for (const transfer of this.incoming.values()) {
      if (transfer.status === 'accepted') {
        transfer.status = 'cancelled'
        await fs.promises.rm(transfer.root, { recursive: true, force: true })
        this.incoming.delete(transfer.id)
      }
    }
    if (this.operation?.direction === 'sending' && this.operation.resumable) {
      await this.syncData.discardPreparedTransfer(this.operation.operationId)
    }
    await this.refreshResumableTransfers()
    return this.getState()
  }

  async revokeTrust(deviceId: string): Promise<SyncPageState> {
    if (operationIsActive(this.operation) && this.operation?.peer.deviceId === deviceId) {
      throw new Error('该设备正在同步，无法撤销信任')
    }
    for (const transfer of [...this.incoming.values()]) {
      if (transfer.sender.deviceId !== deviceId) continue
      if (transfer.status === 'applying') throw new Error('该设备的数据正在应用，无法撤销信任')
      await fs.promises.rm(transfer.root, { recursive: true, force: true })
      this.incoming.delete(transfer.id)
    }
    for (const transfer of await this.syncData.listResumableTransfers()) {
      if (transfer.peerDeviceId === deviceId) await this.syncData.discardPreparedTransfer(transfer.batchId)
    }
    await this.identityStore.revoke(deviceId)
    this.nearby.delete(deviceId)
    await this.refreshResumableTransfers()
    return this.getState()
  }

  private async runSend(endpoint: DiscoveredPeer, trusted: SyncTrustedPeer, abort: AbortController): Promise<void> {
    let prepared: PreparedSyncTransfer<SyncBatchV2> | null = null
    let cleanupPrepared = false
    try {
      this.updateOperation('summarizing', '正在读取固定的分页摘要…')
      let page = await this.requestJson<LanSyncSummaryPageV2>(endpoint, `${API_ROOT}/summary`, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        changedSinceRevision: this.syncData.getPeerInspectedRevision(endpoint.deviceId),
      }, trusted, abort.signal)
      const changedEntities = [...page.changedEntities]
      const availableBlobHashes = [...page.availableBlobHashes]
      while (page.nextCursor) {
        page = await this.requestJson<LanSyncSummaryPageV2>(endpoint, `${API_ROOT}/summary`, {
          wireVersion: LAN_SYNC_WIRE_VERSION,
          snapshotId: page.snapshotId,
          cursor: page.nextCursor,
        }, trusted, abort.signal)
        changedEntities.push(...page.changedEntities)
        availableBlobHashes.push(...page.availableBlobHashes)
      }
      const summary: SyncPeerSummaryV2 = {
        modelVersion: SYNC_MODEL_VERSION,
        deviceId: page.deviceId,
        currentRevision: page.currentRevision,
        lastAppliedSenderRevision: page.lastAppliedSenderRevision,
        changedEntitiesSinceRevision: page.changedEntitiesSinceRevision,
        changedEntities,
        availableBlobHashes,
      }
      this.updateOperation('preparing', '正在生成增量批次与缺失刊物包…')
      prepared = await this.syncData.prepareSyncForPeer(endpoint.deviceId, summary)
      if (!prepared.payloadPath || prepared.payloadByteLength === undefined) {
        throw new Error('同步批次未生成流式载荷')
      }
      if (this.operation) {
        this.operation = {
          ...this.operation,
          operationId: prepared.batch.batchId,
          resumable: true,
          totalBytes: prepared.payloadByteLength + prepared.batch.blobs.reduce((sum, blob) => sum + blob.byteLength, 0),
        }
      }
      if (prepared.batch.records.length === 0 && prepared.batch.blobs.length === 0) {
        this.syncData.acknowledgeTransfer(
          endpoint.deviceId,
          prepared.batch.senderRevision,
          summary.currentRevision,
        )
        this.completeOperation(endpoint, 'sending', {
          appliedRecords: 0, unchangedRecords: 0, importedBlobs: 0,
        })
        cleanupPrepared = true
        return
      }
      let response = await this.requestJson<LanSyncPrepareResponseV2>(endpoint, `${API_ROOT}/prepare`, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        batchId: prepared.batch.batchId,
        payloadSha256: prepared.payloadSha256,
        payloadByteLength: prepared.payloadByteLength,
        recordCount: prepared.batch.records.length,
        blobCount: prepared.batch.blobs.length,
      } satisfies LanSyncPrepareDescriptorV2, trusted, abort.signal)
      assertLanSyncWireVersion(response.wireVersion)
      if (response.needsBatch) {
        this.updateOperation('uploading-batch', '正在发送流式同步批次…')
        await this.uploadFile(
          endpoint,
          `${API_ROOT}/transfer/${response.transferId}/batch`,
          prepared.payloadPath,
          prepared.payloadByteLength,
          trusted,
          abort.signal,
          LAN_SYNC_BATCH_MEDIA_TYPE,
          0,
        )
        response = await this.requestJson<LanSyncPrepareResponseV2>(endpoint, `${API_ROOT}/prepare`, {
          wireVersion: LAN_SYNC_WIRE_VERSION,
          batchId: prepared.batch.batchId,
          payloadSha256: prepared.payloadSha256,
          payloadByteLength: prepared.payloadByteLength,
          recordCount: prepared.batch.records.length,
          blobCount: prepared.batch.blobs.length,
        } satisfies LanSyncPrepareDescriptorV2, trusted, abort.signal)
      }
      if (response.status === 'committed' && response.result) {
        this.syncData.acknowledgeTransfer(endpoint.deviceId, prepared.batch.senderRevision, response.result.localRevision)
        this.completeOperation(endpoint, 'sending', response.result)
        cleanupPrepared = true
        return
      }
      this.operation = this.operation && {
        ...this.operation,
        stage: 'waiting-confirmation',
        message: '已发送差异预览，等待接收端确认…',
        totalBytes: response.preview.totalBytes,
        completedBytes: prepared.payloadByteLength,
        resumable: true,
      }
      let status: LanSyncTransferStatusResponse = {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        transferId: response.transferId,
        status: response.status,
        missingBlobHashes: response.missingBlobHashes,
      }
      while (status.status === 'waiting') {
        await delay(POLL_MS, abort.signal)
        status = await this.requestJson(endpoint, `${API_ROOT}/transfer/status`, {
          wireVersion: LAN_SYNC_WIRE_VERSION,
          transferId: response.transferId,
        }, trusted, abort.signal)
      }
      if (status.status !== 'accepted') {
        cleanupPrepared = true
        throw new Error(status.status === 'rejected' ? '接收端拒绝了本次同步' : '本次同步已取消或过期')
      }
      this.updateOperation('uploading', '正在发送接收端缺失的刊物内容…')
      let completedBefore = prepared.payloadByteLength
      for (const hash of status.missingBlobHashes) {
        const sourcePath = prepared.blobSourcePaths[hash]
        if (!sourcePath) throw new Error('发送批次缺少刊物包')
        const size = prepared.batch.blobs.find((blob) => blob.sha256 === hash)?.byteLength
        if (size === undefined) throw new Error('发送批次刊物包描述无效')
        await this.uploadFile(
          endpoint,
          `${API_ROOT}/transfer/${response.transferId}/blob/${hash}`,
          sourcePath,
          size,
          trusted,
          abort.signal,
          'application/vnd.foreign-press-reader.publication+zip',
          completedBefore,
        )
        completedBefore += size
      }
      this.updateOperation('applying', '刊物内容已发送，等待接收端原子应用…')
      const committed = await this.requestJson<LanSyncCommitResponse>(endpoint, `${API_ROOT}/commit`, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        transferId: response.transferId,
      }, trusted, abort.signal, lanSyncResponseTimeoutMs('apply'))
      assertLanSyncWireVersion(committed.wireVersion)
      this.syncData.acknowledgeTransfer(endpoint.deviceId, prepared.batch.senderRevision, committed.result.localRevision)
      this.completeOperation(endpoint, 'sending', committed.result)
      cleanupPrepared = true
    } finally {
      if (prepared && cleanupPrepared) await this.syncData.cleanupPreparedTransfer(prepared)
      await this.refreshResumableTransfers()
    }
  }

  private async finishOutgoingPairing(pairing: PairingRuntime): Promise<void> {
    if (!pairing.endpoint || pairing.state.status !== 'waiting') return
    try {
      await this.requestJson(pairing.endpoint, `${API_ROOT}/pair/confirm`, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        sessionId: pairing.state.sessionId,
        senderConfirmed: true,
      }, null, pairing.abort.signal)
      while (pairing.state.status === 'waiting') {
        await delay(POLL_MS, pairing.abort.signal)
        const response = await this.requestJson<LanSyncPairStatusResponse>(pairing.endpoint, `${API_ROOT}/pair/status`, {
          wireVersion: LAN_SYNC_WIRE_VERSION,
          sessionId: pairing.state.sessionId,
        }, null, pairing.abort.signal)
        assertLanSyncWireVersion(response.wireVersion)
        pairing.state.remoteConfirmed = response.receiverConfirmed
        if (response.status === 'waiting') continue
        if (response.status !== 'paired' || !response.receiverSecret) {
          pairing.state.status = response.status
          pairing.state.message = response.status === 'rejected' ? '另一台设备拒绝了配对。' : '配对请求已过期。'
          return
        }
        const token = deriveLanSyncTrustToken({
          leftDeviceId: this.syncData.deviceId,
          rightDeviceId: pairing.peerIdentity.deviceId,
          leftSecret: pairing.localSecret,
          rightSecret: response.receiverSecret,
        })
        await this.identityStore.trust(pairing.peerIdentity, token)
        pairing.state.status = 'paired'
        pairing.state.remoteConfirmed = true
        pairing.state.message = '设备已配对，可以开始增量同步。'
        pairing.state.peer.trusted = true
        return
      }
    } catch (error) {
      if (!pairing.abort.signal.aborted) {
        pairing.state.status = 'error'
        pairing.state.message = safeMessage(error)
      }
    }
  }

  private async finalizeIncomingPairing(pairing: PairingRuntime): Promise<void> {
    if (!pairing.senderSecret || !pairing.remoteSecret) throw new Error('配对密钥交换不完整')
    const token = deriveLanSyncTrustToken({
      leftDeviceId: pairing.peerIdentity.deviceId,
      rightDeviceId: this.syncData.deviceId,
      leftSecret: pairing.senderSecret,
      rightSecret: pairing.remoteSecret,
    })
    await this.identityStore.trust(pairing.peerIdentity, token)
    pairing.state.status = 'paired'
    pairing.state.remoteConfirmed = true
    pairing.state.message = '设备已配对，可以开始增量同步。'
    pairing.state.peer.trusted = true
  }

  private async startDiscovery(): Promise<void> {
    const identity = this.identityStore.identity
    this.activeDiscovery = new LanSyncActiveDiscovery({
      protocol: LAN_SYNC_PROTOCOL,
      discoveryVersion: LAN_SYNC_WIRE_VERSION,
      deviceId: identity.deviceId,
      name: localDeviceName(),
      platform: 'windows',
      port: LAN_SYNC_PORT,
      wireVersions: LAN_SYNC_SUPPORTED_WIRE_VERSIONS,
      modelVersion: SYNC_MODEL_VERSION,
      certificateSha256: identity.certificateSha256,
    }, (candidate) => this.onActiveDiscoveryCandidate(candidate), (message) => {
      this.diagnostic = message
    })
    await this.activeDiscovery.start()
    this.bonjour = new Bonjour(undefined, () => {
      this.diagnostic = '局域网发现不可用。请检查 Windows 防火墙、访客 Wi-Fi 或 AP 隔离设置。'
    })
    const txt: Record<string, string> = {
      p: LAN_SYNC_PROTOCOL,
      w: String(LAN_SYNC_WIRE_VERSION),
      m: String(SYNC_MODEL_VERSION),
      id: identity.deviceId,
      n: localDeviceName(),
      os: 'windows',
      fp: identity.certificateSha256,
    }
    this.advertisement = this.bonjour.publish({
      name: `FPR-${identity.deviceId.slice(0, 8)}`,
      type: LAN_SYNC_SERVICE_TYPE,
      protocol: 'tcp',
      port: this.port,
      txt,
      disableIPv6: false,
    })
    this.browser = this.bonjour.find({ type: LAN_SYNC_SERVICE_TYPE, protocol: 'tcp' })
    this.browser.on('up', (service) => this.onServiceUp(service))
    this.browser.on('txt-update', (service) => this.onServiceUp(service))
    this.browser.on('srv-update', (service) => this.onServiceUp(service))
    this.browser.on('down', () => undefined)
    this.discoveryScanTimer = setTimeout(() => {
      this.discoveryScanTimer = null
      const hasVerifiedPeer = [...this.nearby.values()].some((peer) => peer.reachability === 'online')
      if (!hasVerifiedPeer) void this.scanLocalSubnet()
    }, LAN_SYNC_LIMITS.discoveryScanDelayMs)
  }

  private onServiceUp(service: ReturnType<Bonjour['publish']>): void {
    try {
      const txt = service.txt ?? {}
      const host = selectHost(service.addresses ?? [], service.referer?.address)
      const announcement: LanSyncDiscoveryAnnouncementV2 = {
        protocol: textValue(txt.p) as typeof LAN_SYNC_PROTOCOL,
        discoveryVersion: Number(textValue(txt.w)) as typeof LAN_SYNC_WIRE_VERSION,
        messageId: crypto.randomUUID(),
        kind: 'announce',
        modelVersion: Number(textValue(txt.m)) as 2,
        deviceId: textValue(txt.id),
        name: textValue(txt.n),
        platform: textValue(txt.os) as 'windows' | 'android',
        port: LAN_SYNC_PORT,
        wireVersions: LAN_SYNC_SUPPORTED_WIRE_VERSIONS,
        certificateSha256: textValue(txt.fp),
      }
      if (service.port !== LAN_SYNC_PORT) throw new Error('unexpected sync port')
      this.onActiveDiscoveryCandidate({
        announcement,
        host,
        source: 'udp-unicast',
        receivedAt: new Date().toISOString(),
      })
    } catch {
      // Ignore unrelated, malformed or higher-version DNS-SD records.
    }
  }

  private onActiveDiscoveryCandidate(candidate: LanSyncDiscoveryCandidate): void {
    const id = candidate.announcement.deviceId
    if (id === this.syncData.deviceId || this.verificationInFlight.has(id)) return
    const verification = this.verifyCandidate(candidate).finally(() => {
      if (this.verificationInFlight.get(id) === verification) this.verificationInFlight.delete(id)
    })
    this.verificationInFlight.set(id, verification)
  }

  private async verifyCandidate(candidate: LanSyncDiscoveryCandidate): Promise<void> {
    const announced = candidate.announcement
    const trusted = this.identityStore.getPeer(announced.deviceId)
    if (trusted && trusted.certificateSha256 !== announced.certificateSha256) {
      this.nearby.set(announced.deviceId, {
        protocol: LAN_SYNC_PROTOCOL,
        wireVersion: LAN_SYNC_WIRE_VERSION,
        modelVersion: SYNC_MODEL_VERSION,
        deviceId: announced.deviceId,
        name: announced.name,
        platform: announced.platform,
        port: LAN_SYNC_PORT,
        certificateSha256: announced.certificateSha256,
        certificateDerBase64: trusted.certificateDerBase64,
        host: candidate.host,
        lastSeenAt: candidate.receivedAt,
        lastVerifiedAt: null,
        reachability: 'identity-changed',
        diagnostic: { code: 'identity-changed', message: '设备证书指纹已变化，已阻止连接。' },
      })
      return
    }
    try {
      const info = await this.requestPublicInfo(
        candidate.host,
        announced.certificateSha256,
        trusted?.certificateDerBase64,
        LAN_SYNC_LIMITS.connectTimeoutMs,
      )
      if (info.deviceId !== announced.deviceId || info.certificateSha256 !== announced.certificateSha256) {
        throw new Error('发现报文与 HTTPS 设备身份不一致')
      }
      this.setVerifiedPeer(info, candidate.host)
    } catch (error) {
      this.markPeerUnreachable(announced.deviceId, candidate.host, safeMessage(error))
    }
  }

  private setVerifiedPeer(info: LanSyncInfoResponseV2, host: string): void {
    validatePublicInfo(info)
    const now = new Date().toISOString()
    this.nearby.set(info.deviceId, {
      protocol: LAN_SYNC_PROTOCOL,
      wireVersion: LAN_SYNC_WIRE_VERSION,
      modelVersion: SYNC_MODEL_VERSION,
      deviceId: info.deviceId,
      name: info.name,
      platform: info.platform,
      port: LAN_SYNC_PORT,
      certificateSha256: info.certificateSha256,
      certificateDerBase64: info.certificateDerBase64,
      host,
      lastSeenAt: now,
      lastVerifiedAt: now,
      reachability: 'online',
      diagnostic: null,
    })
  }

  private markPeerUnreachable(deviceId: string, host: string, message: string): void {
    const existing = this.nearby.get(deviceId)
    if (!existing) return
    const stillFresh = Boolean(existing.lastVerifiedAt
      && Date.now() - Date.parse(existing.lastVerifiedAt) < LAN_SYNC_LIMITS.verifiedPeerOfflineMs)
    this.nearby.set(deviceId, {
      ...existing,
      host,
      lastSeenAt: new Date().toISOString(),
      reachability: stillFresh ? 'online' : 'unreachable',
      diagnostic: stillFresh ? null : { code: 'https-unreachable', message },
    })
  }

  private async scanLocalSubnet(): Promise<void> {
    this.discoveryScanAbort?.abort()
    const abort = new AbortController()
    this.discoveryScanAbort = abort
    const hosts = lanSyncScanHosts()
    let cursor = 0
    const worker = async () => {
      while (!abort.signal.aborted) {
        const index = cursor++
        if (index >= hosts.length) return
        const host = hosts[index]
        try {
          const info = await this.requestPublicInfo(
            host,
            null,
            undefined,
            LAN_SYNC_LIMITS.discoveryScanTimeoutMs,
            abort.signal,
          )
          if (info.deviceId !== this.syncData.deviceId) this.setVerifiedPeer(info, host)
        } catch { /* A closed address is the normal scan result. */ }
      }
    }
    await Promise.all(Array.from({
      length: Math.min(LAN_SYNC_LIMITS.discoveryScanConcurrency, hosts.length),
    }, worker))
    if (this.discoveryScanAbort === abort) this.discoveryScanAbort = null
  }

  private requestPublicInfo(
    host: string,
    expectedFingerprint: string | null,
    trustedCertificateDerBase64?: string,
    timeoutMs = LAN_SYNC_LIMITS.connectTimeoutMs,
    signal?: AbortSignal,
  ): Promise<LanSyncInfoResponseV2> {
    return new Promise((resolve, reject) => {
      let tlsFingerprint: string | null = null
      const request = https.request({
        host,
        port: LAN_SYNC_PORT,
        path: `${API_ROOT}/info`,
        method: 'GET',
        servername: 'fprsync.local',
        rejectUnauthorized: Boolean(trustedCertificateDerBase64),
        ...(trustedCertificateDerBase64 ? { ca: derBase64ToPem(trustedCertificateDerBase64) } : {}),
        timeout: timeoutMs,
        signal,
        headers: { accept: 'application/json' },
      }, (response) => {
        void readResponse(response, LAN_SYNC_LIMITS.controlJsonBytes).then((raw) => {
          if (response.statusCode !== 200) throw new Error('设备信息接口不可达')
          const info = JSON.parse(raw.toString('utf8')) as LanSyncInfoResponseV2
          validatePublicInfo(info)
          if (!tlsFingerprint || info.certificateSha256 !== tlsFingerprint) {
            throw new Error('HTTPS 响应身份与 TLS 证书不一致')
          }
          if (expectedFingerprint && info.certificateSha256 !== expectedFingerprint) {
            throw new Error('设备证书指纹与发现报文不一致')
          }
          resolve(info)
        }).catch(reject)
      })
      request.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          const certificate = (socket as import('node:tls').TLSSocket).getPeerCertificate(true)
          const raw = certificate.raw
          if (!raw) return request.destroy(new Error('设备未提供 TLS 证书'))
          const fingerprint = crypto.createHash('sha256').update(raw).digest('hex')
          tlsFingerprint = fingerprint
          if (expectedFingerprint && fingerprint !== expectedFingerprint) {
            request.destroy(new Error('TLS 证书指纹与发现报文不一致'))
          }
        })
      })
      request.on('timeout', () => request.destroy(new Error('设备验证超时')))
      request.on('error', reject)
      request.end()
    })
  }

  private async loadIncomingTransfers(): Promise<void> {
    for (const directory of await fs.promises.readdir(this.inboxRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const root = path.join(this.inboxRoot, directory.name)
      try {
        const raw = await fs.promises.readFile(path.join(root, 'state.json'), 'utf8')
        if (Buffer.byteLength(raw) > LAN_SYNC_LIMITS.controlJsonBytes) throw new Error('incoming state too large')
        const state = JSON.parse(raw) as PersistedIncomingTransfer
        if (!validIncomingState(state) || Date.parse(state.expiresAt) <= Date.now()) throw new Error('incoming state expired')
        const sender = this.identityStore.getPeer(state.senderDeviceId)
        if (!sender) throw new Error('incoming sender is no longer trusted')
        const payloadPath = path.join(root, 'batch.ndjson')
        const stat = await fs.promises.stat(payloadPath)
        if (!stat.isFile() || stat.size !== state.payloadByteLength
          || await sha256FileLocal(payloadPath) !== state.payloadSha256) throw new Error('incoming batch changed')
        const batch = await readBatchPayload(payloadPath)
        validateBatchEnvelope(batch, this.syncData.deviceId)
        if (batch.batchId !== state.id || batch.senderDeviceId !== state.senderDeviceId
          || batch.records.length !== state.recordCount || batch.blobs.length !== state.blobCount) {
          throw new Error('incoming batch state mismatch')
        }
        const blobPaths: Record<string, string> = {}
        for (const hash of state.completedBlobHashes) {
          const descriptor = batch.blobs.find((blob) => blob.sha256 === hash)
          if (!descriptor) throw new Error('incoming completed blob is undeclared')
          const blobPath = path.join(root, `${hash}.fprpub`)
          const blobStat = await fs.promises.stat(blobPath)
          if (!blobStat.isFile() || blobStat.size !== descriptor.byteLength
            || await sha256FileLocal(blobPath) !== hash) throw new Error('incoming completed blob changed')
          blobPaths[hash] = blobPath
        }
        this.incoming.set(state.id, {
          id: state.id,
          sender,
          batch,
          payloadSha256: state.payloadSha256,
          payloadByteLength: state.payloadByteLength,
          payloadPath,
          recordCount: state.recordCount,
          blobCount: state.blobCount,
          preview: state.preview,
          root,
          blobPaths,
          missingBlobHashes: state.missingBlobHashes,
          status: state.status,
          expiresAt: state.expiresAt,
        })
      } catch {
        await fs.promises.rm(root, { recursive: true, force: true })
      }
    }
  }

  private async refreshResumableTransfers(): Promise<void> {
    const transfers = await this.syncData.listResumableTransfers()
    const outgoing = transfers.map((transfer) => {
      const peer = this.identityStore.getPeer(transfer.peerDeviceId)
      return {
        transferId: transfer.batchId,
        direction: 'sending' as const,
        peer: this.deviceSummary(peer ?? {
          deviceId: transfer.peerDeviceId,
          name: '未知设备',
          platform: 'android',
          certificateSha256: '',
        }, Boolean(peer), peer ? 'offline' : 'unreachable'),
        completedBytes: transfer.payloadByteLength,
        totalBytes: transfer.totalByteLength,
        updatedAt: transfer.updatedAt,
        expiresAt: transfer.expiresAt,
      }
    })
    const incoming = [...this.incoming.values()].filter((transfer) =>
      transfer.preview && (transfer.status === 'waiting' || transfer.status === 'accepted')).map((transfer) => ({
      transferId: transfer.id,
      direction: 'receiving' as const,
      peer: this.deviceSummary(transfer.sender, true, 'offline'),
      completedBytes: transfer.payloadByteLength + Object.keys(transfer.blobPaths).reduce((sum, hash) =>
        sum + (transfer.batch?.blobs.find((blob) => blob.sha256 === hash)?.byteLength ?? 0), 0),
      totalBytes: transfer.preview!.totalBytes,
      updatedAt: new Date().toISOString(),
      expiresAt: transfer.expiresAt,
    }))
    this.resumableTransfers = [...outgoing, ...incoming]
  }

  private async handleRequest(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    try {
      if (!this.active) throw new HttpFailure(503, '同步页面未打开')
      const url = new URL(request.url ?? '/', 'https://fprsync.local')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      if (request.method === 'GET' && url.pathname === `${API_ROOT}/info`) {
        return sendJson(response, 200, {
          ...this.localIdentity(),
          protocol: LAN_SYNC_PROTOCOL,
          wireVersion: LAN_SYNC_WIRE_VERSION,
          wireVersions: LAN_SYNC_SUPPORTED_WIRE_VERSIONS,
          modelVersion: SYNC_MODEL_VERSION,
          port: LAN_SYNC_PORT,
        } satisfies LanSyncInfoResponseV2)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/pair/prepare`) {
        return await this.handlePairPrepare(request, response)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/pair/confirm`) {
        return await this.handlePairConfirm(request, response)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/pair/status`) {
        return await this.handlePairStatus(request, response)
      }
      const trusted = this.authenticate(request)
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/summary`) {
        return await this.handleSummaryPage(request, response, trusted)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/prepare`) {
        return await this.handlePrepare(request, response, trusted)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/transfer/status`) {
        return await this.handleTransferStatus(request, response, trusted)
      }
      const batchMatch = url.pathname.match(new RegExp(`^${API_ROOT}/transfer/([a-f0-9-]{36})/batch$`))
      if (request.method === 'PUT' && batchMatch) {
        return await this.handleBatch(request, response, trusted, batchMatch[1])
      }
      const blobMatch = url.pathname.match(new RegExp(`^${API_ROOT}/transfer/([a-f0-9-]{36})/blob/([a-f0-9]{64})$`))
      if (request.method === 'PUT' && blobMatch) {
        return await this.handleBlob(request, response, trusted, blobMatch[1], blobMatch[2])
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/commit`) {
        return await this.handleCommit(request, response, trusted)
      }
      if (request.method === 'POST' && url.pathname === `${API_ROOT}/cancel`) {
        const body = await readJson<{ wireVersion: number; transferId: string }>(request)
        assertLanSyncWireVersion(body.wireVersion)
        const transfer = this.requireIncoming(body.transferId, trusted.deviceId)
        if (transfer.status === 'applying') {
          throw new HttpFailure(409, '同步数据正在原子应用，当前不能取消')
        }
        transfer.status = 'cancelled'
        await fs.promises.rm(transfer.root, { recursive: true, force: true })
        this.incoming.delete(transfer.id)
        await this.refreshResumableTransfers()
        return sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION })
      }
      throw new HttpFailure(404, '同步接口不存在')
    } catch (error) {
      const failure = error instanceof HttpFailure ? error : new HttpFailure(400, safeMessage(error))
      if (!response.headersSent) sendJson(response, failure.status, { error: failure.message })
      else response.destroy()
    }
  }

  private async handlePairPrepare(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const body = await readJson<LanSyncPairPrepareRequest>(request)
    assertLanSyncWireVersion(body.wireVersion)
    validatePeerIdentity(body.sender)
    if (body.sender.deviceId === this.syncData.deviceId || !/^[a-f0-9]{48}$/.test(body.nonce)
      || !/^[a-f0-9]{64}$/.test(body.senderSecret)) throw new HttpFailure(400, '配对请求无效')
    if (this.identityStore.getPeer(body.sender.deviceId)) throw new HttpFailure(409, '设备已经配对')
    if (this.pairing && this.pairing.state.status === 'waiting') throw new HttpFailure(409, '另一项配对正在进行')
    const sessionId = crypto.randomUUID()
    const localSecret = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + LAN_SYNC_LIMITS.pairingLifetimeMs).toISOString()
    const code = deriveLanSyncPairingCode({
      nonce: body.nonce,
      leftDeviceId: body.sender.deviceId,
      rightDeviceId: this.syncData.deviceId,
      leftCertificateSha256: body.sender.certificateSha256,
      rightCertificateSha256: this.identityStore.identity.certificateSha256,
    })
    this.pairing = {
      state: {
        sessionId,
        direction: 'incoming',
        peer: this.deviceSummary(body.sender, false, 'online'),
        code,
        localConfirmed: false,
        remoteConfirmed: false,
        status: 'waiting',
        message: '请核对两台设备上的六位数字，并分别确认。',
        expiresAt,
      },
      peerIdentity: body.sender,
      endpoint: null,
      nonce: body.nonce,
      localSecret,
      remoteSecret: localSecret,
      senderSecret: body.senderSecret,
      senderConfirmed: false,
      abort: new AbortController(),
    }
    sendJson(response, 200, {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      sessionId,
      receiver: this.localIdentity(),
      code,
      expiresAt,
    } satisfies LanSyncPairPrepareResponse)
  }

  private async handlePairConfirm(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const body = await readJson<{ wireVersion: number; sessionId: string; senderConfirmed: boolean }>(request)
    assertLanSyncWireVersion(body.wireVersion)
    const pairing = this.requirePairing(body.sessionId)
    if (pairing.state.direction !== 'incoming') throw new HttpFailure(409, '配对方向不匹配')
    if (!body.senderConfirmed) {
      pairing.state.status = 'rejected'
      pairing.state.message = '另一台设备取消了配对。'
    } else {
      pairing.senderConfirmed = true
      pairing.state.remoteConfirmed = true
      if (pairing.state.localConfirmed) await this.finalizeIncomingPairing(pairing)
    }
    sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION })
  }

  private async handlePairStatus(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const body = await readJson<{ wireVersion: number; sessionId: string }>(request)
    assertLanSyncWireVersion(body.wireVersion)
    const pairing = this.requirePairing(body.sessionId)
    if (pairing.state.direction !== 'incoming') throw new HttpFailure(409, '配对方向不匹配')
    if (pairing.state.status === 'waiting' && Date.parse(pairing.state.expiresAt) <= Date.now()) {
      pairing.state.status = 'expired'
    }
    if (pairing.state.localConfirmed && pairing.senderConfirmed && pairing.state.status === 'waiting') {
      await this.finalizeIncomingPairing(pairing)
    }
    sendJson(response, 200, {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      sessionId: pairing.state.sessionId,
      status: pairing.state.status === 'paired' ? 'paired'
        : pairing.state.status === 'rejected' ? 'rejected'
          : pairing.state.status === 'expired' ? 'expired' : 'waiting',
      receiverConfirmed: pairing.state.localConfirmed,
      ...(pairing.state.status === 'paired' ? { receiverSecret: pairing.remoteSecret! } : {}),
    } satisfies LanSyncPairStatusResponse)
  }

  private async handleSummaryPage(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
  ): Promise<void> {
    const body = await readJson<{
      wireVersion: number
      changedSinceRevision?: number
      snapshotId?: string
      cursor?: string
    }>(request)
    assertLanSyncWireVersion(body.wireVersion)
    let snapshot: SummarySnapshot
    if (body.snapshotId) {
      const existing = this.summarySnapshots.get(body.snapshotId)
      if (!existing || existing.peerDeviceId !== trusted.deviceId || Date.parse(existing.expiresAt) <= Date.now()) {
        throw new HttpFailure(404, '同步摘要快照已过期')
      }
      snapshot = existing
    } else {
      const revision = body.changedSinceRevision ?? 0
      const summary = this.syncData.createPeerSummary(trusted.deviceId, revision)
      snapshot = {
        id: crypto.randomUUID(),
        peerDeviceId: trusted.deviceId,
        summary,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      this.summarySnapshots.set(snapshot.id, snapshot)
    }
    const offset = body.cursor === undefined ? 0 : Number(body.cursor)
    const entityCount = snapshot.summary.changedEntities.length
    const total = entityCount + snapshot.summary.availableBlobHashes.length
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new HttpFailure(400, '同步摘要游标无效')
    const end = Math.min(total, offset + LAN_SYNC_LIMITS.summaryPageEntries)
    const changedEntities = snapshot.summary.changedEntities.slice(offset, Math.min(end, entityCount))
    const blobStart = Math.max(0, offset - entityCount)
    const blobEnd = Math.max(0, end - entityCount)
    const availableBlobHashes = snapshot.summary.availableBlobHashes.slice(blobStart, blobEnd)
    const page: LanSyncSummaryPageV2 = {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      snapshotId: snapshot.id,
      deviceId: snapshot.summary.deviceId,
      currentRevision: snapshot.summary.currentRevision,
      lastAppliedSenderRevision: snapshot.summary.lastAppliedSenderRevision,
      changedEntitiesSinceRevision: snapshot.summary.changedEntitiesSinceRevision,
      changedEntities,
      availableBlobHashes,
      nextCursor: end < total ? String(end) : null,
      expiresAt: snapshot.expiresAt,
    }
    if (!page.nextCursor) this.summarySnapshots.delete(snapshot.id)
    sendJson(response, 200, page)
  }

  private async handlePrepare(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
  ): Promise<void> {
    const body = await readJson<LanSyncPrepareDescriptorV2>(request)
    assertLanSyncWireVersion(body.wireVersion)
    if (!/^[a-f0-9-]{36}$/i.test(body.batchId) || !/^[a-f0-9]{64}$/i.test(body.payloadSha256)
      || !Number.isSafeInteger(body.payloadByteLength) || body.payloadByteLength <= 0
      || body.payloadByteLength > LAN_SYNC_LIMITS.batchMetadataBytes
      || !Number.isSafeInteger(body.recordCount) || body.recordCount < 0
      || !Number.isSafeInteger(body.blobCount) || body.blobCount < 0
      || body.recordCount > LAN_SYNC_LIMITS.records || body.blobCount > LAN_SYNC_LIMITS.blobs) {
      throw new HttpFailure(413, '同步批次超过安全限制')
    }
    const existing = this.incoming.get(body.batchId)
    if (existing) {
      if (existing.payloadSha256 !== body.payloadSha256
        || existing.payloadByteLength !== body.payloadByteLength) throw new HttpFailure(409, '重复批次内容不一致')
      return sendJson(response, 200, this.prepareResponse(existing))
    }
    const duplicate = this.syncData.duplicateReceiptResult(trusted.deviceId, body.batchId, body.payloadSha256)
    if (duplicate) {
      return sendJson(response, 200, {
        wireVersion: LAN_SYNC_WIRE_VERSION,
        transferId: body.batchId,
        status: 'committed',
        preview: {
          totalRecords: body.recordCount,
          newPublications: 0,
          updatedRecords: 0,
          deletedPublications: 0,
          missingBlobs: 0,
          totalBytes: body.payloadByteLength,
        },
        missingBlobHashes: [],
        expiresAt: new Date(Date.now() + LAN_SYNC_LIMITS.transferLifetimeMs).toISOString(),
        needsBatch: false,
        batchUploaded: true,
        result: duplicate,
      } satisfies LanSyncPrepareResponseV2)
    }
    if ([...this.incoming.values()].some((item) =>
      item.status === 'awaiting-batch' || item.status === 'waiting'
      || item.status === 'accepted' || item.status === 'applying')) {
      throw new HttpFailure(409, '接收端已有同步请求待处理')
    }
    const root = path.join(this.inboxRoot, body.batchId)
    await fs.promises.mkdir(root, { recursive: false })
    const transfer: IncomingTransfer = {
      id: body.batchId,
      sender: trusted,
      batch: null,
      payloadSha256: body.payloadSha256,
      payloadByteLength: body.payloadByteLength,
      payloadPath: path.join(root, 'batch.ndjson'),
      recordCount: body.recordCount,
      blobCount: body.blobCount,
      preview: null,
      root,
      blobPaths: {},
      missingBlobHashes: [],
      status: 'awaiting-batch',
      expiresAt: new Date(Date.now() + LAN_SYNC_LIMITS.transferLifetimeMs).toISOString(),
    }
    this.incoming.set(transfer.id, transfer)
    sendJson(response, 200, this.prepareResponse(transfer))
  }

  private async handleBatch(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
    transferId: string,
  ): Promise<void> {
    const transfer = this.requireIncoming(transferId, trusted.deviceId)
    if (transfer.batch) return sendJson(response, 200, this.prepareResponse(transfer))
    if (transfer.status !== 'awaiting-batch') throw new HttpFailure(409, '同步批次当前不可上传')
    if ((request.headers['content-type'] ?? '').toString().split(';')[0].trim() !== LAN_SYNC_BATCH_MEDIA_TYPE) {
      throw new HttpFailure(415, '同步批次媒体类型无效')
    }
    const declaredLength = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(declaredLength) || declaredLength !== transfer.payloadByteLength) {
      throw new HttpFailure(413, '同步批次声明长度不一致')
    }
    await assertAvailableSpace(transfer.root, transfer.payloadByteLength + 64 * 1024 * 1024)
    const temporary = `${transfer.payloadPath}.part`
    await fs.promises.rm(temporary, { force: true })
    const digest = crypto.createHash('sha256')
    let bytes = 0
    request.setTimeout(LAN_SYNC_LIMITS.blobIdleTimeoutMs, () => request.destroy(new Error('同步批次传输停滞')))
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      digest.update(chunk)
      if (bytes > transfer.payloadByteLength) request.destroy(new Error('同步批次超过声明长度'))
      if (this.operation?.operationId === transfer.id) {
        this.operation = { ...this.operation, stage: 'uploading-batch', completedBytes: bytes }
      }
    })
    try {
      await pipeline(request, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (bytes !== transfer.payloadByteLength || digest.digest('hex') !== transfer.payloadSha256) {
        throw new HttpFailure(400, '同步批次完整性校验失败')
      }
      await fs.promises.rename(temporary, transfer.payloadPath)
      const batch = await readBatchPayload(transfer.payloadPath)
      validateBatchEnvelope(batch, this.syncData.deviceId)
      if (batch.senderDeviceId !== trusted.deviceId || batch.batchId !== transfer.id
        || batch.records.length !== transfer.recordCount || batch.blobs.length !== transfer.blobCount) {
        throw new HttpFailure(400, '同步批次头与准备描述不一致')
      }
      const plan = this.syncData.previewIncomingBatch(batch)
      await assertAvailableSpace(transfer.root, plan.totalBytes + 64 * 1024 * 1024)
      transfer.batch = batch
      transfer.preview = {
        totalRecords: plan.totalRecords,
        newPublications: plan.newPublications,
        updatedRecords: plan.updatedRecords,
        deletedPublications: plan.deletedPublications,
        missingBlobs: plan.missingBlobHashes.length,
        totalBytes: transfer.payloadByteLength + plan.totalBytes,
      }
      transfer.missingBlobHashes = plan.missingBlobHashes
      transfer.status = 'waiting'
      await writeIncomingState(transfer)
      sendJson(response, 200, this.prepareResponse(transfer))
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
  }

  private async handleTransferStatus(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
  ): Promise<void> {
    const body = await readJson<{ wireVersion: number; transferId: string }>(request)
    assertLanSyncWireVersion(body.wireVersion)
    const transfer = this.requireIncoming(body.transferId, trusted.deviceId)
    if (Date.parse(transfer.expiresAt) <= Date.now()
      && (transfer.status === 'waiting' || transfer.status === 'accepted')) {
      transfer.status = 'expired'
    }
    sendJson(response, 200, this.transferStatus(transfer))
  }

  private async handleBlob(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
    transferId: string,
    hash: string,
  ): Promise<void> {
    const transfer = this.requireIncoming(transferId, trusted.deviceId)
    if (transfer.status !== 'accepted') throw new HttpFailure(409, '接收端尚未接受本次同步')
    const batch = requireIncomingBatch(transfer)
    const descriptor = transfer.missingBlobHashes.includes(hash)
      ? batch.blobs.find((blob) => blob.sha256 === hash)
      : undefined
    if (!descriptor) throw new HttpFailure(404, '同步批次未声明该刊物包')
    if (transfer.blobPaths[hash]) {
      return sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION, receivedBytes: descriptor.byteLength })
    }
    const declaredLength = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(declaredLength) || declaredLength !== descriptor.byteLength
      || declaredLength > LAN_SYNC_LIMITS.publicationPackageBytes) throw new HttpFailure(413, '同步刊物包大小不一致')
    const temporary = path.join(transfer.root, `${hash}.part`)
    const destination = path.join(transfer.root, `${hash}.fprpub`)
    let bytes = 0
    const completedBefore = transfer.payloadByteLength + Object.keys(transfer.blobPaths).reduce((sum, completedHash) =>
      sum + (batch.blobs.find((blob) => blob.sha256 === completedHash)?.byteLength ?? 0), 0)
    const digest = crypto.createHash('sha256')
    request.setTimeout(LAN_SYNC_LIMITS.blobIdleTimeoutMs, () => {
      request.destroy(new Error('局域网同步刊物包传输停滞'))
    })
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      digest.update(chunk)
      if (this.operation?.operationId === transfer.id) {
        this.operation = {
          ...this.operation,
          stage: 'uploading',
          message: '正在接收刊物内容…',
          completedBytes: completedBefore + bytes,
        }
      }
    })
    try {
      await pipeline(request, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (bytes !== descriptor.byteLength || digest.digest('hex') !== hash) throw new HttpFailure(400, '同步刊物包完整性校验失败')
      await fs.promises.rename(temporary, destination)
      transfer.blobPaths[hash] = destination
      await writeIncomingState(transfer)
      sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION, receivedBytes: bytes })
    } finally {
      await fs.promises.rm(temporary, { force: true })
    }
  }

  private async handleCommit(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    trusted: SyncTrustedPeer,
  ): Promise<void> {
    const body = await readJson<{ wireVersion: number; transferId: string }>(request)
    assertLanSyncWireVersion(body.wireVersion)
    const transfer = this.requireIncoming(body.transferId, trusted.deviceId)
    if (transfer.status === 'committed' && transfer.result) {
      return sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION, result: transfer.result } satisfies LanSyncCommitResponse)
    }
    if (transfer.status !== 'accepted') throw new HttpFailure(409, '同步批次未被接受')
    const batch = requireIncomingBatch(transfer)
    for (const hash of transfer.missingBlobHashes) {
      if (!transfer.blobPaths[hash]) throw new HttpFailure(409, '同步批次仍缺少刊物包')
    }
    const expandedBytes = await this.syncData.expandedPublicationBytes(transfer.blobPaths)
    await assertAvailableSpace(transfer.root, expandedBytes + 64 * 1024 * 1024)
    if (this.operation?.operationId === transfer.id) {
      this.operation = { ...this.operation, stage: 'applying', message: '正在校验并原子应用同步数据…' }
    }
    transfer.status = 'applying'
    let result: SyncApplyResult
    try {
      result = await this.syncData.applyPreparedTransfer({
        batch,
        payloadSha256: transfer.payloadSha256,
        payloadPath: transfer.payloadPath,
        blobSourcePaths: transfer.blobPaths,
      })
    } catch (error) {
      transfer.status = 'accepted'
      if (this.operation?.operationId === transfer.id) {
        this.operation = { ...this.operation, stage: 'error', message: safeMessage(error) }
      }
      throw error
    }
    transfer.result = result
    transfer.status = 'committed'
    this.completeOperation(transfer.sender, 'receiving', result)
    await fs.promises.rm(transfer.root, { recursive: true, force: true })
    await this.refreshResumableTransfers()
    sendJson(response, 200, { wireVersion: LAN_SYNC_WIRE_VERSION, result } satisfies LanSyncCommitResponse)
  }

  private authenticate(request: import('node:http').IncomingMessage): SyncTrustedPeer {
    const deviceId = singleHeader(request.headers['x-fpr-device-id'])
    const authorization = singleHeader(request.headers.authorization)
    const peer = deviceId ? this.identityStore.getPeer(deviceId) : null
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!peer || !safeEqual(peer.token, token)) throw new HttpFailure(401, '同步设备未受信任')
    return peer
  }

  private async requestJson<T>(
    endpoint: DiscoveredPeer,
    requestPath: string,
    body: unknown,
    trusted: SyncTrustedPeer | null,
    signal?: AbortSignal,
    timeoutMs = lanSyncResponseTimeoutMs('control'),
  ): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    if (payload.length > LAN_SYNC_LIMITS.controlJsonBytes) throw new Error('同步控制请求过大')
    return new Promise<T>((resolve, reject) => {
      let connectTimer: NodeJS.Timeout | null = null
      const clearConnectTimer = () => {
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
      }
      const request = https.request({
        host: endpoint.host,
        port: endpoint.port,
        path: requestPath,
        method: 'POST',
        servername: 'fprsync.local',
        ca: derBase64ToPem(endpoint.certificateDerBase64),
        rejectUnauthorized: true,
        timeout: timeoutMs,
        signal,
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          ...(trusted ? authHeaders(this.syncData.deviceId, trusted.token) : {}),
        },
      }, (response) => {
        clearConnectTimer()
        void readResponse(response).then((raw) => {
          const parsed = raw.length ? JSON.parse(raw.toString('utf8')) as T : {} as T
          const remoteError = (parsed as { error?: unknown }).error
          if ((response.statusCode ?? 500) >= 400) {
            throw new Error(typeof remoteError === 'string' ? remoteError : '局域网同步请求失败')
          }
          resolve(parsed)
        }).catch(reject)
      })
      request.on('socket', (socket) => {
        if (!socket.connecting) return
        connectTimer = setTimeout(
          () => request.destroy(new Error('局域网同步设备连接超时')),
          LAN_SYNC_LIMITS.connectTimeoutMs,
        )
        socket.once('secureConnect', clearConnectTimer)
      })
      request.on('error', (error) => { clearConnectTimer(); reject(error) })
      request.on('timeout', () => request.destroy(new Error('局域网同步请求超时')))
      request.end(payload)
    })
  }

  private async uploadFile(
    endpoint: DiscoveredPeer,
    requestPath: string,
    sourcePath: string,
    size: number,
    trusted: SyncTrustedPeer,
    signal: AbortSignal,
    mediaType: string,
    progressBase: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let input: fs.ReadStream | null = null
      let totalTimer: NodeJS.Timeout | null = null
      let connectTimer: NodeJS.Timeout | null = null
      let responseHeaderTimer: NodeJS.Timeout | null = null
      const cleanup = () => {
        if (totalTimer) clearTimeout(totalTimer)
        if (connectTimer) clearTimeout(connectTimer)
        if (responseHeaderTimer) clearTimeout(responseHeaderTimer)
        signal.removeEventListener('abort', onAbort)
      }
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const request = https.request({
        host: endpoint.host,
        port: endpoint.port,
        path: requestPath,
        method: 'PUT',
        servername: 'fprsync.local',
        ca: derBase64ToPem(endpoint.certificateDerBase64),
        rejectUnauthorized: true,
        signal,
        headers: {
          'content-type': mediaType,
          'content-length': String(size),
          ...authHeaders(this.syncData.deviceId, trusted.token),
        },
      }, (response) => {
        if (responseHeaderTimer) {
          clearTimeout(responseHeaderTimer)
          responseHeaderTimer = null
        }
        void readResponse(response).then((raw) => {
          if ((response.statusCode ?? 500) >= 400) {
            const parsed = raw.length ? JSON.parse(raw.toString('utf8')) as { error?: string } : {}
            throw new Error(parsed.error || '刊物包上传失败')
          }
          finish()
        }).catch(finish)
      })
      const fail = (error: unknown) => {
        if (settled) return
        const failure = error instanceof Error ? error : new Error('刊物包上传失败')
        finish(failure)
        input?.destroy()
        request.destroy(failure)
      }
      const onAbort = () => fail(signal.reason ?? new DOMException('操作已取消', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('socket', (socket) => {
        if (!socket.connecting) return
        connectTimer = setTimeout(() => fail(new Error('局域网同步设备连接超时')), LAN_SYNC_LIMITS.connectTimeoutMs)
        socket.once('secureConnect', () => {
          if (connectTimer) clearTimeout(connectTimer)
          connectTimer = null
        })
      })
      request.setTimeout(LAN_SYNC_LIMITS.blobIdleTimeoutMs, () => {
        fail(new Error('局域网同步刊物包传输停滞'))
      })
      request.on('error', fail)
      totalTimer = setTimeout(() => fail(new Error('局域网同步刊物包传输超过 30 分钟')), LAN_SYNC_LIMITS.transferLifetimeMs)
      let completed = 0
      input = fs.createReadStream(sourcePath)
      input.on('data', (chunk) => {
        completed += Buffer.byteLength(chunk)
        if (this.operation) this.operation = { ...this.operation, completedBytes: progressBase + completed }
      })
      input.on('error', fail)
      request.once('finish', () => {
        request.setTimeout(0)
        const responseTimeoutMs = lanSyncResponseTimeoutMs(
          mediaType === LAN_SYNC_BATCH_MEDIA_TYPE ? 'batch-processing' : 'blob-processing',
        )
        responseHeaderTimer = setTimeout(
          () => fail(new Error('局域网同步设备响应超时')),
          responseTimeoutMs,
        )
      })
      input.pipe(request)
    })
  }

  private updateOperation(stage: SyncOperationState['stage'], message: string): void {
    if (this.operation) this.operation = { ...this.operation, stage, message }
  }

  private completeOperation(
    peer: Pick<LanSyncPeerIdentity, 'deviceId' | 'name' | 'platform' | 'certificateSha256'>,
    direction: 'sending' | 'receiving',
    result: Pick<SyncApplyResult, 'appliedRecords' | 'unchangedRecords' | 'importedBlobs'>,
  ): void {
    this.lastCompleted = {
      direction,
      peerName: peer.name,
      completedAt: new Date().toISOString(),
      appliedRecords: result.appliedRecords,
      unchangedRecords: result.unchangedRecords,
      importedPublications: result.importedBlobs,
    }
    if (this.operation) {
      this.operation = {
        ...this.operation,
        stage: 'completed',
        message: direction === 'sending' ? '增量同步已发送并确认。' : '增量同步已安全应用。',
        completedBytes: this.operation.totalBytes,
      }
    }
  }

  private prepareResponse(transfer: IncomingTransfer): LanSyncPrepareResponseV2 {
    const preview = transfer.preview ?? {
      totalRecords: transfer.recordCount,
      newPublications: 0,
      updatedRecords: 0,
      deletedPublications: 0,
      missingBlobs: transfer.blobCount,
      totalBytes: transfer.payloadByteLength,
    }
    return {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      transferId: transfer.id,
      status: transfer.status === 'committed' ? 'committed'
        : transfer.status === 'accepted' || transfer.status === 'applying' ? 'accepted' : 'waiting',
      preview,
      missingBlobHashes: transfer.missingBlobHashes.filter((hash) => !transfer.blobPaths[hash]),
      expiresAt: transfer.expiresAt,
      needsBatch: !transfer.batch && transfer.status !== 'committed',
      batchUploaded: Boolean(transfer.batch),
      ...(transfer.result ? { result: transfer.result } : {}),
    }
  }

  private transferStatus(transfer: IncomingTransfer): LanSyncTransferStatusResponse {
    return {
      wireVersion: LAN_SYNC_WIRE_VERSION,
      transferId: transfer.id,
      status: transfer.status === 'applying' || transfer.status === 'awaiting-batch' ? 'accepted' : transfer.status,
      missingBlobHashes: transfer.missingBlobHashes.filter((hash) => !transfer.blobPaths[hash]),
      ...(transfer.result ? { result: transfer.result } : {}),
    }
  }

  private publicIncoming(transfer: IncomingTransfer): SyncTransferPreview {
    if (!transfer.preview) throw new Error('同步预览尚未生成')
    return {
      transferId: transfer.id,
      sender: this.deviceSummary(transfer.sender, true, 'online'),
      ...transfer.preview,
      expiresAt: transfer.expiresAt,
    }
  }

  private localIdentity(): LanSyncPeerIdentity {
    const identity = this.identityStore.identity
    return {
      deviceId: identity.deviceId,
      name: localDeviceName(),
      platform: 'windows',
      certificateSha256: identity.certificateSha256,
      certificateDerBase64: identity.certificateDerBase64,
    }
  }

  private deviceSummary(
    peer: Pick<LanSyncPeerIdentity, 'deviceId' | 'name' | 'platform' | 'certificateSha256'> & {
      lastSeenAt?: string
      diagnostic?: SyncDeviceSummary['diagnostic']
    },
    trusted: boolean,
    reachability: SyncDeviceSummary['reachability'],
  ): SyncDeviceSummary {
    return {
      deviceId: peer.deviceId,
      name: peer.name,
      platform: peer.platform,
      trusted,
      online: reachability === 'online',
      reachability,
      diagnostic: peer.diagnostic ?? null,
      lastSeenAt: peer.lastSeenAt ?? new Date().toISOString(),
      certificateSha256: peer.certificateSha256,
    }
  }

  private requireDiscovered(deviceId: string): DiscoveredPeer {
    const peer = this.nearby.get(deviceId)
    if (!peer) throw new Error('该设备当前不在局域网同步页面中')
    if (peer.reachability === 'identity-changed') throw new Error('设备身份已变化，请撤销信任后重新配对')
    if (peer.reachability !== 'online') throw new Error('设备当前不可达，请刷新发现后重试')
    return peer
  }

  private requirePairing(sessionId: string): PairingRuntime {
    if (!this.pairing || this.pairing.state.sessionId !== sessionId) throw new HttpFailure(404, '配对请求不存在')
    return this.pairing
  }

  private requireIncoming(transferId: string, senderDeviceId?: string): IncomingTransfer {
    const transfer = this.incoming.get(transferId)
    if (!transfer || (senderDeviceId && transfer.sender.deviceId !== senderDeviceId)) {
      throw new HttpFailure(404, '同步传输不存在')
    }
    return transfer
  }

  private assertActive(): void {
    if (!this.active) throw new Error('请先打开跨设备同步页面')
  }

  private expireRuntimeState(): void {
    const now = Date.now()
    for (const [id, peer] of this.nearby) {
      const trusted = Boolean(this.identityStore.getPeer(id))
      if (!isLanSyncPeerVerificationFresh(peer.lastVerifiedAt, now) && peer.reachability === 'online') {
        peer.reachability = 'offline'
        peer.diagnostic = { code: 'firewall-or-unreachable', message: '设备超过 15 秒未通过 HTTPS 验证。' }
      }
      if (!trusted && !shouldRetainLanSyncCandidate(peer.lastSeenAt, now)) {
        this.nearby.delete(id)
      }
    }
    if (this.pairing?.state.status === 'waiting' && Date.parse(this.pairing.state.expiresAt) <= now) {
      this.pairing.state.status = 'expired'
      this.pairing.state.message = '配对请求已过期。'
      this.pairing.abort.abort()
    }
    for (const [id, transfer] of this.incoming) {
      if ((transfer.status === 'awaiting-batch' || transfer.status === 'waiting' || transfer.status === 'accepted')
        && Date.parse(transfer.expiresAt) <= now) {
        transfer.status = 'expired'
        void fs.promises.rm(transfer.root, { recursive: true, force: true })
        this.incoming.delete(id)
      }
      if (transfer.status === 'committed' && Date.parse(transfer.expiresAt) <= now) this.incoming.delete(transfer.id)
    }
    this.resumableTransfers = this.resumableTransfers.filter((transfer) => Date.parse(transfer.expiresAt) > now)
    for (const [id, snapshot] of this.summarySnapshots) {
      if (Date.parse(snapshot.expiresAt) <= now) this.summarySnapshots.delete(id)
    }
  }
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function operationIsActive(operation: SyncOperationState | null): boolean {
  return Boolean(operation && !['completed', 'cancelled', 'error', 'resumable'].includes(operation.stage))
}

function validatePeerIdentity(peer: LanSyncPeerIdentity): void {
  if (!peer.deviceId || !peer.name || !['windows', 'android'].includes(peer.platform)
    || !/^[a-f0-9]{64}$/.test(peer.certificateSha256) || !peer.certificateDerBase64) {
    throw new Error('同步设备身份无效')
  }
  const actual = crypto.createHash('sha256').update(Buffer.from(peer.certificateDerBase64, 'base64')).digest('hex')
  if (actual !== peer.certificateSha256) throw new Error('同步设备证书无效')
}

function validatePublicInfo(info: LanSyncInfoResponseV2): void {
  if (info.protocol !== LAN_SYNC_PROTOCOL || info.wireVersion !== LAN_SYNC_WIRE_VERSION
    || info.modelVersion !== SYNC_MODEL_VERSION || info.port !== LAN_SYNC_PORT
    || !Array.isArray(info.wireVersions) || info.wireVersions.length !== 1
    || info.wireVersions[0] !== LAN_SYNC_WIRE_VERSION) throw new Error('设备不支持 wire v2')
  validatePeerIdentity(info)
}

function assertPeerMatchesDiscovery(peer: LanSyncPeerIdentity, discovered: DiscoveredPeer): void {
  validatePeerIdentity(peer)
  if (peer.deviceId !== discovered.deviceId || peer.certificateSha256 !== discovered.certificateSha256
    || peer.certificateDerBase64 !== discovered.certificateDerBase64) throw new Error('发现设备与 TLS 身份不一致')
}

function selectHost(addresses: string[], referer?: string): string {
  const candidates = [...addresses, ...(referer ? [referer] : [])].filter((value) => net.isIP(value))
  const ipv4 = candidates.find((value) => net.isIPv4(value) && !value.startsWith('127.') && !value.startsWith('169.254.'))
  const ipv6 = candidates.find((value) => net.isIPv6(value) && value !== '::1' && !value.startsWith('fe80:'))
  const fallback = candidates.find((value) => !['127.0.0.1', '::1'].includes(value))
  if (!ipv4 && !ipv6 && !fallback) throw new Error('service has no usable address')
  return ipv4 ?? ipv6 ?? fallback!
}

function localDeviceName(): string {
  const hostname = os.hostname().trim().replace(/[\u0000-\u001f]/g, '').slice(0, 48)
  return hostname ? `${hostname} · Windows` : 'Windows 电脑'
}

function authHeaders(deviceId: string, token: string): Record<string, string> {
  return { 'x-fpr-device-id': deviceId, authorization: `Bearer ${token}` }
}

function derBase64ToPem(value: string): string {
  const wrapped = value.match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`
}

function textValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function singleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function listen(server: https.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动局域网同步服务')
  return address.port
}

async function closeServer(server: https.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function readJson<T>(request: import('node:http').IncomingMessage): Promise<T> {
  const length = Number(request.headers['content-length'] ?? 0)
  if (!Number.isSafeInteger(length) || length < 2 || length > LAN_SYNC_LIMITS.controlJsonBytes) {
    throw new HttpFailure(413, '同步 JSON 请求大小无效')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > LAN_SYNC_LIMITS.controlJsonBytes) throw new HttpFailure(413, '同步 JSON 请求过大')
    chunks.push(buffer)
  }
  if (bytes !== length) throw new HttpFailure(400, '同步 JSON 请求不完整')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T }
  catch { throw new HttpFailure(400, '同步 JSON 请求无效') }
}

async function readResponse(
  response: import('node:http').IncomingMessage,
  limit = LAN_SYNC_LIMITS.controlJsonBytes,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) throw new Error('同步响应过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function removePartialFiles(root: string): Promise<void> {
  let entries: fs.Dirent[] = []
  try { entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true }) }
  catch { return }
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.part')).map((entry) =>
    fs.promises.rm(path.join(entry.parentPath, entry.name), { force: true }),
  ))
}

function requireIncomingBatch(transfer: IncomingTransfer): SyncBatchV2 {
  if (!transfer.batch) throw new HttpFailure(409, '同步批次尚未上传完成')
  return transfer.batch
}

async function writeIncomingState(transfer: IncomingTransfer): Promise<void> {
  if (!transfer.preview || !transfer.batch
    || (transfer.status !== 'waiting' && transfer.status !== 'accepted')) return
  const persistedStatus: PersistedIncomingTransfer['status'] = transfer.status
  const state: PersistedIncomingTransfer = {
    version: 2,
    id: transfer.id,
    senderDeviceId: transfer.sender.deviceId,
    payloadSha256: transfer.payloadSha256,
    payloadByteLength: transfer.payloadByteLength,
    recordCount: transfer.recordCount,
    blobCount: transfer.blobCount,
    preview: transfer.preview,
    missingBlobHashes: transfer.missingBlobHashes,
    completedBlobHashes: Object.keys(transfer.blobPaths).sort(),
    status: persistedStatus,
    expiresAt: transfer.expiresAt,
    updatedAt: new Date().toISOString(),
  }
  const destination = path.join(transfer.root, 'state.json')
  const temporary = `${destination}.part`
  await fs.promises.rm(temporary, { force: true })
  await fs.promises.writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  await fs.promises.rename(temporary, destination)
}

function validIncomingState(value: PersistedIncomingTransfer): boolean {
  return value?.version === 2 && /^[a-f0-9-]{36}$/i.test(value.id)
    && typeof value.senderDeviceId === 'string' && value.senderDeviceId.length > 0
    && /^[a-f0-9]{64}$/i.test(value.payloadSha256)
    && Number.isSafeInteger(value.payloadByteLength) && value.payloadByteLength > 0
    && value.payloadByteLength <= LAN_SYNC_LIMITS.batchMetadataBytes
    && Number.isSafeInteger(value.recordCount) && value.recordCount >= 0
    && value.recordCount <= LAN_SYNC_LIMITS.records
    && Number.isSafeInteger(value.blobCount) && value.blobCount >= 0
    && value.blobCount <= LAN_SYNC_LIMITS.blobs
    && Boolean(value.preview) && Array.isArray(value.missingBlobHashes)
    && Array.isArray(value.completedBlobHashes)
    && (value.status === 'waiting' || value.status === 'accepted')
    && Number.isFinite(Date.parse(value.expiresAt)) && Number.isFinite(Date.parse(value.updatedAt))
}

async function sha256FileLocal(filePath: string): Promise<string> {
  const digest = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function assertAvailableSpace(targetPath: string, requiredBytes: number): Promise<void> {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new HttpFailure(400, '同步空间需求无效')
  const stats = await fs.promises.statfs(targetPath)
  const available = Number(stats.bavail) * Number(stats.bsize)
  if (!Number.isSafeInteger(available) || available < requiredBytes) {
    throw new HttpFailure(507, `可用空间不足；至少还需要 ${requiredBytes} 字节`)
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length })
  response.end(payload)
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('cancelled'))
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('cancelled')) }, { once: true })
  })
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '局域网同步失败'
}
