import type { SyncChangePage } from '../../shared/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  CacheClearResult,
  DataStatus,
  DataTransferProgress,
  DeveloperState,
  PortableImportPreview,
  PortableTransferResult,
  SyncApi,
  SyncPageState,
  StorageReport,
} from '../../shared/types'
import type {
  MobileAppInfo,
  MobileAppInfoClient,
  MobileDataClient,
  MobileDeveloperClient,
  MobileStorageClient,
} from '../../shared/mobile-platform-services'
import { normalizePlatformError } from './platform-error'

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

class TauriLogicalClient {
  constructor(protected readonly invokeCommand: InvokeFn) {}

  protected async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await this.invokeCommand<T>(command, args) }
    catch (reason) { throw normalizePlatformError(reason) }
  }
}

export class TauriMobileAppInfoClient extends TauriLogicalClient implements MobileAppInfoClient {
  constructor(invokeCommand: InvokeFn = invoke) { super(invokeCommand) }

  getInfo(): Promise<MobileAppInfo> { return this.call('get_platform_info') }
}

export class TauriMobileDataClient extends TauriLogicalClient implements MobileDataClient {
  constructor(invokeCommand: InvokeFn = invoke) { super(invokeCommand) }

  getStatus(): Promise<DataStatus> { return this.call('get_mobile_data_status') }
  exportPortable(): Promise<PortableTransferResult | null> { return this.call('export_mobile_portable') }
  async selectPortableImport(): Promise<PortableImportPreview | null> {
    const selected = await this.call<{ preview: PortableImportPreview } | null>('select_mobile_portable_import')
    return selected?.preview ?? null
  }
  confirmPortableImport(token: string): Promise<PortableTransferResult> {
    return this.call<PortableTransferResult>('confirm_mobile_portable_import', { token })
  }
  async discardPortableImport(token: string): Promise<void> {
    await this.call('discard_mobile_portable_import', { token })
  }
  async cancelTransfer(): Promise<void> {
    await this.call('cancel_mobile_data_transfer')
  }
  onProgress(callback: (progress: DataTransferProgress) => void): () => void {
    let active = true
    let dispose: (() => void) | undefined
    void listen<DataTransferProgress>('mobile-data-transfer-progress', (event) => {
      if (active) callback(event.payload)
    }).then((unlisten) => {
      if (active) dispose = unlisten
      else unlisten()
    })
    return () => { active = false; dispose?.() }
  }
}

export class TauriMobileStorageClient extends TauriLogicalClient implements MobileStorageClient {
  constructor(invokeCommand: InvokeFn = invoke) { super(invokeCommand) }

  scan(): Promise<StorageReport> { return this.call('get_mobile_storage_report') }
  clearSafeCache(): Promise<CacheClearResult> { return this.call('clear_mobile_safe_cache') }
  clearAiTextCache(confirmationToken: string): Promise<CacheClearResult> {
    return this.call('clear_mobile_ai_text_cache', { confirmationToken })
  }
  openAppStorageSettings(): Promise<void> { return this.call('open_mobile_app_storage_settings') }
}

export class TauriMobileSyncClient extends TauriLogicalClient implements SyncApi {
  constructor(invokeCommand: InvokeFn = invoke) { super(invokeCommand) }

  openPage(): Promise<SyncPageState> { return this.call('open_mobile_sync_page') }
  closePage(): Promise<void> { return this.call('close_mobile_sync_page') }
  getState(): Promise<SyncPageState> { return this.call('get_mobile_sync_state') }
  refreshDiscovery(): Promise<SyncPageState> { return this.call('refresh_mobile_sync_discovery') }
  startPairing(deviceId: string): Promise<SyncPageState> {
    return this.call('start_mobile_sync_pairing', { deviceId })
  }
  confirmPairing(sessionId: string): Promise<SyncPageState> {
    return this.call('confirm_mobile_sync_pairing', { sessionId })
  }
  rejectPairing(sessionId: string): Promise<SyncPageState> {
    return this.call('reject_mobile_sync_pairing', { sessionId })
  }
  sendTo(deviceId: string): Promise<SyncPageState> {
    return this.call('send_mobile_sync_to', { deviceId })
  }
  getIncomingChanges(transferId: string, offset: number, limit: number): Promise<SyncChangePage> {
    return this.call('get_mobile_sync_incoming_changes', { transferId, offset, limit })
  }
  acceptIncoming(transferId: string): Promise<SyncPageState> {
    return this.call('accept_mobile_sync_incoming', { transferId })
  }
  rejectIncoming(transferId: string): Promise<SyncPageState> {
    return this.call('reject_mobile_sync_incoming', { transferId })
  }
  cancelOperation(): Promise<SyncPageState> { return this.call('cancel_mobile_sync_operation') }
  discardPendingTransfer(transferId: string): Promise<SyncPageState> {
    return this.call('discard_mobile_sync_pending_transfer', { transferId })
  }
  revokeTrust(deviceId: string): Promise<SyncPageState> {
    return this.call('revoke_mobile_sync_trust', { deviceId })
  }
}

export class TauriMobileDeveloperClient extends TauriLogicalClient implements MobileDeveloperClient {
  constructor(invokeCommand: InvokeFn = invoke) { super(invokeCommand) }

  getState(): Promise<DeveloperState> { return this.call('get_mobile_developer_state') }
  setEnabled(enabled: boolean): Promise<DeveloperState> {
    return this.call('set_mobile_developer_enabled', { enabled })
  }
  setLoggingEnabled(enabled: boolean): Promise<DeveloperState> {
    return this.call('set_mobile_developer_logging', { enabled })
  }
  shareDiagnosticBundle(): Promise<void> { return this.call('share_mobile_diagnostic_bundle') }
  clearLogs(): Promise<DeveloperState> { return this.call('clear_mobile_developer_logs') }
  forceNextStudyDay(confirmationToken: string): Promise<void> {
    return this.call('force_mobile_developer_next_study_day', { confirmationToken })
  }
  resetAllProgress(confirmationToken: string): Promise<DeveloperState> {
    return this.call('reset_mobile_developer_study_progress', { confirmationToken })
  }
  factoryReset(confirmationToken: string): Promise<void> {
    return this.call('factory_reset_mobile', { confirmationText: confirmationToken })
  }
}
