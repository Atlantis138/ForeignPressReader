import { useState } from 'react'
import type { DictionaryCollection, DictionaryExample, DictionarySenseGroup } from '../../shared/types'

const COLLAPSED_MEANING_LIMIT = 6

export function LexemeSenses({ senses }: { senses: DictionarySenseGroup[] }) {
  return <div className="lexeme-senses">{senses.map((sense, index) => <LexemeSense key={`${sense.partOfSpeech}-${sense.translations.join('\u001f')}-${index}`} sense={sense}/>)}</div>
}

function LexemeSense({ sense }: { sense: DictionarySenseGroup }) {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(0, sense.translations.length - COLLAPSED_MEANING_LIMIT)
  const translations = expanded ? sense.translations : sense.translations.slice(0, COLLAPSED_MEANING_LIMIT)
  return <section className="lexeme-sense-group"><b>{sense.partOfSpeech}</b>{translations.length > 0 && <p className="lexeme-meaning-line">{translations.map((text, index) => <span key={text}><SenseTranslation text={text}/>{index < translations.length - 1 && <i aria-hidden="true">；</i>}</span>)}</p>}{hiddenCount > 0 && <button className="lexeme-meaning-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起释义' : `展开其余 ${hiddenCount} 项`}</button>}{sense.definitions.length > 0 && <div className="lexeme-definitions">{sense.definitions.map(text => <p key={text}>{text}</p>)}</div>}</section>
}

export function LexemeBadges({ tags, collections, oxford, collins, frequency }: {
  tags: string[]
  collections: DictionaryCollection[]
  oxford: boolean
  collins: number | null
  frequency: { bnc: number | null; contemporary: number | null }
}) {
  const seenExamTags = new Set<string>()
  const collectionBadges = collections.flatMap(item => {
    const canonical = canonicalExamTag(item.tag || item.name)
    if (seenExamTags.has(canonical)) return []
    seenExamTags.add(canonical)
    return [{ key: `collection-${canonical}`, label: item.name }]
  })
  const tagBadges = tags.flatMap(tag => {
    const canonical = canonicalExamTag(tag)
    if (seenExamTags.has(canonical)) return []
    seenExamTags.add(canonical)
    return [{ key: `tag-${canonical}`, label: formatTag(tag) }]
  })
  const values = [
    ...collectionBadges,
    ...tagBadges,
    ...(oxford ? [{ key: 'oxford', label: 'Oxford' }] : []),
    ...(collins ? [{ key: 'collins', label: `Collins ${collins}` }] : []),
    ...(frequency.contemporary ? [{ key: 'frequency', label: `词频 #${frequency.contemporary}` }] : []),
  ]
  if (!values.length) return null
  return <div className="lexeme-badges">{values.map(value => <span key={value.key}>{value.label}</span>)}</div>
}

export function LexemeExamples({ examples }: { examples: DictionaryExample[] }) {
  if (!examples.length) return null
  return <section className="lexeme-examples"><h3>例句</h3><div>{examples.map((example, index) => <article key={example.exampleId}><span>{String(index + 1).padStart(2, '0')}</span><div><p>{example.text}</p>{example.translationZh && <small>{example.translationZh}</small>}{example.partOfSpeech && <em>{example.partOfSpeech}</em>}</div></article>)}</div></section>
}

function SenseTranslation({ text }: { text: string }) {
  const match = text.match(/^(\[[^\]]+\])\s*(.*)$/)
  return match ? <><span className="domain-tag">{match[1]}</span>{match[2]}</> : text
}

function formatTag(tag: string): string {
  const values: Record<string, string> = {
    cet4: '大学英语四级', cet6: '大学英语六级', ky: '考研英语', zk: '中考', gk: '高考',
    ielts: '雅思', toefl: '托福', gre: 'GRE', tem4: '英语专业四级', tem8: '英语专业八级',
  }
  return values[tag.toLowerCase()] ?? tag
}

function canonicalExamTag(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '')
  const aliases: Record<string, string> = {
    zk: 'zk', 中考: 'zk', cet4: 'cet4', 大学英语四级: 'cet4', 四级: 'cet4',
    cet6: 'cet6', 大学英语六级: 'cet6', 六级: 'cet6', ky: 'ky', 考研: 'ky', 考研英语: 'ky',
    ielts: 'ielts', 雅思: 'ielts', gk: 'gk', 高考: 'gk', toefl: 'toefl', 托福: 'toefl',
    gre: 'gre', tem4: 'tem4', 英语专业四级: 'tem4', 专四: 'tem4',
    tem8: 'tem8', 英语专业八级: 'tem8', 专八: 'tem8',
  }
  return aliases[normalized] ?? normalized
}
