import type { SpeechApi, TranslationApi } from './types'

/** Optional service ports injected by the Android shell when E4 enables online services. */
export interface MobileReaderServiceSlots {
  translation: TranslationApi | null
  speech: SpeechApi | null
}

export const EMPTY_MOBILE_READER_SERVICES: MobileReaderServiceSlots = Object.freeze({
  translation: null,
  speech: null,
})
