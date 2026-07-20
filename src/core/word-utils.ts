export interface WordToken {
  surface: string
  normalized: string
  start: number
  end: number
  index: number
}

const TOKEN_PATTERN = /(?:[A-Za-z]\.){2,}|[A-Za-z]+(?:[’'][A-Za-z]+)*(?:-[A-Za-z]+(?:[’'][A-Za-z]+)*)*/g

export function tokenizeEnglish(text: string): WordToken[] {
  const tokens: WordToken[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const surface = match[0]
    const start = match.index ?? 0
    tokens.push({
      surface,
      normalized: normalizeEnglishWord(surface),
      start,
      end: start + surface.length,
      index: tokens.length,
    })
  }
  return tokens
}

export function normalizeEnglishWord(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/\.+$/g, '')
    .toLowerCase()
    .trim()
}

export function sentenceAroundToken(text: string, token: WordToken): string {
  const boundaries = /[.!?]["'’”)]?\s+|\n+/g
  let start = 0
  let end = text.length
  for (const match of text.matchAll(boundaries)) {
    const boundaryEnd = (match.index ?? 0) + match[0].length
    if (boundaryEnd <= token.start) start = boundaryEnd
    else {
      end = boundaryEnd
      break
    }
  }
  return text.slice(start, end).trim()
}

export function conservativeLemmaCandidates(word: string): string[] {
  const candidates: string[] = []
  const add = (candidate: string) => {
    if (candidate.length >= 2 && candidate !== word && !candidates.includes(candidate)) candidates.push(candidate)
  }
  if (word.endsWith("'s")) add(word.slice(0, -2))
  if (word.endsWith('ies') && word.length > 4) add(`${word.slice(0, -3)}y`)
  if (word.endsWith('ves') && word.length > 4) {
    add(`${word.slice(0, -3)}f`)
    add(`${word.slice(0, -3)}fe`)
  }
  if (word.endsWith('es') && word.length > 3) add(word.slice(0, -2))
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) add(word.slice(0, -1))
  if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`)
  if (word.endsWith('ed') && word.length > 3) {
    add(word.slice(0, -2))
    add(word.slice(0, -1))
  }
  if (word.endsWith('ing') && word.length > 5) {
    add(word.slice(0, -3))
    add(`${word.slice(0, -3)}e`)
    const stem = word.slice(0, -3)
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1))
  }
  return candidates
}
