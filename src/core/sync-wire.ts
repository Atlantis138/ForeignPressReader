import type {
  LogicalRecordV1,
  PublicationPackageBlobRefV2,
  SyncApplyResult,
  SyncBatchMode,
  SyncBatchV2,
  SyncEntityRef,
} from './sync-model'
import { sha256Hex } from './sha256'

export const LAN_SYNC_PROTOCOL = 'foreign-press-reader-sync' as const
export const LAN_SYNC_WIRE_VERSION = 2 as const
export const LAN_SYNC_SUPPORTED_WIRE_VERSIONS = [LAN_SYNC_WIRE_VERSION] as const
export const LAN_SYNC_SERVICE_TYPE = 'fprsync' as const
export const LAN_SYNC_SERVICE_NAME = '_fprsync._tcp' as const
export const LAN_SYNC_PORT = 53_318 as const
export const LAN_SYNC_MULTICAST_GROUP = '239.255.70.80' as const
export const LAN_SYNC_BATCH_MEDIA_TYPE = 'application/vnd.foreign-press-reader.sync-batch+ndjson' as const
export const LAN_SYNC_BATCH_STREAM_VERSION = 1 as const

export const LAN_SYNC_LIMITS = {
  controlJsonBytes: 1024 * 1024,
  ndjsonLineBytes: 1024 * 1024,
  batchMetadataBytes: 512 * 1024 * 1024,
  summaryPageEntries: 1_000,
  publicationPackageBytes: 2 * 1024 * 1024 * 1024,
  records: 250_000,
  blobs: 10_000,
  connectTimeoutMs: 10 * 1000,
  jsonRequestTimeoutMs: 30 * 1000,
  blobIdleTimeoutMs: 60 * 1000,
  pairingLifetimeMs: 2 * 60 * 1000,
  transferLifetimeMs: 30 * 60 * 1000,
  discoveryHeartbeatMs: 5 * 1000,
  verifiedPeerOfflineMs: 15 * 1000,
  candidateRetentionMs: 30 * 1000,
  discoveryScanDelayMs: 3 * 1000,
  discoveryScanTimeoutMs: 750,
  discoveryScanConcurrency: 32,
} as const

export type LanSyncResponsePhase = 'control' | 'batch-processing' | 'blob-processing' | 'apply'

export function lanSyncResponseTimeoutMs(phase: LanSyncResponsePhase): number {
  return phase === 'batch-processing' || phase === 'apply'
    ? LAN_SYNC_LIMITS.transferLifetimeMs
    : LAN_SYNC_LIMITS.jsonRequestTimeoutMs
}

export type LanSyncPlatform = 'windows' | 'android'

/** Minimal DNS-SD payload. It deliberately contains no user data. */
export interface LanSyncVerifiedDiscoveryRecordV2 {
  protocol: typeof LAN_SYNC_PROTOCOL
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  modelVersion: 2
  deviceId: string
  name: string
  platform: LanSyncPlatform
  port: number
  certificateSha256: string
  certificateDerBase64: string
}

export interface LanSyncPeerIdentity {
  deviceId: string
  name: string
  platform: LanSyncPlatform
  certificateSha256: string
  certificateDerBase64: string
}

/** Wire v2 UDP payload. It never contains a certificate, token or user data. */
export interface LanSyncDiscoveryAnnouncementV2 {
  protocol: typeof LAN_SYNC_PROTOCOL
  discoveryVersion: typeof LAN_SYNC_WIRE_VERSION
  messageId: string
  kind: 'announce' | 'probe'
  deviceId: string
  name: string
  platform: LanSyncPlatform
  port: typeof LAN_SYNC_PORT
  wireVersions: readonly [2]
  modelVersion: 2
  certificateSha256: string
}

export interface LanSyncInfoResponseV2 extends LanSyncPeerIdentity {
  protocol: typeof LAN_SYNC_PROTOCOL
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  wireVersions: readonly [2]
  modelVersion: 2
  port: typeof LAN_SYNC_PORT
}

export interface LanSyncSummaryStartRequestV2 {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  changedSinceRevision: number
}

export interface LanSyncSummaryPageV2 {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  snapshotId: string
  deviceId: string
  currentRevision: number
  lastAppliedSenderRevision: number
  changedEntitiesSinceRevision: number
  changedEntities: SyncEntityRef[]
  availableBlobHashes: string[]
  nextCursor: string | null
  expiresAt: string
}

export interface LanSyncBatchHeaderLineV2 {
  kind: 'header'
  streamVersion: typeof LAN_SYNC_BATCH_STREAM_VERSION
  modelVersion: 2
  batchId: string
  senderDeviceId: string
  recipientDeviceId: string
  createdAt: string
  mode: SyncBatchMode
  fromSenderRevisionExclusive: number | null
  senderRevision: number
  inspectedPeerRevision: number | null
  recordCount: number
  blobCount: number
}

export interface LanSyncBatchRecordLineV2 {
  kind: 'record'
  record: LogicalRecordV1
}

export interface LanSyncBatchBlobLineV2 {
  kind: 'blob'
  blob: PublicationPackageBlobRefV2
}

export type LanSyncBatchLineV2 =
  | LanSyncBatchHeaderLineV2
  | LanSyncBatchRecordLineV2
  | LanSyncBatchBlobLineV2

export interface LanSyncPrepareDescriptorV2 {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  batchId: string
  payloadSha256: string
  payloadByteLength: number
  recordCount: number
  blobCount: number
}

export interface LanSyncPairPrepareRequest {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  sender: LanSyncPeerIdentity
  nonce: string
  senderSecret: string
}

export interface LanSyncPairPrepareResponse {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  sessionId: string
  receiver: LanSyncPeerIdentity
  code: string
  expiresAt: string
}

export interface LanSyncPairConfirmRequest {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  sessionId: string
  senderConfirmed: boolean
}

export interface LanSyncPairStatusResponse {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  sessionId: string
  status: 'waiting' | 'paired' | 'rejected' | 'expired'
  receiverConfirmed: boolean
  receiverSecret?: string
}

export interface LanSyncTransferPreview {
  totalRecords: number
  newPublications: number
  updatedRecords: number
  deletedPublications: number
  missingBlobs: number
  totalBytes: number
}

export interface LanSyncPrepareResponse {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  transferId: string
  status: 'waiting' | 'accepted'
  preview: LanSyncTransferPreview
  missingBlobHashes: string[]
  expiresAt: string
}

export interface LanSyncPrepareResponseV2 {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  transferId: string
  status: 'waiting' | 'accepted' | 'committed'
  preview: LanSyncTransferPreview
  missingBlobHashes: string[]
  expiresAt: string
  needsBatch: boolean
  batchUploaded: boolean
  result?: SyncApplyResult
}

export interface LanSyncTransferStatusResponse {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  transferId: string
  status: 'waiting' | 'accepted' | 'rejected' | 'cancelled' | 'expired' | 'committed'
  missingBlobHashes: string[]
  result?: SyncApplyResult
}

export interface LanSyncCommitRequest {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  transferId: string
}

export interface LanSyncCommitResponse {
  wireVersion: typeof LAN_SYNC_WIRE_VERSION
  result: SyncApplyResult
}

export function deriveLanSyncPairingCode(input: {
  nonce: string
  leftDeviceId: string
  rightDeviceId: string
  leftCertificateSha256: string
  rightCertificateSha256: string
}): string {
  const ids = [input.leftDeviceId, input.rightDeviceId].sort()
  const fingerprints = [input.leftCertificateSha256, input.rightCertificateSha256].sort()
  const digest = sha256Hex([
    LAN_SYNC_PROTOCOL,
    String(LAN_SYNC_WIRE_VERSION),
    input.nonce,
    ...ids,
    ...fingerprints,
  ].join('\u001f'))
  return (BigInt(`0x${digest.slice(0, 12)}`) % 1_000_000n).toString().padStart(6, '0')
}

export function deriveLanSyncTrustToken(input: {
  leftDeviceId: string
  rightDeviceId: string
  leftSecret: string
  rightSecret: string
}): string {
  const participants = [
    `${input.leftDeviceId}\u001e${input.leftSecret}`,
    `${input.rightDeviceId}\u001e${input.rightSecret}`,
  ].sort()
  return sha256Hex([LAN_SYNC_PROTOCOL, 'trust-v1', ...participants].join('\u001f'))
}

export function assertLanSyncWireVersion(value: unknown): asserts value is typeof LAN_SYNC_WIRE_VERSION {
  if (value !== LAN_SYNC_WIRE_VERSION) throw new Error('局域网同步协议版本不兼容')
}

export function isLanSyncPeerVerificationFresh(lastVerifiedAt: string | null, now = Date.now()): boolean {
  return Boolean(lastVerifiedAt
    && Number.isFinite(Date.parse(lastVerifiedAt))
    && now - Date.parse(lastVerifiedAt) < LAN_SYNC_LIMITS.verifiedPeerOfflineMs)
}

export function shouldRetainLanSyncCandidate(lastSeenAt: string, now = Date.now()): boolean {
  return Number.isFinite(Date.parse(lastSeenAt))
    && now - Date.parse(lastSeenAt) < LAN_SYNC_LIMITS.candidateRetentionMs
}

export function isLanSyncDiscoveryAnnouncementV2(value: unknown): value is LanSyncDiscoveryAnnouncementV2 {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LanSyncDiscoveryAnnouncementV2>
  return item.protocol === LAN_SYNC_PROTOCOL
    && item.discoveryVersion === LAN_SYNC_WIRE_VERSION
    && (item.kind === 'announce' || item.kind === 'probe')
    && typeof item.messageId === 'string' && item.messageId.length >= 8 && item.messageId.length <= 128
    && typeof item.deviceId === 'string' && item.deviceId.length >= 8 && item.deviceId.length <= 128
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 128
    && (item.platform === 'windows' || item.platform === 'android')
    && item.port === LAN_SYNC_PORT
    && Array.isArray(item.wireVersions)
    && item.wireVersions.length === 1 && item.wireVersions[0] === 2
    && item.modelVersion === 2
    && typeof item.certificateSha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.certificateSha256)
}

export function parseLanSyncBatchLineV2(line: string): LanSyncBatchLineV2 {
  const byteLength = new TextEncoder().encode(line).byteLength
  if (byteLength === 0 || byteLength > LAN_SYNC_LIMITS.ndjsonLineBytes) {
    throw new Error('同步批次单行大小超出限制')
  }
  const value: unknown = JSON.parse(line)
  if (!value || typeof value !== 'object' || typeof (value as { kind?: unknown }).kind !== 'string') {
    throw new Error('同步批次行格式无效')
  }
  const item = value as Record<string, unknown>
  if (item.kind === 'header') {
    if (item.streamVersion !== LAN_SYNC_BATCH_STREAM_VERSION || item.modelVersion !== 2
      || typeof item.batchId !== 'string' || typeof item.senderDeviceId !== 'string'
      || typeof item.recipientDeviceId !== 'string' || typeof item.createdAt !== 'string'
      || (item.mode !== 'snapshot' && item.mode !== 'incremental')
      || !Number.isSafeInteger(item.senderRevision) || !Number.isSafeInteger(item.recordCount)
      || !Number.isSafeInteger(item.blobCount)) {
      throw new Error('同步批次头格式无效')
    }
    return item as unknown as LanSyncBatchHeaderLineV2
  }
  if (item.kind === 'record') {
    if (!item.record || typeof item.record !== 'object') throw new Error('同步批次记录格式无效')
    return item as unknown as LanSyncBatchRecordLineV2
  }
  if (item.kind === 'blob') {
    if (!item.blob || typeof item.blob !== 'object') throw new Error('同步批次 Blob 格式无效')
    return item as unknown as LanSyncBatchBlobLineV2
  }
  throw new Error('同步批次行类型无效')
}

export function createLanSyncBatchHeaderV2(batch: SyncBatchV2): LanSyncBatchHeaderLineV2 {
  return {
    kind: 'header',
    streamVersion: LAN_SYNC_BATCH_STREAM_VERSION,
    modelVersion: 2,
    batchId: batch.batchId,
    senderDeviceId: batch.senderDeviceId,
    recipientDeviceId: batch.recipientDeviceId,
    createdAt: batch.createdAt,
    mode: batch.mode,
    fromSenderRevisionExclusive: batch.fromSenderRevisionExclusive,
    senderRevision: batch.senderRevision,
    inspectedPeerRevision: batch.inspectedPeerRevision,
    recordCount: batch.records.length,
    blobCount: batch.blobs.length,
  }
}

export function* serializeLanSyncBatchV2(batch: SyncBatchV2): Generator<string> {
  if (batch.records.length > LAN_SYNC_LIMITS.records || batch.blobs.length > LAN_SYNC_LIMITS.blobs) {
    throw new Error('同步批次数量超出限制')
  }
  yield serializeLanSyncBatchLineV2(createLanSyncBatchHeaderV2(batch))
  for (const record of batch.records) yield serializeLanSyncBatchLineV2({ kind: 'record', record })
  for (const blob of batch.blobs) yield serializeLanSyncBatchLineV2({ kind: 'blob', blob })
}

export function serializeLanSyncBatchLineV2(line: LanSyncBatchLineV2): string {
  const value = `${JSON.stringify(line)}\n`
  if (new TextEncoder().encode(value).byteLength > LAN_SYNC_LIMITS.ndjsonLineBytes) {
    throw new Error('同步批次单行大小超出限制')
  }
  return value
}
