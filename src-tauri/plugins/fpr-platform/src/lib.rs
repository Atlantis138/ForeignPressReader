#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

const PLUGIN_IDENTIFIER: &str = "com.local.foreignpressreader.foundation";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Mobile(#[from] tauri::plugin::mobile::PluginInvokeError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Mobile(tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response)) => {
                response.code.as_deref()
            }
            _ => None,
        }
    }
}

pub struct Foundation<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretSaveRequest<'a> {
    slot: &'a str,
    value: &'a str,
}

#[derive(Serialize)]
struct SecretSlotRequest<'a> {
    slot: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequest<'a> {
    pub request_id: &'a str,
    pub url: &'a str,
    pub method: &'a str,
    pub timeout_ms: u32,
    pub max_bytes: u32,
    pub headers_json: &'a str,
    pub body_base64: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkResponse {
    pub status: u16,
    pub body_bytes: u32,
    pub used_proxy: bool,
    pub body_base64: String,
    pub content_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest<'a> {
    request_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemTtsSpeakRequest<'a> {
    request_id: &'a str,
    text: &'a str,
    locale: &'a str,
    rate: f32,
    usage: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechAudioRequest<'a> {
    request_id: &'a str,
    path: &'a str,
    usage: &'a str,
}

#[derive(Serialize)]
struct ShareDiagnosticBundleRequest<'a> {
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncDiscoveryStartRequest<'a> {
    port: u16,
    service_name: &'a str,
    attributes_json: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDiscoveredService {
    pub service_name: String,
    pub host: String,
    pub port: u16,
    pub attributes: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncDiscoverySnapshot {
    pub peers: Vec<SyncDiscoveredService>,
    pub diagnostic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectEpubRequest<'a> {
    request_id: &'a str,
    destination: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectDictionaryPackRequest<'a> {
    request_id: &'a str,
    destination: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectPortableBackupRequest<'a> {
    request_id: &'a str,
    destination: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavePortableBackupRequest<'a> {
    request_id: &'a str,
    source: &'a str,
    suggested_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDictionarySourceRequest<'a> {
    request_id: &'a str,
    url: &'a str,
    destination: &'a str,
    expected_bytes: u64,
    git_blob_sha: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedDictionarySource {
    pub bytes: u64,
    pub used_proxy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedEpub {
    pub cancelled: bool,
    pub display_name: Option<String>,
    pub bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTtsCapability {
    pub available: bool,
    pub default_engine: Option<String>,
    pub english_available: bool,
    pub language_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStorageInfo {
    pub application_bytes: u64,
    pub secret_bytes: u64,
}

impl<R: Runtime> Foundation<R> {
    pub fn secret_save(&self, slot: &str, value: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("secretSave", SecretSaveRequest { slot, value })
            .map_err(Into::into)
    }

    pub fn secret_load(&self, slot: &str) -> Result<SecretValue> {
        self.0
            .run_mobile_plugin("secretLoad", SecretSlotRequest { slot })
            .map_err(Into::into)
    }

    pub fn secret_delete(&self, slot: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("secretDelete", SecretSlotRequest { slot })
            .map_err(Into::into)
    }

    pub fn secret_status(&self, slot: &str) -> Result<SecretStatus> {
        self.0
            .run_mobile_plugin("secretStatus", SecretSlotRequest { slot })
            .map_err(Into::into)
    }

    pub fn network_execute(&self, request: NetworkRequest<'_>) -> Result<NetworkResponse> {
        self.0
            .run_mobile_plugin("networkExecute", request)
            .map_err(Into::into)
    }

    pub fn network_cancel(&self, request_id: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("networkCancel", CancelRequest { request_id })
            .map_err(Into::into)
    }

    pub fn select_epub(&self, request_id: &str, destination: &str) -> Result<SelectedEpub> {
        self.0
            .run_mobile_plugin(
                "selectEpub",
                SelectEpubRequest {
                    request_id,
                    destination,
                },
            )
            .map_err(Into::into)
    }

    pub fn cancel_epub_import(&self, request_id: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("cancelEpubImport", CancelRequest { request_id })
            .map_err(Into::into)
    }

    pub fn select_dictionary_pack(
        &self,
        request_id: &str,
        destination: &str,
    ) -> Result<SelectedEpub> {
        self.0
            .run_mobile_plugin(
                "selectDictionaryPack",
                SelectDictionaryPackRequest {
                    request_id,
                    destination,
                },
            )
            .map_err(Into::into)
    }

    pub fn cancel_dictionary_pack_install(&self, request_id: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("cancelDictionaryPackInstall", CancelRequest { request_id })
            .map_err(Into::into)
    }

    pub fn select_portable_backup(
        &self,
        request_id: &str,
        destination: &str,
    ) -> Result<SelectedEpub> {
        self.0
            .run_mobile_plugin(
                "selectPortableBackup",
                SelectPortableBackupRequest {
                    request_id,
                    destination,
                },
            )
            .map_err(Into::into)
    }

    pub fn save_portable_backup(
        &self,
        request_id: &str,
        source: &str,
        suggested_name: &str,
    ) -> Result<SelectedEpub> {
        self.0
            .run_mobile_plugin(
                "savePortableBackup",
                SavePortableBackupRequest {
                    request_id,
                    source,
                    suggested_name,
                },
            )
            .map_err(Into::into)
    }

    pub fn cancel_portable_transfer(&self, request_id: &str) -> Result<()> {
        self.0
            .run_mobile_plugin("cancelPortableTransfer", CancelRequest { request_id })
            .map_err(Into::into)
    }

    pub fn open_app_storage_settings(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("openAppStorageSettings", ())
            .map_err(Into::into)
    }

    pub fn package_storage_info(&self) -> Result<PackageStorageInfo> {
        self.0
            .run_mobile_plugin("getPackageStorageInfo", ())
            .map_err(Into::into)
    }

    pub fn clear_webview_cache(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("clearWebViewCache", ())
            .map_err(Into::into)
    }

    pub fn sync_discovery_start(
        &self,
        port: u16,
        service_name: &str,
        attributes_json: &str,
    ) -> Result<()> {
        self.0
            .run_mobile_plugin(
                "syncDiscoveryStart",
                SyncDiscoveryStartRequest {
                    port,
                    service_name,
                    attributes_json,
                },
            )
            .map_err(Into::into)
    }

    pub fn sync_discovery_snapshot(&self) -> Result<SyncDiscoverySnapshot> {
        self.0
            .run_mobile_plugin("syncDiscoverySnapshot", ())
            .map_err(Into::into)
    }

    pub fn sync_discovery_refresh(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("syncDiscoveryRefresh", ())
            .map_err(Into::into)
    }

    pub fn sync_discovery_stop(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("syncDiscoveryStop", ())
            .map_err(Into::into)
    }

    pub fn download_dictionary_source(
        &self,
        request_id: &str,
        url: &str,
        destination: &str,
        expected_bytes: u64,
        git_blob_sha: &str,
    ) -> Result<DownloadedDictionarySource> {
        self.0
            .run_mobile_plugin(
                "downloadDictionarySource",
                DownloadDictionarySourceRequest {
                    request_id,
                    url,
                    destination,
                    expected_bytes,
                    git_blob_sha,
                },
            )
            .map_err(Into::into)
    }

    pub fn cancel_dictionary_source_download(&self, request_id: &str) -> Result<()> {
        self.0
            .run_mobile_plugin(
                "cancelDictionarySourceDownload",
                CancelRequest { request_id },
            )
            .map_err(Into::into)
    }

    pub fn system_tts_capability(&self) -> Result<SystemTtsCapability> {
        self.0
            .run_mobile_plugin("systemTtsCapability", ())
            .map_err(Into::into)
    }

    pub fn system_tts_speak(
        &self,
        request_id: &str,
        text: &str,
        locale: &str,
        rate: f32,
        usage: &str,
    ) -> Result<()> {
        self.0
            .run_mobile_plugin(
                "systemTtsSpeak",
                SystemTtsSpeakRequest {
                    request_id,
                    text,
                    locale,
                    rate,
                    usage,
                },
            )
            .map_err(Into::into)
    }

    pub fn play_speech_audio(&self, request_id: &str, path: &str, usage: &str) -> Result<()> {
        self.0
            .run_mobile_plugin(
                "playSpeechAudio",
                SpeechAudioRequest {
                    request_id,
                    path,
                    usage,
                },
            )
            .map_err(Into::into)
    }

    pub fn pause_speech(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("pauseSpeech", ())
            .map_err(Into::into)
    }
    pub fn resume_speech(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("resumeSpeech", ())
            .map_err(Into::into)
    }
    pub fn stop_speech(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("stopSpeech", ())
            .map_err(Into::into)
    }

    pub fn share_diagnostic_bundle(&self, path: &str) -> Result<()> {
        self.0
            .run_mobile_plugin(
                "shareDiagnosticBundle",
                ShareDiagnosticBundleRequest { path },
            )
            .map_err(Into::into)
    }

    pub fn factory_reset(&self) -> Result<()> {
        self.0
            .run_mobile_plugin("factoryReset", ())
            .map_err(Into::into)
    }
}

pub trait FoundationExt<R: Runtime> {
    fn foundation(&self) -> tauri::State<'_, Foundation<R>>;
}

impl<R: Runtime, T: Manager<R>> FoundationExt<R> for T {
    fn foundation(&self) -> tauri::State<'_, Foundation<R>> {
        self.state::<Foundation<R>>()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fpr-platform")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "FoundationPlugin")?;
            app.manage(Foundation(handle));
            Ok(())
        })
        .build()
}
