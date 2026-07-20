import type { SpeechPlaybackState, SpeechPreferences, SpeechUsage, SpeechVoice } from '../shared/types'

export interface SpeechQueueItem {
  id: string
  text: string
  label?: string
}

export interface SpeechPlayRequest {
  sourceId: string
  items: SpeechQueueItem[]
  preferences: SpeechPreferences
  usage?: SpeechUsage
  startIndex?: number
}

export interface SpeechRuntime {
  isSupported(): boolean
  isSystemSupported(): boolean
  listVoices(): Promise<SpeechVoice[]>
  refreshVoices(): Promise<SpeechVoice[]>
  play(request: SpeechPlayRequest): void
  pause(): void
  resume(): void
  previous(): void
  next(): void
  stop(): void
  getState(): SpeechPlaybackState
  subscribe(callback: (state: SpeechPlaybackState) => void): () => void
}

export function splitSpeechText(value: string, maximumLength = 300): string[] {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return []
  if (text.length <= maximumLength) return [text]

  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+(?:[”’"']+)?|[^.!?。！？]+$/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (sentence.length > maximumLength) {
      if (current) { chunks.push(current); current = '' }
      chunks.push(...splitLongSentence(sentence, maximumLength))
      continue
    }
    const combined = current ? `${current} ${sentence}` : sentence
    if (combined.length > maximumLength) {
      chunks.push(current)
      current = sentence
    } else current = combined
  }
  if (current) chunks.push(current)
  return chunks
}

function splitLongSentence(sentence: string, maximumLength: number): string[] {
  const words = sentence.split(' ')
  const chunks: string[] = []
  let current = ''
  for (const word of words) {
    if (word.length > maximumLength) {
      if (current) { chunks.push(current); current = '' }
      for (let start = 0; start < word.length; start += maximumLength) chunks.push(word.slice(start, start + maximumLength))
      continue
    }
    const combined = current ? `${current} ${word}` : word
    if (combined.length > maximumLength) {
      chunks.push(current)
      current = word
    } else current = combined
  }
  if (current) chunks.push(current)
  return chunks
}
