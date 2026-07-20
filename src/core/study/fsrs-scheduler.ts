import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type FSRSParameters } from 'ts-fsrs'
import type { StudyPreferences } from '../../shared/types'
import { dueAtLearningDay } from './study-clock'

export interface StoredReviewCard {
  dueAt: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: number
  lastReviewAt: string | null
}

export interface FsrsOutcome {
  before: StoredReviewCard
  after: StoredReviewCard
  log: Record<string, unknown>
  rating: 1 | 3
  parameters: FSRSParameters
}

export function canonicalFsrsParameters(preferences: StudyPreferences): FSRSParameters {
  return generatorParameters({
    request_retention: preferences.requestRetention,
    maximum_interval: preferences.maximumInterval,
    enable_fuzz: false,
    enable_short_term: false,
    learning_steps: [],
    relearning_steps: [],
  })
}

export function applyFsrs(
  stored: StoredReviewCard | null,
  answer: 'known' | 'unknown',
  now: Date,
  preferences: StudyPreferences,
): FsrsOutcome {
  const parameters = canonicalFsrsParameters(preferences)
  const before = stored ?? fromCard(createEmptyCard(now))
  const rating = answer === 'known' ? Rating.Good : Rating.Again
  const result = fsrs(parameters).next(toCard(before), now, rating)
  const after = fromCard(result.card)
  after.dueAt = dueAtLearningDay(now, preferences.cutoffHour, after.scheduledDays)
  return {
    before,
    after,
    log: {
      ...result.log,
      due: after.dueAt,
      review: result.log.review.toISOString(),
      due_aligned_to_learning_day: true,
    } as Record<string, unknown>,
    rating: rating as 1 | 3,
    parameters,
  }
}

export function retrievability(card: StoredReviewCard, now: Date, preferences: StudyPreferences): number {
  return fsrs(canonicalFsrsParameters(preferences)).get_retrievability(toCard(card), now, false)
}

function toCard(value: StoredReviewCard): Card {
  return {
    due: new Date(value.dueAt), stability: value.stability, difficulty: value.difficulty,
    elapsed_days: value.elapsedDays, scheduled_days: value.scheduledDays,
    learning_steps: value.learningSteps, reps: value.reps, lapses: value.lapses,
    state: value.state, last_review: value.lastReviewAt ? new Date(value.lastReviewAt) : undefined,
  }
}

function fromCard(card: Card): StoredReviewCard {
  return {
    dueAt: card.due.toISOString(), stability: card.stability, difficulty: card.difficulty,
    elapsedDays: card.elapsed_days, scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps, reps: card.reps, lapses: card.lapses,
    state: card.state, lastReviewAt: card.last_review?.toISOString() ?? null,
  }
}
