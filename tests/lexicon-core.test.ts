import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chineseSearchTokens, createLexemeKey, normalizeLemma } from '../src/core/lexicon/identity'

const hasher = { sha256: (value: string) => crypto.createHash('sha256').update(value).digest('hex') }

describe('lexicon identity', () => {
  it('creates stable language-scoped keys from normalized lemmas', () => {
    expect(normalizeLemma('  Give ’ ')).toBe("give '")
    expect(createLexemeKey(hasher, 'EN', 'Give')).toBe(createLexemeKey(hasher, 'en', 'give'))
    expect(createLexemeKey(hasher, 'en', 'give')).toMatch(/^lex_en_[a-f0-9]{24}$/)
  })

  it('builds CJK unigram and bigram tokens for reverse lookup', () => {
    const tokens = chineseSearchTokens('感到焦虑').split(' ')
    expect(tokens).toContain('焦虑')
    expect(tokens).toContain('焦')
  })
})

