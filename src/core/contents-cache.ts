import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { PublicationDetail, TranslationPreferences } from '../shared/types'
import { contentsSegments } from './contents-segments'
import { TRANSLATION_PROMPT_VERSION } from './translation-service'

/** Versioned, regenerable local cache; never part of portable or sync user data. */
export function contentsCacheKey(publication: PublicationDetail, preferences: TranslationPreferences): string {
  const source = [1, publication.id, publication.title, preferences.providerId, preferences.modelId,
    TRANSLATION_PROMPT_VERSION, contentsSegments(publication).map(({ id, type, text }) => [id, type, text])]
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(source))))
}

export interface ContentsCache {
  read(key: string): Record<string, string>
  write(key: string, translations: Record<string, string>): void
}
