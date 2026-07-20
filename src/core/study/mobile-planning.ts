import type { StudyPreferences, StudyQueueOrder } from '../../shared/types'
import { sha256Hex } from '../sha256'
import { applyFsrs, type StoredReviewCard } from './fsrs-scheduler'
import { canonicalJson, reviewCardFingerprint } from './mobile-transition'
import { mergeDailyPools, reinforcementInsertionIndex, weightedNewScore } from './queue'

export const MOBILE_STUDY_PROPOSAL_VERSION = 2 as const
export const MOBILE_STUDY_ENGINE_VERSION_V2 = 'fsrs-6/ts-fsrs-5.4.1/mobile-v2' as const
export const MOBILE_QUEUE_ENGINE_VERSION_V2 = 'learning-queue-v2' as const

export interface MobileStudyCandidateV2 {
  lexemeKey: string
  planId: string
  kind: 'review' | 'new'
  dueAt: string | null
  rank: number | null
}

export interface MobileStudyPlanQuotaV2 {
  planId: string
  dailyNewLimit: number
  dailyReviewLimit: number
}

export interface MobileQueuePlanEnvelopeV2 {
  contractVersion: 2
  engineVersion: typeof MOBILE_QUEUE_ENGINE_VERSION_V2
  seed: string
  order: StudyQueueOrder
  stateFingerprint: string
  selected: Array<Pick<MobileStudyCandidateV2, 'lexemeKey' | 'planId' | 'kind'>>
  orderedKeys: string[]
  inputFingerprint: string
}

export interface MobileReviewTransitionEnvelopeV2 {
  contractVersion: 2
  engineVersion: typeof MOBILE_STUDY_ENGINE_VERSION_V2
  expectedVersion: number
  commandId: string
  answer: 'known' | 'unknown'
  reviewedAt: string
  beforeFingerprint: string
  parametersFingerprint: string
  parameters: Record<string, unknown>
  before: StoredReviewCard
  after: StoredReviewCard
  rating: 1 | 3
  log: Record<string, unknown>
  reinforcement: MobileReinforcementPlanV2 | null
}

export interface MobileReinforcementPlanV2 {
  contractVersion: 2
  engineVersion: typeof MOBILE_QUEUE_ENGINE_VERSION_V2
  seed: string
  remainingCount: number
  insertionIndex: number
}

export function prepareMobileQueuePlanV2(input: {
  seed: string
  order: StudyQueueOrder
  stateFingerprint: string
  quotas: MobileStudyPlanQuotaV2[]
  candidates: MobileStudyCandidateV2[]
}): MobileQueuePlanEnvelopeV2 {
  validatePlanningInput(input)
  const selected: MobileQueuePlanEnvelopeV2['selected'] = []
  const selectedKeys = new Set<string>()
  for (const quota of input.quotas) {
    const reviews = input.candidates
      .filter((candidate) => candidate.planId === quota.planId && candidate.kind === 'review' && !selectedKeys.has(candidate.lexemeKey))
      .sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt)) || left.lexemeKey.localeCompare(right.lexemeKey))
      .slice(0, quota.dailyReviewLimit)
    const newWords = input.candidates
      .filter((candidate) => candidate.planId === quota.planId && candidate.kind === 'new' && !selectedKeys.has(candidate.lexemeKey))
      .sort((left, right) => weightedNewScore(`${input.seed}:${quota.planId}`, left.lexemeKey, left.rank)
        - weightedNewScore(`${input.seed}:${quota.planId}`, right.lexemeKey, right.rank)
        || left.lexemeKey.localeCompare(right.lexemeKey))
      .slice(0, quota.dailyNewLimit)
    for (const candidate of [...reviews, ...newWords]) {
      if (selectedKeys.has(candidate.lexemeKey)) continue
      selectedKeys.add(candidate.lexemeKey)
      selected.push({ lexemeKey: candidate.lexemeKey, planId: candidate.planId, kind: candidate.kind })
    }
  }
  const reviews = selected.filter((candidate) => candidate.kind === 'review')
  const newWords = selected.filter((candidate) => candidate.kind === 'new')
  const orderedKeys = mergeDailyPools(reviews, newWords, input.order, input.seed).map((candidate) => candidate.lexemeKey)
  return {
    contractVersion: MOBILE_STUDY_PROPOSAL_VERSION,
    engineVersion: MOBILE_QUEUE_ENGINE_VERSION_V2,
    seed: input.seed,
    order: input.order,
    stateFingerprint: input.stateFingerprint,
    selected,
    orderedKeys,
    inputFingerprint: sha256Hex(canonicalJson({
      version: 2,
      seed: input.seed,
      order: input.order,
      stateFingerprint: input.stateFingerprint,
      quotas: input.quotas,
      candidates: input.candidates,
    })),
  }
}

export function prepareMobileReviewTransitionV2(input: {
  stored: StoredReviewCard | null
  answer: 'known' | 'unknown'
  now: Date
  preferences: StudyPreferences
  expectedVersion: number
  commandId: string
  reinforcement?: { seed: string; remainingCount: number }
}): MobileReviewTransitionEnvelopeV2 {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('学习版本无效')
  if (!/^[a-f0-9-]{36}$/i.test(input.commandId)) throw new Error('学习命令标识无效')
  const outcome = applyFsrs(input.stored, input.answer, input.now, input.preferences)
  const parameters = JSON.parse(canonicalJson(outcome.parameters)) as Record<string, unknown>
  return {
    contractVersion: MOBILE_STUDY_PROPOSAL_VERSION,
    engineVersion: MOBILE_STUDY_ENGINE_VERSION_V2,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    answer: input.answer,
    reviewedAt: input.now.toISOString(),
    beforeFingerprint: reviewCardFingerprint(outcome.before),
    parametersFingerprint: sha256Hex(canonicalJson(parameters)),
    parameters,
    before: outcome.before,
    after: outcome.after,
    rating: outcome.rating,
    log: outcome.log,
    reinforcement: input.reinforcement
      ? prepareMobileReinforcementPlanV2(input.reinforcement.seed, input.reinforcement.remainingCount)
      : null,
  }
}

export function prepareMobileReinforcementPlanV2(seed: string, remainingCount: number): MobileReinforcementPlanV2 {
  if (!Number.isSafeInteger(remainingCount) || remainingCount < 0) throw new Error('强化队列长度无效')
  return {
    contractVersion: MOBILE_STUDY_PROPOSAL_VERSION,
    engineVersion: MOBILE_QUEUE_ENGINE_VERSION_V2,
    seed,
    remainingCount,
    insertionIndex: reinforcementInsertionIndex(seed, remainingCount),
  }
}

function validatePlanningInput(input: {
  seed: string
  order: StudyQueueOrder
  stateFingerprint: string
  quotas: MobileStudyPlanQuotaV2[]
  candidates: MobileStudyCandidateV2[]
}): void {
  if (!input.seed || !input.stateFingerprint || !['mixed', 'review_first', 'new_first'].includes(input.order)) {
    throw new Error('学习队列输入无效')
  }
  if (new Set(input.quotas.map((quota) => quota.planId)).size !== input.quotas.length) throw new Error('学习计划配额重复')
  for (const quota of input.quotas) {
    if (!quota.planId || !Number.isSafeInteger(quota.dailyNewLimit) || quota.dailyNewLimit < 0 || quota.dailyNewLimit > 500
      || !Number.isSafeInteger(quota.dailyReviewLimit) || quota.dailyReviewLimit < 1 || quota.dailyReviewLimit > 2000) {
      throw new Error('学习计划配额无效')
    }
  }
  const plans = new Set(input.quotas.map((quota) => quota.planId))
  for (const candidate of input.candidates) {
    if (!candidate.lexemeKey || !plans.has(candidate.planId) || !['review', 'new'].includes(candidate.kind)
      || (candidate.rank !== null && (!Number.isFinite(candidate.rank) || candidate.rank <= 0))) {
      throw new Error('学习候选无效')
    }
  }
}
