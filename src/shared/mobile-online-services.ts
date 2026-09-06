import type {
  ConnectionTestResult,
  ContextDefinition,
  DictionaryCredentialStatus,
  DictionaryExample,
  DictionaryLookupRequest,
  LexemeKey,
  SpeechPreferences,
  SpeechPlaybackState,
  SpeechSettings,
  SpeechSynthesisRequest,
  SpeechUsage,
  TranslationPreferences,
  TranslationProgress,
  TranslationResult,
  TranslationSettings,
} from './types'

export const MOBILE_ONLINE_SERVICES_CONTRACT_VERSION = 1 as const

export type MobileServiceErrorCode =
  | 'invalidInput'
  | 'serviceBusy'
  | 'secretMissing'
  | 'secretRejected'
  | 'secretUnavailable'
  | 'networkCancelled'
  | 'networkTimeout'
  | 'networkTls'
  | 'networkOffline'
  | 'networkResponseTooLarge'
  | 'networkTransport'
  | 'serviceUnavailable'
  | 'invalidResponse'
  | 'responseTruncated'
  | 'audioFocusDenied'
  | 'speechUnavailable'

export interface MobileTranslationClient {
  getSettings(): Promise<TranslationSettings>
  savePreferences(preferences: TranslationPreferences): Promise<TranslationSettings>
  saveApiKey(providerId: string, modelId: string, value: string): Promise<ConnectionTestResult>
  deleteApiKey(providerId: string): Promise<TranslationSettings>
  testConnection(): Promise<ConnectionTestResult>
  translateArticle(articleId: string, force?: boolean): Promise<TranslationResult>
  cancel(articleId: string): Promise<void>
  onProgress(callback: (progress: TranslationProgress) => void): () => void
}

export interface MobileDictionaryOnlineClient {
  getCredentialStatus(): Promise<DictionaryCredentialStatus>
  saveCredentials(apiKey: string, secretKey: string): Promise<ConnectionTestResult>
  deleteCredentials(): Promise<void>
  testConnection(): Promise<ConnectionTestResult>
  explainContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<ContextDefinition>
  enrichExamples(lexemeKey: LexemeKey): Promise<DictionaryExample[]>
}

export interface MobileSpeechClient {
  playQueue(request: Omit<SpeechSynthesisRequest,'text'> & {sourceId:string;title:string;items:Array<{id:string;blockId:string;text:string}>;startIndex:number}): Promise<void>
  getQueueState(): Promise<SpeechPlaybackState & {buffering?:boolean}>
  seekQueue(index:number): Promise<void>
  getSettings(): Promise<SpeechSettings>
  savePreferences(preferences: SpeechPreferences): Promise<SpeechPreferences>
  saveApiKey(providerId: 'google' | 'minimax', value: string): Promise<ConnectionTestResult>
  deleteApiKey(providerId: 'google' | 'minimax'): Promise<SpeechSettings>
  testConnection(providerId: 'google' | 'minimax'): Promise<ConnectionTestResult>
  play(request: SpeechSynthesisRequest & { sourceId: string; itemId: string; usage: SpeechUsage }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}
