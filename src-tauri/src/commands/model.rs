use super::*;

pub(super) struct PlatformSelectedEpub {
    pub(super) cancelled: bool,
    pub(super) display_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictionaryInstallResult {
    pub(super) cancelled: bool,
    pub(super) status: DictionaryPackStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MobileDictionaryInstallProgress {
    pub(super) stage: String,
    pub(super) downloaded_bytes: u64,
    pub(super) total_bytes: u64,
    pub(super) indexed_entries: u64,
    pub(super) message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictionaryOnlineEnhancement {
    pub(super) available: bool,
    pub(super) phase: &'static str,
    pub(super) cache_status: &'static str,
    pub(super) updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDictionaryCenterStatus {
    #[serde(flatten)]
    pub(super) resource: DictionaryResourceStatus,
    pub(super) health: &'static str,
    pub(super) online_enhancement: MobileDictionaryOnlineEnhancement,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLexemeSource {
    pub(super) source: &'static str,
    pub(super) detail: Option<dictionary_query::LexemeDetail>,
    pub(super) snapshot: Option<mobile_vocabulary::MobileLexemeSnapshot>,
    pub(super) local_profile: &'static str,
    pub(super) favorite: bool,
    pub(super) manual_state: String,
}
#[derive(Debug)]
pub(super) struct PlatformStorageInfo {
    pub(super) application_bytes: u64,
    pub(super) secret_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub(super) os: &'static str,
    pub(super) arch: &'static str,
    pub(super) app_version: String,
    pub(super) build_mode: &'static str,
}
