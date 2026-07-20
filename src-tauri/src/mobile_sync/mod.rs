//! Platform-neutral synchronization model and Android persistence facade.

use crate::{
    database::AndroidDatabase,
    mobile_portable::{self, SyncRawRecord},
    mobile_reading,
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
    publication_package,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

mod apply;
mod model;
mod payload;
mod persistence;
mod prepare;
mod projection;

pub use apply::{acknowledge_transfer, apply_transfer};
pub use model::{
    IncomingSyncPreviewPlan, LogicalRecord, PreparedMobileTransfer, PublicationPackageBlobRef,
    ResumableMobileTransferSummary, SyncApplyResult, SyncBatch, SyncEntityRef, SyncPeerSummary,
    BATCH_MEDIA_TYPE, MAX_BATCH_BYTES, MAX_NDJSON_LINE_BYTES, SYNC_MODEL_VERSION,
    SYNC_WIRE_VERSION,
};
pub use payload::{read_batch_payload, write_batch_payload};
pub use persistence::{resumable_transfer_summaries, resumable_transfers};
pub use prepare::{
    cleanup_prepared, create_peer_summary, duplicate_receipt_result, expanded_blob_bytes,
    peer_inspected_revision, prepare_transfer, preview_incoming_batch,
};
pub use projection::{stable_payload_sha256, validate_batch};

const MAX_RECORDS: usize = 250_000;
const MAX_BLOBS: usize = 10_000;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

use payload::{canonical_json, sha256_file, valid_sha256};
#[cfg(test)]
use payload::{BatchHeaderLine, BatchRecordLine};
use persistence::{
    current_revision, load_resumable_transfer, peer_state, revision_refs, write_outgoing_state,
};
use projection::{
    compare_records, export_logical_records, identity, immutable_entity, logical_to_raw,
    record_ref, required_string, sync_invalid, table_entity,
};

#[cfg(test)]
mod tests;
