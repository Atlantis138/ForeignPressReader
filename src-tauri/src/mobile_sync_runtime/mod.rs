//! Android foreground LAN synchronization runtime facade.

use crate::{
    mobile_sync::{
        self, PreparedMobileTransfer, SyncApplyResult, SyncBatch, SyncEntityRef, SyncPeerSummary,
    },
    platform_error::PlatformError,
    platform_state::PlatformState,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use axum_server::{tls_rustls::RustlsConfig, Handle};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use fs2::available_space;
use http_body_util::BodyExt;
use rcgen::{generate_simple_self_signed, CertifiedKey};
use reqwest::{Certificate, Client};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    net::{IpAddr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const API_ROOT: &str = "/fprsync/v2";
const SYNC_PORT: u16 = 53_318;
const PROTOCOL: &str = "foreign-press-reader-sync";
const IDENTITY_SLOT: &str = "sync-identity";
const PAIR_LIFETIME_SECONDS: i64 = 120;
const TRANSFER_LIFETIME_SECONDS: i64 = 1_800;
const JSON_LIMIT: usize = 1024 * 1024;
const BATCH_LIMIT: u64 = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const BLOB_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const BLOB_TOTAL_TIMEOUT: Duration = Duration::from_secs(1_800);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerIdentity {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub certificate_sha256: String,
    pub certificate_der_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalIdentity {
    device_id: String,
    certificate_pem: String,
    private_key_pem: String,
    certificate_der_base64: String,
    certificate_sha256: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedPeer {
    #[serde(flatten)]
    identity: PeerIdentity,
    token: String,
    paired_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityEnvelope {
    version: i64,
    identity: LocalIdentity,
    peers: BTreeMap<String, TrustedPeer>,
}

#[derive(Debug, Clone)]
struct DiscoveredPeer {
    identity: PeerIdentity,
    host: String,
    port: u16,
    last_seen_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    device_id: String,
    name: String,
    platform: String,
    trusted: bool,
    online: bool,
    reachability: String,
    diagnostic: Option<DeviceDiagnostic>,
    last_seen_at: String,
    certificate_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDiagnostic {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingState {
    session_id: String,
    direction: String,
    peer: DeviceSummary,
    code: String,
    local_confirmed: bool,
    remote_confirmed: bool,
    status: String,
    message: Option<String>,
    expires_at: String,
}

#[derive(Debug, Clone)]
struct PairingRuntime {
    state: PairingState,
    peer_identity: PeerIdentity,
    endpoint: Option<DiscoveredPeer>,
    local_secret: String,
    remote_secret: Option<String>,
    sender_secret: Option<String>,
    sender_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferPreview {
    total_records: usize,
    new_publications: usize,
    updated_records: usize,
    deleted_publications: usize,
    missing_blobs: usize,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPreview {
    transfer_id: String,
    sender: DeviceSummary,
    total_records: usize,
    new_publications: usize,
    updated_records: usize,
    deleted_publications: usize,
    missing_blobs: usize,
    total_bytes: u64,
    expires_at: String,
}

#[derive(Debug, Clone)]
struct IncomingTransfer {
    id: String,
    sender: PeerIdentity,
    batch: Option<SyncBatch>,
    payload_sha256: String,
    payload_byte_length: u64,
    payload_path: PathBuf,
    record_count: usize,
    blob_count: usize,
    preview: Option<TransferPreview>,
    root: PathBuf,
    blob_paths: HashMap<String, PathBuf>,
    missing_blob_hashes: Vec<String>,
    status: String,
    expires_at: String,
    result: Option<SyncApplyResult>,
}

#[derive(Debug, Clone)]
struct SummarySnapshot {
    peer_device_id: String,
    summary: SyncPeerSummary,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedIncomingState {
    version: i64,
    id: String,
    sender_device_id: String,
    payload_sha256: String,
    payload_byte_length: u64,
    record_count: usize,
    blob_count: usize,
    preview: TransferPreview,
    missing_blob_hashes: Vec<String>,
    completed_blob_hashes: Vec<String>,
    status: String,
    expires_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    operation_id: String,
    direction: String,
    peer: DeviceSummary,
    stage: String,
    message: String,
    completed_bytes: u64,
    total_bytes: u64,
    resumable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableTransferSummary {
    transfer_id: String,
    direction: String,
    peer: DeviceSummary,
    completed_bytes: u64,
    total_bytes: u64,
    updated_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedResult {
    direction: String,
    peer_name: String,
    completed_at: String,
    applied_records: usize,
    unchanged_records: usize,
    imported_publications: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
    active: bool,
    local_device: Option<DeviceSummary>,
    nearby_devices: Vec<DeviceSummary>,
    trusted_devices: Vec<DeviceSummary>,
    pairing: Option<PairingState>,
    incoming: Option<IncomingPreview>,
    operation: Option<OperationState>,
    resumable_transfers: Vec<ResumableTransferSummary>,
    last_completed: Option<CompletedResult>,
    diagnostic: Option<String>,
}

struct RuntimeInner {
    active: bool,
    port: u16,
    identity: Option<IdentityEnvelope>,
    nearby: HashMap<String, DiscoveredPeer>,
    pairing: Option<PairingRuntime>,
    incoming: HashMap<String, IncomingTransfer>,
    summary_snapshots: HashMap<String, SummarySnapshot>,
    operation: Option<OperationState>,
    last_completed: Option<CompletedResult>,
    diagnostic: Option<String>,
    server_handle: Option<Handle>,
    pair_task: Option<tauri::async_runtime::JoinHandle<()>>,
    operation_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct MobileSyncRuntime {
    inner: Mutex<RuntimeInner>,
    lifecycle: tokio::sync::Mutex<()>,
}

impl Default for MobileSyncRuntime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                active: false,
                port: 0,
                identity: None,
                nearby: HashMap::new(),
                pairing: None,
                incoming: HashMap::new(),
                summary_snapshots: HashMap::new(),
                operation: None,
                last_completed: None,
                diagnostic: None,
                server_handle: None,
                pair_task: None,
                operation_task: None,
            }),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

mod client;
mod discovery;
mod errors;
mod identity;
mod lifecycle;
mod persistence;
mod server;
mod view;

pub use lifecycle::{
    accept_incoming, cancel_operation, close_page, confirm_pairing, discard_pending_transfer,
    get_state, incoming_changes, open_page, refresh_discovery_now, reject_incoming, reject_pairing,
    revoke_trust, send_to, start_pairing,
};

#[allow(unused_imports)]
use client::*;
#[allow(unused_imports)]
use discovery::*;
#[allow(unused_imports)]
use errors::*;
#[allow(unused_imports)]
use identity::*;
#[allow(unused_imports)]
use persistence::*;
#[allow(unused_imports)]
use server::*;
#[allow(unused_imports)]
use view::*;

#[cfg(test)]
mod tests;
