import type { AppClient } from '../core/app-client'
import { createWebSpeechRuntime } from './speech/web-speech-runtime'

const runtime = createWebSpeechRuntime((request) => window.readerApi.speech.synthesize(request))
let currentClient: AppClient = {
  ...window.readerApi,
  platform: {
    runtime: 'electron',
  },
  speech: {
    ...window.readerApi.speech,
    isSupported: () => runtime.isSupported(),
    isSystemSupported: () => runtime.isSystemSupported(),
    listVoices: () => runtime.listVoices(),
    refreshVoices: () => runtime.refreshVoices(),
    play: (request) => runtime.play(request),
    pause: () => runtime.pause(),
    resume: () => runtime.resume(),
    previous: () => runtime.previous(),
    next: () => runtime.next(),
    stop: () => runtime.stop(),
    getState: () => runtime.getState(),
    subscribe: (callback) => runtime.subscribe(callback),
  },
}

export function getAppClient(): AppClient {
  return currentClient
}

export function setAppClientForTesting(client: AppClient): void {
  currentClient = client
}
