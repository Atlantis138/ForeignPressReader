import type { LexemeKey } from '../../shared/types'

export interface LexemeHasher {
  sha256(value: string): string
}

export function normalizeLemma(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
}

export function createLexemeKey(hasher: LexemeHasher, language: string, lemma: string): LexemeKey {
  const normalizedLanguage = language.trim().toLowerCase() || 'und'
  const normalizedLemma = normalizeLemma(lemma)
  return `lex_${normalizedLanguage}_${hasher.sha256(`${normalizedLanguage}\u001f${normalizedLemma}`).slice(0, 24)}`
}

export function chineseSearchTokens(value: string): string {
  const compact = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const tokens = new Set<string>()
  for (const match of compact.matchAll(/[\p{Script=Han}]+/gu)) {
    const text = match[0]
    for (const character of text) tokens.add(character)
    for (let index = 0; index < text.length - 1; index++) tokens.add(text.slice(index, index + 2))
  }
  for (const word of compact.match(/[a-z0-9]+/g) ?? []) tokens.add(word)
  return [...tokens].join(' ')
}

