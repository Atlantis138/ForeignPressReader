import {
  SYNC_MODEL_VERSION,
  type LogicalRecordV1,
  type PublicationPackageBlobRefV2,
  type SyncBatchMode,
  type SyncBatchV4,
  type SyncEntityRef,
  type SyncEntityType,
  type SyncPeerSummaryV4,
} from './sync-model'

export interface PlanSyncSelectionInput {
  localRevision: number
  /** Current logical state, including explicit tombstones. */
  currentEntities: readonly SyncEntityRef[]
  /** Local change-index entries. They may include physically absent rows. */
  localChanges: readonly SyncEntityRef[]
  /** Null means this is the first exchange with the peer. */
  peer: SyncPeerSummaryV4 | null
}

export interface SyncSelectionPlan {
  mode: SyncBatchMode
  fromSenderRevisionExclusive: number | null
  throughSenderRevision: number
  inspectedPeerRevision: number | null
  entities: SyncEntityRef[]
}

export interface BuildSyncBatchInput {
  batchId: string
  senderDeviceId: string
  recipientDeviceId: string
  createdAt: string
  selection: SyncSelectionPlan
  records: readonly LogicalRecordV1[]
  blobs?: readonly PublicationPackageBlobRefV2[]
}

const IMMUTABLE_ENTITY_TYPES = new Set<SyncEntityType>([
  'scheduler-profile',
  'review-event',
  'reinforcement-event',
])

export function isImmutableEntity(type: SyncEntityType): boolean {
  return IMMUTABLE_ENTITY_TYPES.has(type)
}

/** Keep only the highest local revision for each stable entity identity. */
export function coalesceSyncEntityRefs(refs: readonly SyncEntityRef[]): SyncEntityRef[] {
  const byIdentity = new Map<string, SyncEntityRef>()
  for (const ref of refs) {
    const identity = entityIdentity(ref)
    const current = byIdentity.get(identity)
    if (!current || ref.revision > current.revision) byIdentity.set(identity, { ...ref })
  }
  return [...byIdentity.values()].sort(compareEntityRefs)
}

/**
 * Select current sender state for an outgoing push.
 *
 * A first exchange sends a logical snapshot. Later exchanges send locally
 * unacknowledged entities plus the sender's current values for entities the
 * receiver reports changing. An identity absent from currentEntities is never
 * synthesized as a deletion; only an explicit tombstone can delete peer data.
 */
export function planSyncSelection(input: PlanSyncSelectionInput): SyncSelectionPlan {
  const current = new Map(
    coalesceSyncEntityRefs(input.currentEntities).map((ref) => [entityIdentity(ref), ref]),
  )

  if (!input.peer) {
    return {
      mode: 'snapshot',
      fromSenderRevisionExclusive: null,
      throughSenderRevision: input.localRevision,
      inspectedPeerRevision: null,
      entities: [...current.values()].sort(compareEntityRefs),
    }
  }

  const requestedIdentities = new Set<string>()
  for (const change of coalesceSyncEntityRefs(input.localChanges)) {
    if (change.revision > input.peer.lastAppliedSenderRevision) {
      requestedIdentities.add(entityIdentity(change))
    }
  }
  for (const peerChange of input.peer.changedEntities) {
    requestedIdentities.add(entityIdentity(peerChange))
  }

  const entities: SyncEntityRef[] = []
  for (const identity of requestedIdentities) {
    const currentRef = current.get(identity)
    if (currentRef) entities.push(currentRef)
  }

  return {
    mode: 'incremental',
    fromSenderRevisionExclusive: input.peer.lastAppliedSenderRevision,
    throughSenderRevision: input.localRevision,
    inspectedPeerRevision: input.peer.currentRevision,
    entities: coalesceSyncEntityRefs(entities),
  }
}

/** Sort records in a deterministic order that also respects parent rows. */
export function sortLogicalRecordsForApply(records: readonly LogicalRecordV1[]): LogicalRecordV1[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const dependency = dependencyRank(left.record) - dependencyRank(right.record)
      if (dependency) return dependency
      const type = left.record.type.localeCompare(right.record.type)
      if (type) return type
      const key = left.record.key.localeCompare(right.record.key)
      if (key) return key
      const revision = left.record.revision - right.record.revision
      return revision || left.index - right.index
    })
    .map(({ record }) => record)
}

/** Build transport-neutral batch metadata; callers provide IDs and timestamps. */
export function buildSyncBatch(input: BuildSyncBatchInput): SyncBatchV4 {
  return {
    modelVersion: SYNC_MODEL_VERSION,
    batchId: input.batchId,
    senderDeviceId: input.senderDeviceId,
    recipientDeviceId: input.recipientDeviceId,
    createdAt: input.createdAt,
    mode: input.selection.mode,
    fromSenderRevisionExclusive: input.selection.fromSenderRevisionExclusive,
    senderRevision: input.selection.throughSenderRevision,
    inspectedPeerRevision: input.selection.inspectedPeerRevision,
    records: sortLogicalRecordsForApply(input.records),
    blobs: [...(input.blobs ?? [])].sort(compareBlobRefs),
  }
}

function entityIdentity(ref: Pick<SyncEntityRef, 'type' | 'key'>): string {
  return `${ref.type}\u0000${ref.key}`
}

function compareEntityRefs(left: SyncEntityRef, right: SyncEntityRef): number {
  return left.type.localeCompare(right.type)
    || left.key.localeCompare(right.key)
    || left.revision - right.revision
}

function compareBlobRefs(left: PublicationPackageBlobRefV2, right: PublicationPackageBlobRefV2): number {
  return left.sha256.localeCompare(right.sha256)
    || left.publicationId.localeCompare(right.publicationId)
    || left.formatId.localeCompare(right.formatId)
}

function dependencyRank(record: LogicalRecordV1): number {
  if (record.type === 'publication-lifecycle') {
    return record.value.state === 'deleted' ? 100 : 0
  }
  switch (record.type) {
    case 'setting': return 5
    case 'user-lexeme': return 10
    case 'lexeme-example': return 12
    case 'reader-record': return 16
    case 'reading-position': return 15
    case 'saved-context':
    case 'vocabulary-source': return 20
    case 'study-plan': return 30
    case 'study-plan-source': return 40
    case 'study-plan-origin':
    case 'study-plan-exclusion': return 50
    case 'scheduler-profile': return 55
    case 'review-card':
    case 'review-suspension': return 60
    case 'review-event':
    case 'reinforcement-event': return 70
    case 'study-progress-state':
    case 'study-lexeme-reset': return 90
  }
}
