import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LogicalRecordV1, SyncBatchV4 } from '../src/core/sync-model'
import {
  createLanSyncBatchHeaderV2,
  deriveLanSyncPairingCode,
  deriveLanSyncTrustToken,
  isLanSyncDiscoveryAnnouncementV2,
  isLanSyncPeerVerificationFresh,
  lanSyncResponseTimeoutMs,
  LAN_SYNC_LIMITS,
  LAN_SYNC_MULTICAST_GROUP,
  LAN_SYNC_PORT,
  LAN_SYNC_PROTOCOL,
  LAN_SYNC_WIRE_VERSION,
  parseLanSyncBatchLineV2,
  serializeLanSyncBatchLineV2,
  serializeLanSyncBatchV2,
  shouldRetainLanSyncCandidate,
  type LanSyncDiscoveryAnnouncementV2,
} from '../src/core/sync-wire'
import { sha256Hex } from '../src/core/sha256'
import { readBatchPayload } from '../src/main/sync-data-service'

interface WireVector {
  protocol: string
  wireVersion: number
  port: number
  multicastGroup: string
  limits: typeof LAN_SYNC_LIMITS
  discoveryAnnouncement: LanSyncDiscoveryAnnouncementV2
  nonce: string
  left: { deviceId: string; certificateSha256: string; secret: string }
  right: { deviceId: string; certificateSha256: string; secret: string }
  expectedPairingDigestSha256: string
  expectedPairingCode: string
  expectedTrustToken: string
  batch: SyncBatchV4
  expectedBatchNdjsonBytes: number
  expectedBatchNdjsonSha256: string
}

const vector = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'test-vectors', 'lan-sync-wire-v2-model-v4.json'),
  'utf8',
)) as WireVector

describe('LAN sync wire v2 cross-platform vector', () => {
  it('freezes discovery, limits, pairing and trust derivation', () => {
    expect(vector.protocol).toBe(LAN_SYNC_PROTOCOL)
    expect(vector.wireVersion).toBe(LAN_SYNC_WIRE_VERSION)
    expect(vector.port).toBe(LAN_SYNC_PORT)
    expect(vector.multicastGroup).toBe(LAN_SYNC_MULTICAST_GROUP)
    expect(vector.limits).toEqual(LAN_SYNC_LIMITS)
    expect(isLanSyncDiscoveryAnnouncementV2(vector.discoveryAnnouncement)).toBe(true)
    expect(sha256Hex([
      LAN_SYNC_PROTOCOL,
      String(LAN_SYNC_WIRE_VERSION),
      vector.nonce,
      ...[vector.left.deviceId, vector.right.deviceId].sort(),
      ...[vector.left.certificateSha256, vector.right.certificateSha256].sort(),
    ].join('\u001f'))).toBe(vector.expectedPairingDigestSha256)

    const pairing = (left = vector.left, right = vector.right) => deriveLanSyncPairingCode({
      nonce: vector.nonce,
      leftDeviceId: left.deviceId,
      rightDeviceId: right.deviceId,
      leftCertificateSha256: left.certificateSha256,
      rightCertificateSha256: right.certificateSha256,
    })
    const trust = (left = vector.left, right = vector.right) => deriveLanSyncTrustToken({
      leftDeviceId: left.deviceId,
      rightDeviceId: right.deviceId,
      leftSecret: left.secret,
      rightSecret: right.secret,
    })
    expect(pairing()).toBe(vector.expectedPairingCode)
    expect(pairing(vector.right, vector.left)).toBe(vector.expectedPairingCode)
    expect(trust()).toBe(vector.expectedTrustToken)
    expect(trust(vector.right, vector.left)).toBe(vector.expectedTrustToken)
  })

  it('rejects malformed discovery packets and enforces stable expiry windows', () => {
    expect(isLanSyncDiscoveryAnnouncementV2({ ...vector.discoveryAnnouncement, port: 53317 })).toBe(false)
    expect(isLanSyncDiscoveryAnnouncementV2({ ...vector.discoveryAnnouncement, wireVersions: [1] })).toBe(false)
    expect(isLanSyncDiscoveryAnnouncementV2({
      ...vector.discoveryAnnouncement,
      certificateSha256: `${'a'.repeat(63)}z`,
    })).toBe(false)

    const now = Date.parse('2026-07-19T12:00:30.000Z')
    expect(isLanSyncPeerVerificationFresh('2026-07-19T12:00:15.001Z', now)).toBe(true)
    expect(isLanSyncPeerVerificationFresh('2026-07-19T12:00:15.000Z', now)).toBe(false)
    expect(shouldRetainLanSyncCandidate('2026-07-19T12:00:00.001Z', now)).toBe(true)
    expect(shouldRetainLanSyncCandidate('2026-07-19T12:00:00.000Z', now)).toBe(false)
    expect(lanSyncResponseTimeoutMs('control')).toBe(LAN_SYNC_LIMITS.jsonRequestTimeoutMs)
    expect(lanSyncResponseTimeoutMs('blob-processing')).toBe(LAN_SYNC_LIMITS.jsonRequestTimeoutMs)
    expect(lanSyncResponseTimeoutMs('batch-processing')).toBe(LAN_SYNC_LIMITS.transferLifetimeMs)
    expect(lanSyncResponseTimeoutMs('apply')).toBe(LAN_SYNC_LIMITS.transferLifetimeMs)
  })

  it('serializes the same NDJSON payload and hash on both platforms', () => {
    const payload = [...serializeLanSyncBatchV2(vector.batch)].join('')
    expect(Buffer.byteLength(payload)).toBe(vector.expectedBatchNdjsonBytes)
    expect(sha256Hex(payload)).toBe(vector.expectedBatchNdjsonSha256)
    expect(parseLanSyncBatchLineV2(payload.split('\n')[0])).toEqual(
      createLanSyncBatchHeaderV2(vector.batch),
    )
  })

  it('round-trips a synthetic logical batch larger than the former 8 MiB JSON ceiling', async () => {
    const padding = 'x'.repeat(900)
    const records: LogicalRecordV1[] = Array.from({ length: 10_000 }, (_, index) => ({
      type: 'setting',
      key: `wire.large.${index}`,
      revision: index + 1,
      value: {
        key: `wire.large.${index}`,
        value: padding,
        updatedAt: '2026-07-19T00:00:00.000Z',
        deviceId: vector.left.deviceId,
      },
    }))
    const batch: SyncBatchV4 = {
      ...vector.batch,
      batchId: '55555555-5555-4555-8555-555555555555',
      senderRevision: records.length,
      records,
    }
    const payload = [...serializeLanSyncBatchV2(batch)].join('')
    expect(Buffer.byteLength(payload)).toBeGreaterThan(8 * 1024 * 1024)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-wire-v2-large-'))
    const source = path.join(root, 'batch.ndjson')
    try {
      fs.writeFileSync(source, payload)
      const decoded = await readBatchPayload(source)
      expect(decoded.records).toHaveLength(records.length)
      expect(decoded.records.at(-1)?.key).toBe('wire.large.9999')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects unknown lines, oversized lines, count mismatches and oversized metadata', async () => {
    expect(() => parseLanSyncBatchLineV2('{"kind":"unknown"}')).toThrow()
    expect(() => serializeLanSyncBatchLineV2({
      kind: 'record',
      record: {
        type: 'setting', key: 'oversized', revision: 1,
        value: {
          key: 'oversized', value: 'x'.repeat(LAN_SYNC_LIMITS.ndjsonLineBytes),
          updatedAt: '2026-07-19T00:00:00.000Z', deviceId: vector.left.deviceId,
        },
      },
    })).toThrow()

    const tooMany = { ...vector.batch, records: Array(LAN_SYNC_LIMITS.records + 1).fill(vector.batch.records[0]) }
    const iterator = serializeLanSyncBatchV2(tooMany)
    expect(() => iterator.next()).toThrow()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-wire-v2-invalid-'))
    try {
      const mismatch = path.join(root, 'mismatch.ndjson')
      fs.writeFileSync(mismatch, [
        serializeLanSyncBatchLineV2({ ...createLanSyncBatchHeaderV2(vector.batch), recordCount: 2 }),
        serializeLanSyncBatchLineV2({ kind: 'record', record: vector.batch.records[0] }),
      ].join(''))
      await expect(readBatchPayload(mismatch)).rejects.toThrow()

      const oversized = path.join(root, 'oversized.ndjson')
      const descriptor = fs.openSync(oversized, 'w')
      try { fs.ftruncateSync(descriptor, LAN_SYNC_LIMITS.batchMetadataBytes + 1) }
      finally { fs.closeSync(descriptor) }
      await expect(readBatchPayload(oversized)).rejects.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
