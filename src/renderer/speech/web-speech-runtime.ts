import type {
  SpeechAudio,
  SpeechPlaybackState,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechVoice,
} from '../../shared/types'
import type { SpeechPlayRequest, SpeechRuntime } from '../../core/speech'
import { splitSpeechText } from '../../core/speech'

const IDLE_STATE: SpeechPlaybackState = {
  status: 'idle', sourceId: null, itemId: null, index: 0, total: 0, error: null,
}

type PreparedItem = SpeechPlayRequest['items'][number] & { chunks: string[] }

export interface RemoteAudioPlayback {
  onended: (() => void) | null
  onerror: (() => void) | null
  play(): Promise<void>
  pause(): void
  dispose(): void
}

export interface RemoteSpeechAdapter {
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechAudio>
  createPlayback(audio: SpeechAudio): RemoteAudioPlayback
}

export class WebSpeechRuntime implements SpeechRuntime {
  private state: SpeechPlaybackState = IDLE_STATE
  private listeners = new Set<(state: SpeechPlaybackState) => void>()
  private items: PreparedItem[] = []
  private itemIndex = 0
  private chunkIndex = 0
  private generation = 0
  private request: SpeechPlayRequest | null = null
  private providerId: SpeechProviderId = 'system'
  private remoteAudio: RemoteAudioPlayback | null = null

  constructor(
    private readonly synthesizer: SpeechSynthesis | null,
    private readonly remote: RemoteSpeechAdapter | null = null,
  ) {}

  isSupported(): boolean { return this.isSystemSupported() || Boolean(this.remote) }

  isSystemSupported(): boolean {
    return Boolean(this.synthesizer && typeof SpeechSynthesisUtterance !== 'undefined')
  }

  async listVoices(): Promise<SpeechVoice[]> {
    const synthesizer = this.synthesizer
    if (!synthesizer) return []
    const immediate = this.readVoices()
    if (immediate.length) return immediate
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        synthesizer.removeEventListener('voiceschanged', finish)
        resolve(this.readVoices())
      }
      const timer = globalThis.setTimeout(finish, 800)
      synthesizer.addEventListener('voiceschanged', finish)
    })
  }

  refreshVoices(): Promise<SpeechVoice[]> { return this.listVoices() }

  play(request: SpeechPlayRequest): void {
    const usage = request.usage ?? 'word'
    const selectedProviderId = usage === 'article'
      ? request.preferences.articleProviderId
      : request.preferences.wordProviderId
    this.providerId = selectedProviderId
    if (this.providerId === 'system' && !this.isSystemSupported()) return this.fail('当前设备不支持系统语音')
    if (this.providerId !== 'system' && !this.remote) return this.fail('当前环境不支持远程语音播放')
    const maximumLength = this.providerId !== 'system' ? 3_000 : 300
    const items = request.items
      .map((item) => ({ ...item, chunks: splitSpeechText(item.text, maximumLength) }))
      .filter((item) => item.chunks.length > 0)
    if (!items.length) { this.stop(); return }
    this.generation += 1
    this.synthesizer?.cancel()
    this.disposeRemoteAudio()
    this.request = request
    this.items = items
    this.itemIndex = Math.min(Math.max(0, request.startIndex ?? 0), items.length - 1)
    this.chunkIndex = 0
    this.publishCurrent('playing')
    const generation = this.generation
    queueMicrotask(() => { if (generation === this.generation) this.startCurrent(generation) })
  }

  pause(): void {
    if (this.state.status !== 'playing') return
    if (this.providerId === 'system') this.synthesizer?.pause()
    else this.remoteAudio?.pause()
    this.setState({ ...this.state, status: 'paused' })
  }

  resume(): void {
    if (this.state.status !== 'paused') return
    this.setState({ ...this.state, status: 'playing' })
    if (this.providerId === 'system') this.synthesizer?.resume()
    else if (this.remoteAudio) void this.remoteAudio.play().catch((reason) => this.fail(messageOf(reason)))
  }

  previous(): void {
    if (!this.items.length) return
    this.restartAt(Math.max(0, this.itemIndex - 1))
  }

  next(): void {
    if (!this.items.length) return
    if (this.itemIndex >= this.items.length - 1) { this.stop(); return }
    this.restartAt(this.itemIndex + 1)
  }

  stop(): void {
    this.generation += 1
    this.synthesizer?.cancel()
    this.disposeRemoteAudio()
    this.items = []
    this.request = null
    this.itemIndex = 0
    this.chunkIndex = 0
    this.setState(IDLE_STATE)
  }

  getState(): SpeechPlaybackState { return this.state }

  subscribe(callback: (state: SpeechPlaybackState) => void): () => void {
    this.listeners.add(callback)
    callback(this.state)
    return () => this.listeners.delete(callback)
  }

  private speakCurrent(generation: number): void {
    if (!this.synthesizer || generation !== this.generation || !this.request) return
    const item = this.items[this.itemIndex]
    const text = item?.chunks[this.chunkIndex]
    if (!item || !text) { this.finish(); return }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = this.request.preferences.locale
    utterance.rate = this.request.preferences.rate
    const voices = this.synthesizer.getVoices()
    const selected = voices.find((voice) => voice.voiceURI === this.request!.preferences.voiceId)
      ?? voices.find((voice) => voice.lang.toLowerCase() === this.request!.preferences.locale.toLowerCase())
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en'))
    if (selected) utterance.voice = selected
    utterance.onend = () => {
      if (generation !== this.generation) return
      this.advance(generation)
    }
    utterance.onerror = (event) => {
      if (generation !== this.generation || ['canceled', 'interrupted'].includes(event.error)) return
      this.fail(`系统语音播放失败：${event.error || '未知错误'}`)
    }
    this.synthesizer.speak(utterance)
  }

  private async speakRemoteCurrent(generation: number): Promise<void> {
    if (!this.remote || generation !== this.generation || !this.request) return
    const item = this.items[this.itemIndex]
    const text = item?.chunks[this.chunkIndex]
    if (!item || !text) { this.finish(); return }
    try {
      if (this.providerId === 'system') return
      const setting = this.request.preferences.providerSettings[this.providerId]
      const audio = await this.remote.synthesize({
        providerId: this.providerId,
        modelId: setting.modelId,
        text,
        locale: this.request.preferences.locale,
        voiceId: setting.voiceId,
        rate: this.request.preferences.rate,
      })
      if (generation !== this.generation) return
      this.disposeRemoteAudio()
      const playback = this.remote.createPlayback(audio)
      playback.onended = () => {
        if (generation !== this.generation) return
        this.disposeRemoteAudio()
        this.advance(generation)
      }
      playback.onerror = () => {
        if (generation === this.generation) this.fail('远程语音音频播放失败')
      }
      this.remoteAudio = playback
      if (this.state.status === 'playing') await playback.play()
    } catch (reason) {
      if (generation === this.generation) this.fail(messageOf(reason))
    }
  }

  private startCurrent(generation: number): void {
    if (this.providerId === 'system') this.speakCurrent(generation)
    else void this.speakRemoteCurrent(generation)
  }

  private advance(generation: number): void {
    const item = this.items[this.itemIndex]
    if (!item || generation !== this.generation) return
    if (this.chunkIndex + 1 < item.chunks.length) {
      this.chunkIndex += 1
      this.startCurrent(generation)
    } else if (this.itemIndex + 1 < this.items.length) {
      this.itemIndex += 1
      this.chunkIndex = 0
      this.publishCurrent('playing')
      this.startCurrent(generation)
    } else this.finish()
  }

  private restartAt(index: number): void {
    this.generation += 1
    this.synthesizer?.cancel()
    this.disposeRemoteAudio()
    this.itemIndex = index
    this.chunkIndex = 0
    this.publishCurrent('playing')
    const generation = this.generation
    queueMicrotask(() => { if (generation === this.generation) this.startCurrent(generation) })
  }

  private finish(): void {
    this.generation += 1
    this.items = []
    this.request = null
    this.disposeRemoteAudio()
    this.setState(IDLE_STATE)
  }

  private fail(message: string): void {
    this.generation += 1
    this.synthesizer?.cancel()
    this.disposeRemoteAudio()
    this.items = []
    this.request = null
    this.setState({ ...IDLE_STATE, status: 'error', error: message })
  }

  private publishCurrent(status: 'playing' | 'paused'): void {
    const item = this.items[this.itemIndex]
    this.setState({
      status,
      sourceId: this.request?.sourceId ?? null,
      itemId: item?.id ?? null,
      index: this.itemIndex,
      total: this.items.length,
      error: null,
    })
  }

  private setState(state: SpeechPlaybackState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  private readVoices(): SpeechVoice[] {
    return (this.synthesizer?.getVoices() ?? [])
      .filter((voice) => voice.lang.toLowerCase().startsWith('en'))
      .map((voice) => ({
        id: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
        default: voice.default,
        local: voice.localService,
      }))
      .sort((left, right) => Number(right.default) - Number(left.default) || left.lang.localeCompare(right.lang) || left.name.localeCompare(right.name))
  }

  private disposeRemoteAudio(): void {
    this.remoteAudio?.dispose()
    this.remoteAudio = null
  }
}

export function createWebSpeechRuntime(
  synthesize?: (request: SpeechSynthesisRequest) => Promise<SpeechAudio>,
): SpeechRuntime {
  const remote = typeof window !== 'undefined' && synthesize ? createBrowserRemoteAdapter(synthesize) : null
  return new WebSpeechRuntime(typeof window === 'undefined' ? null : window.speechSynthesis ?? null, remote)
}

function createBrowserRemoteAdapter(
  synthesize: (request: SpeechSynthesisRequest) => Promise<SpeechAudio>,
): RemoteSpeechAdapter {
  return {
    synthesize,
    createPlayback(audio) {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(audio.bytes)], { type: audio.mimeType }))
      const element = new Audio(url)
      let disposed = false
      const playback: RemoteAudioPlayback = {
        onended: null,
        onerror: null,
        play: () => element.play(),
        pause: () => element.pause(),
        dispose: () => {
          if (disposed) return
          disposed = true
          element.onended = null
          element.onerror = null
          element.pause()
          element.removeAttribute('src')
          element.load()
          URL.revokeObjectURL(url)
        },
      }
      element.onended = () => playback.onended?.()
      element.onerror = () => playback.onerror?.()
      return playback
    },
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
