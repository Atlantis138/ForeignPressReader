import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '../src/shared/types'
import { findArticleMatches, queryIncludesChinese } from '../src/renderer/reader/search'

const blocks: ContentBlock[] = [
  {
    id: 'title', type: 'title', position: 0, text: 'Federal power and federal courts',
    html: 'Federal power and <em>federal</em> courts', assetUrl: null, alt: null,
    translation: '联邦权力与联邦法院',
  },
  {
    id: 'paragraph', type: 'paragraph', position: 1, text: 'The court protected the central bank.',
    html: null, assetUrl: null, alt: null, translation: '法院保护了中央银行。',
  },
]

describe('reader article search', () => {
  it('searches original text case-insensitively for Latin queries', () => {
    expect(findArticleMatches(blocks, 'fEdErAl')).toEqual([
      { blockId: 'title', kind: 'source', start: 0, end: 7 },
      { blockId: 'title', kind: 'source', start: 18, end: 25 },
    ])
  })

  it('adds existing translations only when the query contains Chinese', () => {
    expect(queryIncludesChinese('联邦')).toBe(true)
    expect(findArticleMatches(blocks, '联邦').map((match) => match.kind)).toEqual(['translation', 'translation'])
    expect(findArticleMatches(blocks, 'court').map((match) => match.kind)).toEqual(['source', 'source'])
  })

  it('returns no matches for an empty query', () => {
    expect(findArticleMatches(blocks, '   ')).toEqual([])
  })
})
