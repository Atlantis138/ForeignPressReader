import type {
  CacheClearResult,
  DataApi,
  DeveloperState,
  StorageReport,
} from './types'

export const MOBILE_PLATFORM_SERVICES_CONTRACT_VERSION = 1 as const

export interface MobileAppInfo {
  os: string
  arch: string
  appVersion: string
  buildMode: 'debug' | 'release'
}

export interface MobileAppInfoClient {
  getInfo(): Promise<MobileAppInfo>
}

export interface MobileDataClient extends DataApi {
  discardPortableImport(token: string): Promise<void>
}

export interface MobileStorageClient {
  scan(): Promise<StorageReport>
  clearSafeCache(): Promise<CacheClearResult>
  clearAiTextCache(confirmationToken: string): Promise<CacheClearResult>
  openAppStorageSettings(): Promise<void>
}

export interface MobileDeveloperClient {
  getState(): Promise<DeveloperState>
  setEnabled(enabled: boolean): Promise<DeveloperState>
  setLoggingEnabled(enabled: boolean): Promise<DeveloperState>
  shareDiagnosticBundle(): Promise<void>
  clearLogs(): Promise<DeveloperState>
  forceNextStudyDay(confirmationToken: string): Promise<void>
  resetAllProgress(confirmationToken: string): Promise<DeveloperState>
  factoryReset(confirmationToken: string): Promise<void>
}
