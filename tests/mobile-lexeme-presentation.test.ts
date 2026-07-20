import { describe, expect, it } from 'vitest'
import type { LexemeDetail } from '../src/shared/types'
import type { MobileLexemeSource } from '../src/shared/mobile-learning'
import {
  MOBILE_LEXEME_COLLAPSED_MEANING_LIMIT,
  buildMobileLexemePresentation,
  canonicalExamTag,
  presentSenseGroups,
} from '../src/shared/mobile-lexeme-presentation'

const detail: LexemeDetail = {
  lexemeKey: 'lex_en_run',
  lemma: 'run',
  phonetic: 'rʌn',
  briefMeanings: ['跑', '运行'],
  tags: ['cet4', '四级', 'ky'],
  collins: 3,
  oxford: true,
  frequency: { bnc: 120, contemporary: 90 },
  matchedBy: 'lemma',
  entries: [
    {
      word: 'run', phonetic: 'rʌn', positionWeights: null, tags: [],
      frequency: { bnc: 120, contemporary: 90 }, exchanges: [],
      senses: [{
        partOfSpeech: ' v. ',
        translations: ['跑', '运行', '经营', '流动', '延伸', '参加', '竞选'],
        definitions: ['move quickly', 'operate'],
      }],
    },
    {
      word: 'run', phonetic: 'rʌn', positionWeights: null, tags: [],
      frequency: { bnc: 120, contemporary: 90 }, exchanges: [],
      senses: [{
        partOfSpeech: 'V.',
        translations: ['运行', '竞选'],
        definitions: ['operate', 'stand for election'],
      }],
    },
  ],
  forms: ['running', 'RUNNING', 'run'],
  collections: [{ id: 'cet4', tag: 'CET4', name: '大学英语四级', count: 5_407 }],
  providerId: 'ecdict',
  examples: [
    { exampleId: 'example-1', text: 'I run.', translationZh: '我跑步。', partOfSpeech: 'v.', definition: null, providerId: 'ecdict' },
    { exampleId: 'example-1', text: 'I run.', translationZh: '我跑步。', partOfSpeech: 'v.', definition: null, providerId: 'ecdict' },
  ],
  similarWords: ['runner', 'Runner', 'run'],
}

describe('mobile lexeme presentation', () => {
  it('deduplicates aliases and authority/frequency badges across dictionary surfaces', () => {
    const presentation = buildMobileLexemePresentation(resourceSource())
    expect(presentation.badges.map((badge) => badge.label)).toEqual([
      '大学英语四级', '考研英语', 'Oxford', 'Collins 3', 'BNC #120', '词频 #90',
    ])
    expect(canonicalExamTag('大学英语四级')).toBe('cet4')
    expect(canonicalExamTag(' 四 级 ')).toBe('cet4')
  })

  it('merges equal POS groups, deduplicates meanings and exposes one shared collapse boundary', () => {
    const presentation = buildMobileLexemePresentation(resourceSource())
    expect(presentation.senses).toHaveLength(1)
    expect(presentation.senses[0]).toMatchObject({
      partOfSpeech: 'v.',
      translations: ['跑', '运行', '经营', '流动', '延伸', '参加', '竞选'],
      definitions: ['move quickly', 'operate', 'stand for election'],
      hiddenTranslationCount: 1,
    })
    expect(presentation.senses[0].collapsedTranslations).toHaveLength(MOBILE_LEXEME_COLLAPSED_MEANING_LIMIT)
    expect(presentation.forms).toEqual(['running'])
    expect(presentation.examples).toHaveLength(1)
    expect(presentation.similarWords).toEqual(['runner'])
  })

  it('uses the user-owned snapshot when the regenerable resource is unavailable', () => {
    const source: MobileLexemeSource = {
      source: 'snapshot',
      detail: null,
      snapshot: {
        lexemeKey: 'lex_en_calamity', lemma: 'calamity', phonetic: 'kəˈlæməti',
        briefMeanings: ['灾难', '不幸事件'], senseGroups: [],
        frequency: { bnc: null, contemporary: 12_502 }, providerId: 'ecdict',
      },
      localProfile: 'none',
      favorite: true,
      manualState: 'learning',
    }
    const presentation = buildMobileLexemePresentation(source)
    expect(presentation).toMatchObject({
      lexemeKey: 'lex_en_calamity', source: 'snapshot', localProfile: 'none',
      favorite: true, manualState: 'learning',
    })
    expect(presentation.senses).toEqual([expect.objectContaining({
      partOfSpeech: '释义', translations: ['灾难', '不幸事件'], hiddenTranslationCount: 0,
    })])
    expect(presentation.badges.map((badge) => badge.label)).toEqual(['词频 #12502', '离线快照'])
  })

  it('drops empty POS groups without changing the stable order of useful groups', () => {
    expect(presentSenseGroups([
      { partOfSpeech: 'n.', translations: [], definitions: [] },
      { partOfSpeech: 'adj.', translations: ['快速的'], definitions: [] },
    ]).map((group) => group.partOfSpeech)).toEqual(['adj.'])
  })
})

function resourceSource(): MobileLexemeSource {
  return {
    source: 'resource',
    detail,
    snapshot: {
      lexemeKey: detail.lexemeKey, lemma: detail.lemma, phonetic: detail.phonetic,
      briefMeanings: detail.briefMeanings, senseGroups: [], frequency: detail.frequency, providerId: 'ecdict',
    },
    localProfile: 'full',
    favorite: true,
    manualState: 'learning',
  }
}
