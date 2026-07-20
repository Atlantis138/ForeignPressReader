import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLexemeKey } from '../src/core/lexicon/identity'
import { portableContentHasher } from '../src/core/sha256'
import {
  prepareMobileReviewTransition,
} from '../src/core/study/mobile-transition'
import { nextReinforcementState } from '../src/core/study/queue'
import {
  MOBILE_LEARNING_CONTRACT_VERSION,
  MOBILE_LEARNING_DATA_POLICY,
} from '../src/shared/mobile-learning'

interface LearningVector {
  mobileLearningContractVersion: number
  dictionary: {
    entries: Array<{ lexemeKey: string; lemma: string }>
  }
  study: {
    reviewedAt: string
    commandId: string
    expectedVersion: number
    answer: 'known' | 'unknown'
    preferences: {
      cutoffHour: number
      requestRetention: number
      maximumInterval: number
      queueOrder: 'mixed' | 'review_first' | 'new_first'
    }
    reviewProposal: unknown
    reinforcement: Array<{
      answer: 'known' | 'unknown'
      before: { hadFailure: boolean; consecutiveKnown: number }
      after: ReturnType<typeof nextReinforcementState>
    }>
  }
}

const vector = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'test-vectors', 'd0-learning.json'),
  'utf8',
)) as LearningVector

describe('Android D0 learning contract', () => {
  it('freezes portable lexeme identities and data categories', () => {
    expect(vector.mobileLearningContractVersion).toBe(MOBILE_LEARNING_CONTRACT_VERSION)
    for (const entry of vector.dictionary.entries) {
      expect(createLexemeKey(portableContentHasher, 'en', entry.lemma)).toBe(entry.lexemeKey)
    }
    expect(MOBILE_LEARNING_DATA_POLICY).toEqual({
      dictionaryPacks: 'regenerableResource',
      dictionaryQueryCache: 'cache',
      userLexemesAndContexts: 'userData',
      plansCardsAndEvents: 'userData',
      activeStudySession: 'deviceSession',
      diagnosticLogs: 'diagnostic',
    })
  })

  it('produces the fixed FSRS transition envelope', () => {
    const proposal = prepareMobileReviewTransition({
      stored: null,
      answer: vector.study.answer,
      now: new Date(vector.study.reviewedAt),
      preferences: vector.study.preferences,
      expectedVersion: vector.study.expectedVersion,
      commandId: vector.study.commandId,
    })
    if (process.env.PRINT_D0_VECTOR === '1') {
      console.log(JSON.stringify({ proposal }, null, 2))
    }
    expect(proposal).toEqual(vector.study.reviewProposal)
  })

  it('matches the fixed reinforcement transitions', () => {
    for (const item of vector.study.reinforcement) {
      expect(nextReinforcementState(
        item.answer,
        item.before.hadFailure,
        item.before.consecutiveKnown,
      )).toEqual(item.after)
    }
  })

  it('keeps the formal mobile clients free of paths, SQL and provider URLs', () => {
    const contract = fs.readFileSync(
      path.join(process.cwd(), 'src', 'shared', 'mobile-learning.ts'),
      'utf8',
    )
    expect(contract).not.toMatch(/(?:databasePath|filePath|absolutePath|sql\s*[:(]|https?:\/\/)/i)
    expect(contract).toContain('interface MobileDictionaryClient')
    expect(contract).toContain('interface MobileVocabularyClient')
    expect(contract).toContain('interface MobileStudyManagementClient')
  })

  it('matches the D2 vocabulary source and context identity vector', () => {
    const value = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test-vectors', 'd2-vocabulary.json'), 'utf8')) as Record<string, string | number>
    const hash = (...parts: Array<string | number>) => crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex')
    expect(crypto.createHash('sha256').update(String(value.sentence)).digest('hex')).toBe(value.sentenceHash)
    expect(hash(value.lexemeKey, 'reader_manual', 'favorite')).toBe(value.sourceId)
    expect(hash(value.lexemeKey, value.publicationId, value.articleId, value.blockId, value.tokenIndex, value.sentenceHash)).toBe(value.contextId)
  })
})
