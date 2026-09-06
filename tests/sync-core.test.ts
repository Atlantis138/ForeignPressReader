import { describe, expect, it } from 'vitest'
import {
  buildSyncBatch,
  coalesceSyncEntityRefs,
  isImmutableEntity,
  planSyncSelection,
  sortLogicalRecordsForApply,
} from '../src/core/sync-engine'
import {
  SYNC_MODEL_VERSION,
  type LogicalRecordV1,
  type SyncEntityRef,
  type SyncPeerSummaryV3,
} from '../src/core/sync-model'

const ref = (type: SyncEntityRef['type'], key: string, revision: number): SyncEntityRef => ({
  type, key, revision,
})

const peer = (overrides: Partial<SyncPeerSummaryV3> = {}): SyncPeerSummaryV3 => ({
  modelVersion: SYNC_MODEL_VERSION,
  deviceId: 'peer-b',
  currentRevision: 20,
  lastAppliedSenderRevision: 0,
  changedEntitiesSinceRevision: 0,
  changedEntities: [],
  availableBlobHashes: [],
  ...overrides,
})

describe('sync core model', () => {
  it('plans a complete logical snapshot on first contact', () => {
    const current = [
      ref('user-lexeme', 'lexeme-b', 2),
      ref('publication-lifecycle', 'publication-a', 1),
    ]
    const selection = planSyncSelection({
      localRevision: 2,
      currentEntities: current,
      localChanges: current,
      peer: null,
    })

    expect(selection).toMatchObject({
      mode: 'snapshot',
      fromSenderRevisionExclusive: null,
      throughSenderRevision: 2,
      inspectedPeerRevision: null,
    })
    expect(selection.entities).toEqual([
      ref('publication-lifecycle', 'publication-a', 1),
      ref('user-lexeme', 'lexeme-b', 2),
    ])
  })

  it('plans an empty second incremental exchange when everything is acknowledged', () => {
    const current = [ref('reading-position', 'publication-a', 7)]
    const selection = planSyncSelection({
      localRevision: 7,
      currentEntities: current,
      localChanges: current,
      peer: peer({ lastAppliedSenderRevision: 7, currentRevision: 12 }),
    })

    expect(selection).toEqual({
      mode: 'incremental',
      fromSenderRevisionExclusive: 7,
      throughSenderRevision: 7,
      inspectedPeerRevision: 12,
      entities: [],
    })
  })

  it('returns the sender current value when the receiver reports changing the same entity', () => {
    const local = ref('setting', 'reader.preferences', 3)
    const selection = planSyncSelection({
      localRevision: 3,
      currentEntities: [local],
      localChanges: [local],
      peer: peer({
        lastAppliedSenderRevision: 3,
        currentRevision: 22,
        changedEntities: [ref('setting', 'reader.preferences', 22)],
      }),
    })

    expect(selection.entities).toEqual([local])
    expect(selection.inspectedPeerRevision).toBe(22)
  })

  it('omits receiver-only identities instead of inferring a deletion', () => {
    const local = ref('user-lexeme', 'local-word', 4)
    const selection = planSyncSelection({
      localRevision: 4,
      currentEntities: [local],
      localChanges: [local],
      peer: peer({
        lastAppliedSenderRevision: 4,
        changedEntities: [ref('user-lexeme', 'receiver-only-word', 18)],
      }),
    })

    expect(selection.entities).toEqual([])
  })

  it('coalesces duplicate references at their highest revision', () => {
    expect(coalesceSyncEntityRefs([
      ref('review-card', 'lexeme-a', 2),
      ref('review-card', 'lexeme-a', 9),
      ref('review-card', 'lexeme-a', 4),
      ref('setting', 'study.preferences', 3),
    ])).toEqual([
      ref('review-card', 'lexeme-a', 9),
      ref('setting', 'study.preferences', 3),
    ])
  })

  it('sorts parents before dependants, resets after events, and publication deletion last', () => {
    const records: LogicalRecordV1[] = [
      studyRecord('study-lexeme-reset', 'reset-a', 10),
      publicationRecord('publication-deleted', 11, 'deleted'),
      studyRecord('review-event', 'event-a', 9),
      studyRecord('review-card', 'lexeme-a', 8),
      studyRecord('study-plan-source', 'source-a', 5),
      studyRecord('study-plan', 'plan-a', 4),
      studyRecord('scheduler-profile', 'profile-a', 7),
      studyRecord('study-plan-origin', 'origin-a', 6),
      userLexemeRecord('lexeme-a', 2),
      publicationRecord('publication-present', 1, 'present'),
      readingPositionRecord('publication-present', 3),
    ]

    expect(sortLogicalRecordsForApply(records).map((record) => record.type)).toEqual([
      'publication-lifecycle',
      'user-lexeme',
      'reading-position',
      'study-plan',
      'study-plan-source',
      'study-plan-origin',
      'scheduler-profile',
      'review-card',
      'review-event',
      'study-lexeme-reset',
      'publication-lifecycle',
    ])
  })

  it('builds deterministic transport-neutral batch metadata', () => {
    const selection = planSyncSelection({
      localRevision: 4,
      currentEntities: [ref('user-lexeme', 'lexeme-a', 4)],
      localChanges: [ref('user-lexeme', 'lexeme-a', 4)],
      peer: null,
    })
    const batch = buildSyncBatch({
      batchId: 'batch-1',
      senderDeviceId: 'device-a',
      recipientDeviceId: 'device-b',
      createdAt: '2026-07-10T00:00:00.000Z',
      selection,
      records: [userLexemeRecord('lexeme-a', 4)],
      blobs: [
        { kind: 'publication-package', publicationId: 'b', formatId: 'epub', contentSha256: 'bb', sha256: 'ff', byteLength: 2, mediaType: 'application/vnd.foreign-press-reader.publication+zip' },
        { kind: 'publication-package', publicationId: 'a', formatId: 'epub', contentSha256: 'aa', sha256: '00', byteLength: 1, mediaType: 'application/vnd.foreign-press-reader.publication+zip' },
      ],
    })

    expect(batch).toMatchObject({
      modelVersion: SYNC_MODEL_VERSION,
      batchId: 'batch-1',
      mode: 'snapshot',
      fromSenderRevisionExclusive: null,
      senderRevision: 4,
      inspectedPeerRevision: null,
    })
    expect(batch.blobs.map((blob) => blob.sha256)).toEqual(['00', 'ff'])
  })

  it('identifies immutable union entities', () => {
    expect(isImmutableEntity('review-event')).toBe(true)
    expect(isImmutableEntity('reinforcement-event')).toBe(true)
    expect(isImmutableEntity('scheduler-profile')).toBe(true)
    expect(isImmutableEntity('review-card')).toBe(false)
    expect(isImmutableEntity('publication-lifecycle')).toBe(false)
  })
})

function publicationRecord(
  key: string,
  revision: number,
  state: 'present' | 'deleted',
): LogicalRecordV1 {
  return {
    type: 'publication-lifecycle', key, revision,
    value: {
      publicationId: key,
      contentHash: `hash-${key}`,
      formatId: 'epub',
      title: key,
      state,
      changedAt: '2026-07-10T00:00:00.000Z',
      deviceId: 'device-a',
    },
  }
}

function userLexemeRecord(key: string, revision: number): LogicalRecordV1 {
  return {
    type: 'user-lexeme', key, revision,
    value: {
      lexemeKey: key,
      lemmaSnapshot: key,
      phoneticSnapshot: null,
      briefMeanings: [],
      senseGroups: [],
      bncRank: null,
      frequencyRank: null,
      manualState: 'unrated',
      manualFamiliarity: null,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      deviceId: 'device-a',
    },
  }
}

function readingPositionRecord(key: string, revision: number): LogicalRecordV1 {
  return {
    type: 'reading-position', key, revision,
    value: {
      publicationId: key,
      articleId: 'article-a',
      scrollTop: 20,
      blockId: 'block-a',
      tokenIndex: 2,
      blockFraction: 0.5,
      updatedAt: '2026-07-10T00:00:00.000Z',
      deviceId: 'device-a',
    },
  }
}

function studyRecord(
  type: Extract<SyncEntityRef['type'],
    | 'study-plan'
    | 'study-plan-source'
    | 'study-plan-origin'
    | 'scheduler-profile'
    | 'review-card'
    | 'review-event'
    | 'study-lexeme-reset'>,
  key: string,
  revision: number,
): LogicalRecordV1 {
  return { type, key, revision, value: { id: key } } as LogicalRecordV1
}
