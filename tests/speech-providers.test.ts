import { describe, expect, it, vi } from 'vitest'
import { createDefaultSpeechProviderRegistry, SpeechProviderRegistry } from '../src/core/speech-providers'
import { SpeechSynthesisService } from '../src/main/speech-service'
import { createDefaultSpeechAdapterRegistry, SpeechProviderAdapterRegistry } from '../src/main/speech-provider-adapters'

const cache = { getOrCreate: async (_request: unknown, producer: () => Promise<unknown>) => producer() }

describe('speech provider registry', () => {
  it('normalizes provider settings and locale-specific voices', () => {
    const registry = createDefaultSpeechProviderRegistry()
    expect(registry.normalize(null)).toEqual({
      locale: 'en-US', voiceId: null, rate: 0.9, autoPlayStudy: false,
      wordProviderId: 'system', articleProviderId: 'google',
      providerSettings: {
        google: { modelId: 'standard', voiceId: 'en-US-Standard-C' },
        minimax: { modelId: 'speech-2.8-turbo', voiceId: 'English_expressive_narrator' },
      },
    })
    expect(registry.normalize({
      locale: 'en-GB', voiceId: ' local ', rate: 4,
      autoPlayStudy: true, wordProviderId: 'minimax', articleProviderId: 'system',
      providerSettings: { google: { modelId: 'standard', voiceId: 'en-GB-Standard-B' } },
    })).toMatchObject({
      locale: 'en-GB', voiceId: 'local', rate: 2, autoPlayStudy: true,
      wordProviderId: 'minimax', articleProviderId: 'system',
      providerSettings: { google: { modelId: 'standard', voiceId: 'en-GB-Standard-B' } },
    })
  })
})

describe('remote speech adapters', () => {
  it('accepts a third registered provider without changing the central synthesis service', async () => {
    const providers = new SpeechProviderRegistry([{
      id: 'example-tts', name: 'Example TTS', description: 'Test adapter', requiresApiKey: true,
      credentialId: 'example-tts', models: [{ id: 'example-model', name: 'Example', description: 'Test' }],
      voices: [{ id: 'ExampleVoice', name: 'Example Voice', locales: ['en-US'] }],
      defaultModelId: 'example-model', defaultVoiceByLocale: { 'en-US': 'ExampleVoice' },
    }])
    const synthesize = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' as const }))
    const adapters = new SpeechProviderAdapterRegistry([{ providerId: 'example-tts', synthesize }])
    const service = new SpeechSynthesisService(
      { getApiKey: async () => 'test-key' }, providers, adapters, { fetch: vi.fn() }, cache as never,
    )
    const result = await service.synthesize({
      providerId: 'example-tts', modelId: 'example-model', text: 'Example.', locale: 'en-US',
      voiceId: 'ExampleVoice', rate: 1,
    })
    expect([...result.bytes]).toEqual([1, 2, 3])
    expect(synthesize).toHaveBeenCalledOnce()
    expect(providers.toOptions(new Map())[0].id).toBe('example-tts')
  })

  it('keeps Google authentication and request format unchanged', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'test-secret-key' })
      expect(String(_url)).not.toContain('test-secret-key')
      expect(JSON.parse(String(init?.body))).toEqual({
        input: { text: 'An example sentence.' }, voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9 },
      })
      return new Response(JSON.stringify({ audioContent: Buffer.from('fake-mp3').toString('base64') }), { status: 200 })
    })
    const service = createService(fetcher)
    const result = await service.synthesize({
      providerId: 'google', modelId: 'standard', text: ' An   example sentence. ',
      locale: 'en-US', voiceId: 'en-US-Standard-C', rate: 0.9,
    })
    expect(Buffer.from(result.bytes).toString()).toBe('fake-mp3')
  })

  it('uses MiniMax China with Bearer auth and decodes a bounded hex MP3', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.minimaxi.com/v1/t2a_v2')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-secret-key' })
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({
        model: 'speech-2.8-turbo', text: 'Editorial reading.', stream: false,
        language_boost: 'English', output_format: 'hex',
        voice_setting: { voice_id: 'English_expressive_narrator', speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      })
      return new Response(JSON.stringify({
        data: { audio: Buffer.from('mini-mp3').toString('hex'), status: 2 }, base_resp: { status_code: 0 },
      }), { status: 200 })
    })
    const result = await createService(fetcher).synthesize({
      providerId: 'minimax', modelId: 'speech-2.8-turbo', text: 'Editorial reading.',
      locale: 'en-US', voiceId: 'English_expressive_narrator', rate: 1,
    })
    expect(Buffer.from(result.bytes).toString()).toBe('mini-mp3')
  })

  it('rejects missing credentials and sanitizes authorization errors', async () => {
    const registry = createDefaultSpeechProviderRegistry()
    const missing = new SpeechSynthesisService(
      { getApiKey: async () => null }, registry, createDefaultSpeechAdapterRegistry(),
      { fetch: vi.fn() }, cache as never,
    )
    await expect(missing.synthesize({
      providerId: 'google', modelId: 'standard', text: 'Example', locale: 'en-US',
      voiceId: 'en-US-Standard-C', rate: 1,
    })).rejects.toThrow('请先在设置中填写')
    const denied = createService(vi.fn(async () => new Response('sensitive response', { status: 403 })))
    await expect(denied.synthesize({
      providerId: 'minimax', modelId: 'speech-2.8-turbo', text: 'Example', locale: 'en-US',
      voiceId: 'English_expressive_narrator', rate: 1,
    })).rejects.toThrow('API Key 无效')
  })

  it('maps MiniMax business authentication and quota codes without exposing upstream messages', async () => {
    const request = {
      providerId: 'minimax' as const, modelId: 'speech-2.8-turbo', text: 'Example', locale: 'en-US',
      voiceId: 'English_expressive_narrator', rate: 1,
    }
    const unauthorized = createService(vi.fn(async () => new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: 'upstream secret detail' },
    }), { status: 200 })))
    await expect(unauthorized.synthesize(request)).rejects.toThrow('API Key 无效')
    await expect(unauthorized.synthesize(request)).rejects.not.toThrow('upstream secret detail')

    const exhausted = createService(vi.fn(async () => new Response(JSON.stringify({
      base_resp: { status_code: 1008, status_msg: 'upstream account detail' },
    }), { status: 200 })))
    await expect(exhausted.synthesize(request)).rejects.toThrow('配额不足')
  })
})

function createService(fetcher: ReturnType<typeof vi.fn>): SpeechSynthesisService {
  return new SpeechSynthesisService(
    { getApiKey: async () => 'test-secret-key' }, createDefaultSpeechProviderRegistry(),
    createDefaultSpeechAdapterRegistry(), { fetch: fetcher }, cache as never,
  )
}
