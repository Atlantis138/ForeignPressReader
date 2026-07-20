import type { AppApi } from '../shared/types'
import type { SpeechRuntime } from './speech'

/**
 * Logical capabilities shared by every renderer shell.
 *
 * This is deliberately a TypeScript-only composition contract. It does not
 * change the serialized Electron preload API or any Tauri command/event shape.
 */
export type CommonAppCapabilities = Pick<
  AppApi,
  | 'library'
  | 'reader'
  | 'translation'
  | 'dictionary'
  | 'vocabulary'
  | 'study'
  | 'data'
  | 'storage'
  | 'sync'
>

export interface DesktopPlatformClient {
  readonly runtime: 'electron'
}

/**
 * Platform-neutral renderer capability table.
 *
 * Speech playback, settings/developer surfaces and platform actions genuinely
 * differ between Electron and Android, so those slots are explicit generic
 * extensions instead of being duplicated in a second app-client contract.
 */
export type AppClient<
  SpeechClient = AppApi['speech'] & SpeechRuntime,
  SettingsClient = AppApi['settings'],
  DeveloperClient = AppApi['developer'],
  PlatformClient = DesktopPlatformClient,
> = CommonAppCapabilities & {
  speech: SpeechClient
  settings: SettingsClient
  developer: DeveloperClient
  platform: PlatformClient
}
