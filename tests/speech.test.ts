import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitSpeechText } from '../src/core/speech'
import { SqliteApplicationRepository } from '../src/main/database'
import { WebSpeechRuntime, type RemoteAudioPlayback } from '../src/renderer/speech/web-speech-runtime'
import type { SpeechPreferences } from '../src/shared/types'

const PREFERENCES: SpeechPreferences = {
  locale: 'en-US', voiceId: null, rate: 0.9,
  autoPlayStudy: false, wordProviderId: 'system', articleProviderId: 'google',
  providerSettings: {
    google: { modelId: 'standard', voiceId: 'en-US-Standard-C' },
    minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
  },
}

class FakeUtterance {
  lang = ''
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onend: ((event: SpeechSynthesisEvent) => void) | null = null
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null
  constructor(readonly text: string) {}
}

class FakeSynthesis extends EventTarget {
  spoken: FakeUtterance[] = []
  cancelCount = 0
  paused = false
  constructor(private voices: SpeechSynthesisVoice[] = []) { super() }
  getVoices() { return this.voices }
  setVoices(voices: SpeechSynthesisVoice[]) { this.voices = voices; this.dispatchEvent(new Event('voiceschanged')) }
  speak(value: SpeechSynthesisUtterance) { this.spoken.push(value as unknown as FakeUtterance) }
  cancel() { this.cancelCount += 1 }
  pause() { this.paused = true }
  resume() { this.paused = false }
}

function voice(id: string, lang: string, isDefault = false): SpeechSynthesisVoice {
  return { voiceURI: id, name: id, lang, localService: true, default: isDefault } as SpeechSynthesisVoice
}

describe('speech text preparation', () => {
  it('normalizes whitespace and splits long text without oversized chunks', () => {
    const chunks = splitSpeechText(`  First sentence.  ${'word '.repeat(90)} Last sentence!`, 80)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true)
    expect(chunks.join(' ')).not.toContain('  ')
  })
})

describe('WebSpeechRuntime', () => {
  beforeEach(() => {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('queues blocks, selects the locale fallback voice and advances on completion', async () => {
    const synth = new FakeSynthesis([voice('British', 'en-GB'), voice('American', 'en-US', true)])
    const runtime = new WebSpeechRuntime(synth as unknown as SpeechSynthesis)
    runtime.play({ sourceId: 'reader', preferences: PREFERENCES, items: [{ id: 'a', text: 'Alpha.' }, { id: 'b', text: 'Beta.' }] })
    await Promise.resolve()
    expect(synth.spoken[0]).toMatchObject({ text: 'Alpha.', rate: 0.9, lang: 'en-US', voice: expect.objectContaining({ voiceURI: 'American' }) })
    synth.spoken[0].onend?.({} as SpeechSynthesisEvent)
    expect(runtime.getState()).toMatchObject({ itemId: 'b', index: 1, total: 2, status: 'playing' })
    expect(synth.spoken[1].text).toBe('Beta.')
    synth.spoken[1].onend?.({} as SpeechSynthesisEvent)
    expect(runtime.getState().status).toBe('idle')
  })

  it('supports pause, resume, navigation and ignores completion from replaced work', async () => {
    const synth = new FakeSynthesis([voice('American', 'en-US')])
    const runtime = new WebSpeechRuntime(synth as unknown as SpeechSynthesis)
    runtime.play({ sourceId: 'first', preferences: PREFERENCES, items: [{ id: 'a', text: 'Alpha.' }, { id: 'b', text: 'Beta.' }] })
    await Promise.resolve()
    const stale = synth.spoken[0]
    runtime.pause(); expect(runtime.getState().status).toBe('paused'); expect(synth.paused).toBe(true)
    runtime.resume(); expect(runtime.getState().status).toBe('playing'); expect(synth.paused).toBe(false)
    runtime.next(); await Promise.resolve(); expect(runtime.getState().itemId).toBe('b')
    runtime.previous(); await Promise.resolve(); expect(runtime.getState().itemId).toBe('a')
    runtime.play({ sourceId: 'second', preferences: PREFERENCES, items: [{ id: 'c', text: 'Current.' }] })
    await Promise.resolve()
    const before = synth.spoken.length
    stale.onend?.({} as SpeechSynthesisEvent)
    expect(synth.spoken).toHaveLength(before)
    expect(runtime.getState()).toMatchObject({ sourceId: 'second', itemId: 'c' })
  })

  it('returns an empty voice list after delayed enumeration and still remains supported', async () => {
    vi.useFakeTimers()
    const synth = new FakeSynthesis()
    const runtime = new WebSpeechRuntime(synth as unknown as SpeechSynthesis)
    const pending = runtime.listVoices()
    await vi.advanceTimersByTimeAsync(800)
    await expect(pending).resolves.toEqual([])
    expect(runtime.isSupported()).toBe(true)
    vi.useRealTimers()
  })

  it('reports synthesis errors but ignores cancellation errors', async () => {
    const synth = new FakeSynthesis()
    const runtime = new WebSpeechRuntime(synth as unknown as SpeechSynthesis)
    runtime.play({ sourceId: 'word', preferences: PREFERENCES, items: [{ id: 'x', text: 'Example' }] })
    await Promise.resolve()
    synth.spoken[0].onerror?.({ error: 'synthesis-failed' } as SpeechSynthesisErrorEvent)
    expect(runtime.getState()).toMatchObject({ status: 'error', error: expect.stringContaining('synthesis-failed') })
  })

  it('routes article reading to remote Google audio and advances the shared queue', async () => {
    const playback: RemoteAudioPlayback = {
      onended: null,
      onerror: null,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      dispose: vi.fn(),
    }
    const synthesize = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' as const }))
    const runtime = new WebSpeechRuntime(null, { synthesize, createPlayback: () => playback })
    runtime.play({
      sourceId: 'reader', usage: 'article', preferences: PREFERENCES,
      items: [{ id: 'a', text: 'First paragraph.' }, { id: 'b', text: 'Second paragraph.' }],
    })
    await vi.waitFor(() => expect(playback.play).toHaveBeenCalledOnce())
    expect(synthesize).toHaveBeenCalledWith({
      providerId: 'google', text: 'First paragraph.', locale: 'en-US',
      modelId: 'standard', voiceId: 'en-US-Standard-C', rate: 0.9,
    })
    playback.onended?.()
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2))
    expect(runtime.getState()).toMatchObject({ itemId: 'b', index: 1, total: 2 })
    runtime.pause(); expect(playback.pause).toHaveBeenCalled()
    runtime.stop(); expect(playback.dispose).toHaveBeenCalled()
  })
})

describe('speech preferences', () => {
  it('defaults, validates and persists without a schema migration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-speech-'))
    try {
      let database = await SqliteApplicationRepository.open(root, 'test')
      expect(database.getSpeechPreferences()).toEqual(PREFERENCES)
      expect(database.saveSpeechPreferences({
        locale: 'en-GB', voiceId: '  voice-id  ', rate: 9,
        autoPlayStudy: true, wordProviderId: 'google', articleProviderId: 'system',
        providerSettings: {
          google: { modelId: 'invalid', voiceId: 'invalid' },
          minimax: { modelId: 'speech-2.8-hd', voiceId: 'English_CalmWoman' },
        },
      })).toEqual({
        locale: 'en-GB', voiceId: 'voice-id', rate: 2,
        autoPlayStudy: true, wordProviderId: 'google', articleProviderId: 'system',
        providerSettings: {
          google: { modelId: 'standard', voiceId: 'en-GB-Standard-A' },
          minimax: { modelId: 'speech-2.8-hd', voiceId: 'English_CalmWoman' },
        },
      })
      expect(database.exportPortableUserData().settings.map((setting) => setting.key)).toContain('speech.preferences')
      database.close()

      const raw = new DatabaseSync(path.join(root, 'reader.sqlite'))
      raw.prepare("UPDATE settings SET value = 'broken' WHERE key = 'speech.preferences'").run()
      raw.close()
      database = await SqliteApplicationRepository.open(root, 'test')
      expect(database.getSpeechPreferences()).toEqual(PREFERENCES)
      database.close()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
