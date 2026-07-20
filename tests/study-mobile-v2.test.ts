import { describe, expect, it } from 'vitest'
import {
  prepareMobileQueuePlanV2,
  prepareMobileReinforcementPlanV2,
  prepareMobileReviewTransitionV2,
} from '../src/core/study/mobile-planning'

describe('mobile study proposal v2', () => {
  it('selects deterministic weighted candidates and de-duplicates across plans', () => {
    const proposal = prepareMobileQueuePlanV2({
      seed: '2026-07-13:regular', order: 'mixed', stateFingerprint: 'state-1',
      quotas: [
        { planId: 'a', dailyNewLimit: 1, dailyReviewLimit: 1 },
        { planId: 'b', dailyNewLimit: 1, dailyReviewLimit: 1 },
      ],
      candidates: [
        { lexemeKey: 'review-a', planId: 'a', kind: 'review', dueAt: '2026-07-10T00:00:00.000Z', rank: null },
        { lexemeKey: 'new-a', planId: 'a', kind: 'new', dueAt: null, rank: 100 },
        { lexemeKey: 'review-b', planId: 'b', kind: 'review', dueAt: '2026-07-11T00:00:00.000Z', rank: null },
        { lexemeKey: 'new-b', planId: 'b', kind: 'new', dueAt: null, rank: 500 },
        { lexemeKey: 'review-a', planId: 'b', kind: 'review', dueAt: '2026-07-09T00:00:00.000Z', rank: null },
      ],
    })
    expect(proposal.contractVersion).toBe(2)
    expect(new Set(proposal.orderedKeys).size).toBe(4)
    expect(proposal.selected.filter((item) => item.lexemeKey === 'review-a')).toEqual([
      { lexemeKey: 'review-a', planId: 'a', kind: 'review' },
    ])
    expect(proposal.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(prepareMobileQueuePlanV2({
      seed: '2026-07-13:regular', order: 'mixed', stateFingerprint: 'state-1',
      quotas: [{ planId: 'a', dailyNewLimit: 1, dailyReviewLimit: 1 }],
      candidates: [
        { lexemeKey: 'review-a', planId: 'a', kind: 'review', dueAt: '2026-07-10T00:00:00.000Z', rank: null },
        { lexemeKey: 'new-a', planId: 'a', kind: 'new', dueAt: null, rank: 100 },
      ],
    }).orderedKeys).toEqual(proposal.orderedKeys.filter((key) => key.endsWith('-a')))
  })

  it('carries canonical FSRS parameters rather than only their hash', () => {
    const proposal = prepareMobileReviewTransitionV2({
      stored: null, answer: 'known', now: new Date('2026-07-12T02:00:00.000Z'),
      preferences: { cutoffHour: 4, requestRetention: 0.9, maximumInterval: 36500, queueOrder: 'mixed' },
      expectedVersion: 3, commandId: '11111111-1111-4111-8111-111111111111',
    })
    expect(proposal.contractVersion).toBe(2)
    expect(proposal.parameters.request_retention).toBe(0.9)
    expect(proposal.parameters.maximum_interval).toBe(36500)
    expect(proposal.parametersFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces stable reinforcement insertion positions', () => {
    expect(prepareMobileReinforcementPlanV2('session:item:1', 8)).toEqual(
      prepareMobileReinforcementPlanV2('session:item:1', 8),
    )
  })
})
