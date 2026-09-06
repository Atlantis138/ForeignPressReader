import { canonicalJson } from '../canonical-json'
export { canonicalJson } from '../canonical-json'
import type {
  MobileReviewTransitionProposal,
  StoredReviewCardContract,
} from '../../shared/mobile-learning'
import type { StudyPreferences } from '../../shared/types'
import { sha256Hex } from '../sha256'
import { applyFsrs, type StoredReviewCard } from './fsrs-scheduler'

export const MOBILE_STUDY_ENGINE_VERSION = 'fsrs-6/ts-fsrs-5.4.1/mobile-v1' as const

export function prepareMobileReviewTransition(input: {
  stored: StoredReviewCard | null
  answer: 'known' | 'unknown'
  now: Date
  preferences: StudyPreferences
  expectedVersion: number
  commandId: string
}): MobileReviewTransitionProposal {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('学习版本无效')
  }
  if (!/^[a-f0-9-]{36}$/i.test(input.commandId)) throw new Error('学习命令标识无效')
  const outcome = applyFsrs(input.stored, input.answer, input.now, input.preferences)
  return {
    contractVersion: 1,
    engineVersion: MOBILE_STUDY_ENGINE_VERSION,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    answer: input.answer,
    reviewedAt: input.now.toISOString(),
    beforeFingerprint: reviewCardFingerprint(outcome.before),
    parametersFingerprint: sha256Hex(canonicalJson(outcome.parameters)),
    before: outcome.before,
    after: outcome.after,
    rating: outcome.rating,
    log: outcome.log,
  }
}

export function reviewCardFingerprint(card: StoredReviewCardContract): string {
  return sha256Hex([
    'review-card-v1',
    card.dueAt,
    float64Bits(card.stability),
    float64Bits(card.difficulty),
    String(card.elapsedDays),
    String(card.scheduledDays),
    String(card.learningSteps),
    String(card.reps),
    String(card.lapses),
    String(card.state),
    card.lastReviewAt ?? '',
  ].join('\u001f'))
}


function float64Bits(value: number): string {
  if (!Number.isFinite(value)) throw new Error('复习卡数值无效')
  const buffer = new ArrayBuffer(8)
  new DataView(buffer).setFloat64(0, value, false)
  return new DataView(buffer).getBigUint64(0, false).toString(16).padStart(16, '0')
}
