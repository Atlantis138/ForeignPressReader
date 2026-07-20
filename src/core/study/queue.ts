export function deterministicScore(seed: string, lexemeKey: string): string {
  let hash = 2166136261
  const value = `${seed}\u001f${lexemeKey}`
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function deterministicUnit(seed: string, key: string): number {
  const value = Number.parseInt(deterministicScore(seed, key), 16)
  return (value + 1) / 0x1_0000_0001
}

export function weightedNewScore(seed: string, lexemeKey: string, rank: number | null): number {
  const weight = rank && rank > 0 ? 1 + 4 / (1 + rank / 5000) : 1
  return -Math.log(deterministicUnit(seed, lexemeKey)) / weight
}

export function mergeDailyPools<T>(reviews: T[], newWords: T[], order: 'mixed' | 'review_first' | 'new_first', seed: string): T[] {
  if (order === 'review_first') return [...reviews, ...newWords]
  if (order === 'new_first') return [...newWords, ...reviews]
  const left = [...reviews]
  const right = [...newWords]
  const output: T[] = []
  let last: 'review' | 'new' | null = null
  let streak = 0
  while (left.length || right.length) {
    let choice: 'review' | 'new'
    if (!left.length) choice = 'new'
    else if (!right.length) choice = 'review'
    else if (streak >= 2) choice = last === 'review' ? 'new' : 'review'
    else {
      const reviewChance = left.length / (left.length + right.length)
      choice = deterministicUnit(seed, String(output.length)) < reviewChance ? 'review' : 'new'
    }
    output.push((choice === 'review' ? left : right).shift()!)
    if (choice === last) streak++
    else { last = choice; streak = 1 }
  }
  return output
}

export function reinforcementInsertionIndex(seed: string, remainingCount: number): number {
  if (remainingCount <= 0) return 0
  return 1 + Math.floor(deterministicUnit(seed, String(remainingCount)) * remainingCount)
}

export function nextReinforcementState(
  answer: 'known' | 'unknown',
  hadFailure: boolean,
  consecutiveKnown: number,
): { completed: boolean; hadFailure: boolean; consecutiveKnown: number; revealed: boolean } {
  if (answer === 'unknown') return { completed: false, hadFailure: true, consecutiveKnown: 0, revealed: true }
  if (!hadFailure) return { completed: true, hadFailure: false, consecutiveKnown: 0, revealed: false }
  const next = consecutiveKnown + 1
  return { completed: next >= 2, hadFailure: true, consecutiveKnown: next, revealed: false }
}
