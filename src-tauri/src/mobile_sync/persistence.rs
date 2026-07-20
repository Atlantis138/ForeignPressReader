use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutgoingTransferState {
    version: i64,
    peer_device_id: String,
    batch_id: String,
    payload_sha256: String,
    payload_byte_length: u64,
    total_byte_length: u64,
    blob_source_paths: HashMap<String, String>,
    updated_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct PeerState {
    pub(super) outbound_acked_revision: i64,
    pub(super) inbound_applied_revision: i64,
    pub(super) peer_inspected_revision: i64,
}

pub fn resumable_transfers(
    paths: &PlatformPaths,
) -> Result<Vec<PreparedMobileTransfer>, PlatformError> {
    let outbox = paths.persistent_staging.join("sync-outbox");
    fs::create_dir_all(&outbox).map_err(|_| PlatformError::storage_unavailable())?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&outbox).map_err(|_| PlatformError::storage_unavailable())? {
        let entry = entry.map_err(|_| PlatformError::storage_unavailable())?;
        if !entry
            .file_type()
            .map_err(|_| PlatformError::storage_unavailable())?
            .is_dir()
        {
            continue;
        }
        match load_outgoing_root(&entry.path()) {
            Ok(Some(transfer)) => result.push(transfer),
            Ok(None) | Err(_) => {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    result.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(result)
}

pub fn resumable_transfer_summaries(
    paths: &PlatformPaths,
) -> Result<Vec<ResumableMobileTransferSummary>, PlatformError> {
    let outbox = paths.persistent_staging.join("sync-outbox");
    fs::create_dir_all(&outbox).map_err(|_| PlatformError::storage_unavailable())?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&outbox).map_err(|_| PlatformError::storage_unavailable())? {
        let entry = entry.map_err(|_| PlatformError::storage_unavailable())?;
        if !entry
            .file_type()
            .map_err(|_| PlatformError::storage_unavailable())?
            .is_dir()
        {
            continue;
        }
        let root = entry.path();
        let state = read_outgoing_state(&root);
        match state {
            Ok(Some(state)) if entry.file_name().to_string_lossy() == state.batch_id => {
                result.push(ResumableMobileTransferSummary {
                    peer_device_id: state.peer_device_id,
                    batch_id: state.batch_id,
                    payload_byte_length: state.payload_byte_length,
                    total_byte_length: state.total_byte_length,
                    updated_at: state.updated_at,
                    expires_at: state.expires_at,
                });
            }
            Ok(Some(_)) | Ok(None) | Err(_) => {
                let _ = fs::remove_dir_all(root);
            }
        }
    }
    result.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(result)
}

pub(super) fn load_resumable_transfer(
    paths: &PlatformPaths,
    peer_device_id: &str,
) -> Result<Option<PreparedMobileTransfer>, PlatformError> {
    Ok(resumable_transfers(paths)?
        .into_iter()
        .find(|transfer| transfer.batch.recipient_device_id == peer_device_id))
}

fn load_outgoing_root(root: &Path) -> Result<Option<PreparedMobileTransfer>, PlatformError> {
    let Some(state) = read_outgoing_state(root)? else {
        return Ok(None);
    };
    let payload_path = root.join("batch.ndjson");
    let metadata = fs::metadata(&payload_path).map_err(|_| sync_invalid("同步恢复载荷不存在。"))?;
    if metadata.len() != state.payload_byte_length
        || sha256_file(&payload_path)? != state.payload_sha256
    {
        return Ok(None);
    }
    let batch = read_batch_payload(&payload_path)?;
    if batch.batch_id != state.batch_id || batch.recipient_device_id != state.peer_device_id {
        return Ok(None);
    }
    let total_byte_length = state
        .payload_byte_length
        .checked_add(batch.blobs.iter().map(|blob| blob.byte_length).sum::<u64>())
        .ok_or_else(|| sync_invalid("同步恢复批次大小无效。"))?;
    if total_byte_length != state.total_byte_length {
        return Ok(None);
    }
    let blob_source_paths = state
        .blob_source_paths
        .into_iter()
        .map(|(hash, value)| (hash, PathBuf::from(value)))
        .collect::<HashMap<_, _>>();
    for (hash, source) in &blob_source_paths {
        let blob = batch
            .blobs
            .iter()
            .find(|blob| &blob.sha256 == hash)
            .ok_or_else(|| sync_invalid("同步恢复刊物包未声明。"))?;
        let metadata = fs::metadata(source).map_err(|_| sync_invalid("同步恢复刊物包不存在。"))?;
        if !metadata.is_file()
            || metadata.len() != blob.byte_length
            || sha256_file(source)? != *hash
        {
            return Ok(None);
        }
    }
    Ok(Some(PreparedMobileTransfer {
        batch,
        payload_sha256: state.payload_sha256,
        blob_source_paths,
        root: root.to_path_buf(),
        payload_path,
        payload_byte_length: state.payload_byte_length,
        updated_at: state.updated_at,
        expires_at: state.expires_at,
    }))
}

pub(super) fn write_outgoing_state(
    transfer: &PreparedMobileTransfer,
    peer_device_id: &str,
) -> Result<(), PlatformError> {
    let total_byte_length = transfer
        .payload_byte_length
        .checked_add(
            transfer
                .batch
                .blobs
                .iter()
                .map(|blob| blob.byte_length)
                .sum::<u64>(),
        )
        .ok_or_else(|| sync_invalid("同步批次大小无效。"))?;
    let state = OutgoingTransferState {
        version: 2,
        peer_device_id: peer_device_id.into(),
        batch_id: transfer.batch.batch_id.clone(),
        payload_sha256: transfer.payload_sha256.clone(),
        payload_byte_length: transfer.payload_byte_length,
        total_byte_length,
        blob_source_paths: transfer
            .blob_source_paths
            .iter()
            .map(|(hash, value)| (hash.clone(), value.to_string_lossy().into_owned()))
            .collect(),
        updated_at: transfer.updated_at.clone(),
        expires_at: transfer.expires_at.clone(),
    };
    let destination = transfer.root.join("state.json");
    let temporary = transfer.root.join("state.json.part");
    let _ = fs::remove_file(&temporary);
    serde_json::to_writer(
        File::create(&temporary).map_err(|_| PlatformError::storage_unavailable())?,
        &state,
    )
    .map_err(|_| PlatformError::storage_unavailable())?;
    fs::rename(temporary, destination).map_err(|_| PlatformError::storage_unavailable())
}

fn read_outgoing_state(root: &Path) -> Result<Option<OutgoingTransferState>, PlatformError> {
    let state: OutgoingTransferState = serde_json::from_reader(
        File::open(root.join("state.json")).map_err(|_| sync_invalid("同步恢复状态不存在。"))?,
    )
    .map_err(|_| sync_invalid("同步恢复状态无效。"))?;
    let maximum_total =
        MAX_BATCH_BYTES.saturating_add(MAX_PACKAGE_BYTES.saturating_mul(MAX_BLOBS as u64));
    if state.version != 2
        || !valid_sha256(&state.payload_sha256)
        || Uuid::parse_str(&state.batch_id).is_err()
        || state.peer_device_id.is_empty()
        || state.payload_byte_length == 0
        || state.payload_byte_length > MAX_BATCH_BYTES
        || state.total_byte_length < state.payload_byte_length
        || state.total_byte_length > maximum_total
        || chrono::DateTime::parse_from_rfc3339(&state.updated_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&state.expires_at)
            .map(|expires| expires <= Utc::now())
            .unwrap_or(true)
    {
        return Ok(None);
    }
    Ok(Some(state))
}

pub(super) fn revision_refs(
    connection: &Connection,
    after: i64,
) -> Result<Vec<SyncEntityRef>, PlatformError> {
    let mut statement = connection
        .prepare(
            "SELECT entity_type,entity_key,revision FROM sync_entity_revisions WHERE revision>?1 ORDER BY revision,entity_type,entity_key",
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([after], |row| {
            let table: String = row.get(0)?;
            Ok((table, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|_| PlatformError::database_corrupt())?;
    rows.map(|row| {
        let (table, key, revision) = row.map_err(|_| PlatformError::database_corrupt())?;
        Ok(SyncEntityRef {
            entity_type: table_entity(&table)?.into(),
            key,
            revision,
        })
    })
    .collect()
}

pub(super) fn peer_state(
    connection: &Connection,
    peer: &str,
) -> Result<Option<PeerState>, PlatformError> {
    connection
        .query_row(
            "SELECT outbound_acked_revision,inbound_applied_revision,peer_inspected_revision FROM sync_peer_state WHERE peer_device_id=?1",
            [peer],
            |row| {
                Ok(PeerState {
                    outbound_acked_revision: row.get(0)?,
                    inbound_applied_revision: row.get(1)?,
                    peer_inspected_revision: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())
}

pub(super) fn current_revision(connection: &Connection) -> Result<i64, PlatformError> {
    connection
        .query_row(
            "SELECT current_revision FROM sync_clock WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| PlatformError::database_corrupt())
}
