import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SpeechPlaybackState, SpeechPreferences, SpeechUsage, SpeechVoice } from '../../shared/types'
import type { SpeechQueueItem } from '../../core/speech'
import { DEFAULT_SPEECH_PREFERENCES } from '../../core/speech-providers'
import { getAppClient } from '../app-client'

const client = getAppClient()
const IDLE: SpeechPlaybackState = {
  status: 'idle', sourceId: null, itemId: null, index: 0, total: 0, error: null,
}

interface SpeechContextValue {
  preferences: SpeechPreferences
  voices: SpeechVoice[]
  voicesLoaded: boolean
  supported: boolean
  systemSupported: boolean
  state: SpeechPlaybackState
  canPlay(usage: SpeechUsage): boolean
  play(sourceId: string, items: SpeechQueueItem[], startIndex?: number, usage?: SpeechUsage): void
  speakWord(sourceId: string, itemId: string, text: string): void
  preview(preferences: SpeechPreferences, text: string, usage: SpeechUsage): void
  pause(): void
  resume(): void
  previous(): void
  next(): void
  stop(): void
  savePreferences(value: SpeechPreferences): Promise<SpeechPreferences>
  refreshVoices(): Promise<void>
}

const SpeechContext = createContext<SpeechContextValue | null>(null)

export function SpeechProvider({ children, onError }: { children: ReactNode; onError(message: string): void }) {
  const [preferences, setPreferences] = useState({ ...DEFAULT_SPEECH_PREFERENCES })
  const [voices, setVoices] = useState<SpeechVoice[]>([])
  const [voicesLoaded, setVoicesLoaded] = useState(false)
  const [state, setState] = useState(IDLE)
  const supported = client.speech.isSupported()
  const systemSupported = client.speech.isSystemSupported()

  useEffect(() => {
    client.speech.getPreferences().then(setPreferences).catch((reason) => onError(messageOf(reason)))
    client.speech.listVoices().then(setVoices).catch(() => setVoices([])).finally(() => setVoicesLoaded(true))
    return client.speech.subscribe(setState)
  }, [onError])

  useEffect(() => {
    if (state.status === 'error' && state.error) onError(state.error)
  }, [onError, state.error, state.status])

  const play = useCallback((sourceId: string, items: SpeechQueueItem[], startIndex = 0, usage: SpeechUsage = 'article') => {
    client.speech.play({ sourceId, items, startIndex, preferences, usage })
  }, [preferences])

  const speakWord = useCallback((sourceId: string, itemId: string, text: string) => {
    client.speech.play({ sourceId, items: [{ id: itemId, text }], preferences, usage: 'word' })
  }, [preferences])

  const preview = useCallback((previewPreferences: SpeechPreferences, text: string, usage: SpeechUsage) => {
    client.speech.play({ sourceId: 'settings-preview', items: [{ id: 'preview', text }], preferences: previewPreferences, usage })
  }, [])

  const canPlay = useCallback((usage: SpeechUsage) => {
    const providerId = usage === 'article' ? preferences.articleProviderId : preferences.wordProviderId
    return providerId !== 'system' || systemSupported
  }, [preferences.articleProviderId, preferences.wordProviderId, systemSupported])

  const savePreferences = useCallback(async (value: SpeechPreferences) => {
    const saved = await client.speech.savePreferences(value)
    client.speech.stop()
    setPreferences(saved)
    return saved
  }, [])

  const refreshVoices = useCallback(async () => {
    setVoicesLoaded(false)
    try { setVoices(await client.speech.refreshVoices()) }
    finally { setVoicesLoaded(true) }
  }, [])

  const value = useMemo<SpeechContextValue>(() => ({
    preferences, voices, voicesLoaded, supported, systemSupported, state, canPlay, play, speakWord, preview,
    pause: () => client.speech.pause(),
    resume: () => client.speech.resume(),
    previous: () => client.speech.previous(),
    next: () => client.speech.next(),
    stop: () => client.speech.stop(),
    savePreferences,
    refreshVoices,
  }), [canPlay, play, preferences, preview, refreshVoices, savePreferences, speakWord, state, supported, systemSupported, voices, voicesLoaded])

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>
}

export function useSpeech(): SpeechContextValue {
  const value = useContext(SpeechContext)
  if (!value) throw new Error('SpeechProvider is missing')
  return value
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
