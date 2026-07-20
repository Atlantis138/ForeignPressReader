import type { DictionaryExample, DictionaryProviderId, DictionarySenseGroup, ManualLearningState } from './types'
import type { MobileLexemeSource } from './mobile-learning'

export const MOBILE_LEXEME_COLLAPSED_MEANING_LIMIT = 6 as const

export type MobileLexemeBadgeKind = 'collection' | 'tag' | 'authority' | 'frequency' | 'source'

export interface MobileLexemeBadgePresentation {
  key: string
  label: string
  kind: MobileLexemeBadgeKind
  tone: 'neutral' | 'success' | 'warning'
}

export interface MobileLexemeSensePresentation {
  key: string
  partOfSpeech: string
  translations: string[]
  definitions: string[]
  collapsedTranslations: string[]
  hiddenTranslationCount: number
}

export interface MobileLexemePresentation {
  lexemeKey: string
  lemma: string
  phonetic: string | null
  briefMeanings: string[]
  source: 'resource' | 'snapshot'
  localProfile: MobileLexemeSource['localProfile']
  providerId: DictionaryProviderId
  favorite: boolean
  manualState: ManualLearningState
  badges: MobileLexemeBadgePresentation[]
  senses: MobileLexemeSensePresentation[]
  forms: string[]
  examples: DictionaryExample[]
  similarWords: string[]
}

/** Builds the layout-free E2/E3 model shared by dictionary, reader and study surfaces. */
export function buildMobileLexemePresentation(source: MobileLexemeSource): MobileLexemePresentation {
  const detail = source.detail
  const snapshot = source.snapshot
  const frequency = {
    bnc: detail?.frequency.bnc ?? snapshot?.frequency.bnc ?? null,
    contemporary: detail?.frequency.contemporary ?? snapshot?.frequency.contemporary ?? null,
  }
  const briefMeanings = uniqueText(
    detail?.briefMeanings.length ? detail.briefMeanings : snapshot?.briefMeanings ?? [],
  )
  const rawSenses = detail
    ? detail.entries.flatMap((entry) => entry.senses)
    : snapshot?.senseGroups ?? []
  const senses = presentSenseGroups(
    rawSenses.length ? rawSenses : [{ partOfSpeech: '释义', translations: briefMeanings, definitions: [] }],
  )

  return {
    lexemeKey: detail?.lexemeKey ?? snapshot!.lexemeKey,
    lemma: cleanText(detail?.lemma ?? snapshot!.lemma),
    phonetic: nullableText(detail?.phonetic ?? snapshot!.phonetic),
    briefMeanings,
    source: source.source,
    localProfile: source.localProfile,
    providerId: detail?.providerId ?? snapshot!.providerId,
    favorite: source.favorite,
    manualState: source.manualState,
    badges: buildBadges(source, frequency),
    senses,
    forms: detail ? uniqueText(detail.forms, detail.lemma) : [],
    examples: detail ? uniqueExamples(detail.examples) : [],
    similarWords: detail ? uniqueText(detail.similarWords, detail.lemma) : [],
  }
}

export function presentSenseGroups(groups: readonly DictionarySenseGroup[]): MobileLexemeSensePresentation[] {
  const merged = new Map<string, { partOfSpeech: string; translations: string[]; definitions: string[] }>()
  for (const group of groups) {
    const partOfSpeech = cleanText(group.partOfSpeech) || '释义'
    const key = canonicalPartOfSpeech(partOfSpeech)
    const current = merged.get(key) ?? { partOfSpeech, translations: [], definitions: [] }
    current.translations = uniqueText([...current.translations, ...group.translations])
    current.definitions = uniqueText([...current.definitions, ...group.definitions])
    merged.set(key, current)
  }
  return [...merged.entries()].flatMap(([key, group]) => {
    if (!group.translations.length && !group.definitions.length) return []
    return [{
      key,
      partOfSpeech: group.partOfSpeech,
      translations: group.translations,
      definitions: group.definitions,
      collapsedTranslations: group.translations.slice(0, MOBILE_LEXEME_COLLAPSED_MEANING_LIMIT),
      hiddenTranslationCount: Math.max(0, group.translations.length - MOBILE_LEXEME_COLLAPSED_MEANING_LIMIT),
    }]
  })
}

export function canonicalExamTag(value: string): string {
  const normalized = canonicalText(value).replace(/\s+/g, '')
  const aliases: Record<string, string> = {
    zk: 'zk', 中考: 'zk', cet4: 'cet4', 大学英语四级: 'cet4', 四级: 'cet4',
    cet6: 'cet6', 大学英语六级: 'cet6', 六级: 'cet6', ky: 'ky', 考研: 'ky', 考研英语: 'ky',
    ielts: 'ielts', 雅思: 'ielts', gk: 'gk', 高考: 'gk', toefl: 'toefl', 托福: 'toefl',
    gre: 'gre', tem4: 'tem4', 英语专业四级: 'tem4', 专四: 'tem4',
    tem8: 'tem8', 英语专业八级: 'tem8', 专八: 'tem8',
  }
  return aliases[normalized] ?? normalized
}

export function formatExamTag(value: string): string {
  const values: Record<string, string> = {
    cet4: '大学英语四级', cet6: '大学英语六级', ky: '考研英语', zk: '中考', gk: '高考',
    ielts: '雅思', toefl: '托福', gre: 'GRE', tem4: '英语专业四级', tem8: '英语专业八级',
  }
  return values[canonicalExamTag(value)] ?? cleanText(value)
}

function buildBadges(
  source: MobileLexemeSource,
  frequency: { bnc: number | null; contemporary: number | null },
): MobileLexemeBadgePresentation[] {
  const detail = source.detail
  const badges: MobileLexemeBadgePresentation[] = []
  const seenTags = new Set<string>()
  for (const collection of detail?.collections ?? []) {
    const canonical = canonicalExamTag(collection.tag || collection.name)
    if (!canonical || seenTags.has(canonical)) continue
    seenTags.add(canonical)
    badges.push({ key: `collection-${canonical}`, label: cleanText(collection.name), kind: 'collection', tone: 'neutral' })
  }
  for (const tag of detail?.tags ?? []) {
    const canonical = canonicalExamTag(tag)
    if (!canonical || seenTags.has(canonical)) continue
    seenTags.add(canonical)
    badges.push({ key: `tag-${canonical}`, label: formatExamTag(tag), kind: 'tag', tone: 'neutral' })
  }
  if (detail?.oxford) badges.push({ key: 'oxford', label: 'Oxford', kind: 'authority', tone: 'success' })
  if (detail?.collins && detail.collins > 0) badges.push({ key: 'collins', label: `Collins ${detail.collins}`, kind: 'authority', tone: 'success' })
  if (frequency.bnc && frequency.bnc > 0) badges.push({ key: 'bnc', label: `BNC #${frequency.bnc}`, kind: 'frequency', tone: 'neutral' })
  if (frequency.contemporary && frequency.contemporary > 0) badges.push({ key: 'frequency', label: `词频 #${frequency.contemporary}`, kind: 'frequency', tone: 'neutral' })
  if (source.source === 'snapshot') badges.push({ key: 'snapshot', label: '离线快照', kind: 'source', tone: 'warning' })
  return badges
}

function uniqueExamples(values: readonly DictionaryExample[]): DictionaryExample[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.exampleId || canonicalText(`${value.text}\u001f${value.translationZh ?? ''}`)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueText(values: readonly string[], excluded?: string): string[] {
  const excludedKey = excluded ? canonicalText(excluded) : ''
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const text = cleanText(value)
    const key = canonicalText(text)
    if (!key || key === excludedKey || seen.has(key)) return []
    seen.add(key)
    return [text]
  })
}

function canonicalPartOfSpeech(value: string): string {
  return canonicalText(value).replace(/\s+/g, ' ') || '释义'
}

function cleanText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function canonicalText(value: string): string {
  return cleanText(value).toLocaleLowerCase('en-US')
}

function nullableText(value: string | null): string | null {
  if (value === null) return null
  return cleanText(value) || null
}
