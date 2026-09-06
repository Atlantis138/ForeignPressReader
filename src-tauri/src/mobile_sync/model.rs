use super::*;

pub const PREVIOUS_SYNC_MODEL_VERSION: i64 = 2;
pub const SYNC_MODEL_VERSION: i64 = 4;
pub const SYNC_WIRE_VERSION: i64 = 2;
pub const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_NDJSON_LINE_BYTES: usize = 1024 * 1024;
pub const BATCH_MEDIA_TYPE: &str = "application/vnd.foreign-press-reader.sync-batch+ndjson";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncEntityRef {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub key: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalRecord {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub key: String,
    pub revision: i64,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationPackageBlobRef {
    pub kind: String,
    pub publication_id: String,
    pub format_id: String,
    pub content_sha256: String,
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncBatch {
    pub model_version: i64,
    pub batch_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub created_at: String,
    pub mode: String,
    pub from_sender_revision_exclusive: Option<i64>,
    pub sender_revision: i64,
    pub inspected_peer_revision: Option<i64>,
    pub records: Vec<LogicalRecord>,
    pub blobs: Vec<PublicationPackageBlobRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncPeerSummary {
    pub model_version: i64,
    pub device_id: String,
    pub current_revision: i64,
    pub last_applied_sender_revision: i64,
    pub changed_entities_since_revision: i64,
    pub changed_entities: Vec<SyncEntityRef>,
    pub available_blob_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncApplyResult {
    pub batch_id: String,
    pub status: String,
    pub applied_records: usize,
    pub unchanged_records: usize,
    pub imported_blobs: usize,
    pub sender_revision: i64,
    pub local_revision: i64,
}

#[derive(Debug, Clone)]
pub struct PreparedMobileTransfer {
    pub batch: SyncBatch,
    pub payload_sha256: String,
    pub blob_source_paths: HashMap<String, PathBuf>,
    pub root: PathBuf,
    pub payload_path: PathBuf,
    pub payload_byte_length: u64,
    pub updated_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone)]
pub struct ResumableMobileTransferSummary {
    pub peer_device_id: String,
    pub batch_id: String,
    pub payload_byte_length: u64,
    pub total_byte_length: u64,
    pub updated_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingSyncPreviewPlan {
    pub total_records: usize,
    pub new_publications: usize,
    pub updated_records: usize,
    pub deleted_publications: usize,
    pub missing_blob_hashes: Vec<String>,
    pub total_bytes: u64,
}
