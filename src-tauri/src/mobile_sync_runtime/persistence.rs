use super::*;

pub(super) fn remove_mobile_partial_files(root: &std::path::Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_mobile_partial_files(&path);
        } else if path.extension().and_then(|value| value.to_str()) == Some("part") {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn load_incoming_transfers(
    paths: &crate::platform_paths::PlatformPaths,
    identity: &IdentityEnvelope,
    recipient_device_id: &str,
) -> Result<HashMap<String, IncomingTransfer>, PlatformError> {
    let inbox = paths.persistent_staging.join("sync-inbox");
    fs::create_dir_all(&inbox).map_err(|_| PlatformError::storage_unavailable())?;
    let mut result = HashMap::new();
    for entry in fs::read_dir(&inbox).map_err(|_| PlatformError::storage_unavailable())? {
        let entry = entry.map_err(|_| PlatformError::storage_unavailable())?;
        if !entry
            .file_type()
            .map_err(|_| PlatformError::storage_unavailable())?
            .is_dir()
        {
            continue;
        }
        let root = entry.path();
        let loaded = (|| {
            let persisted: PersistedIncomingState = serde_json::from_reader(
                fs::File::open(root.join("state.json"))
                    .map_err(|_| sync_invalid("同步恢复状态不存在。"))?,
            )
            .map_err(|_| sync_invalid("同步恢复状态无效。"))?;
            if persisted.version != 2
                || Uuid::parse_str(&persisted.id).is_err()
                || !valid_sha256(&persisted.payload_sha256)
                || persisted.payload_byte_length == 0
                || persisted.payload_byte_length > BATCH_LIMIT
                || persisted.record_count > 250_000
                || persisted.blob_count > 10_000
                || !matches!(persisted.status.as_str(), "waiting" | "accepted")
                || chrono::DateTime::parse_from_rfc3339(&persisted.expires_at)
                    .map(|expires| expires <= Utc::now())
                    .unwrap_or(true)
            {
                return Err(sync_invalid("同步恢复状态已过期或无效。"));
            }
            let sender = identity
                .peers
                .get(&persisted.sender_device_id)
                .ok_or_else(|| sync_invalid("同步发送设备不再受信任。"))?
                .identity
                .clone();
            let payload_path = root.join("batch.ndjson");
            let metadata =
                fs::metadata(&payload_path).map_err(|_| sync_invalid("同步恢复载荷不存在。"))?;
            if metadata.len() != persisted.payload_byte_length
                || file_sha256_runtime(&payload_path)? != persisted.payload_sha256
            {
                return Err(sync_invalid("同步恢复载荷已变化。"));
            }
            let batch = mobile_sync::read_batch_payload(&payload_path)?;
            mobile_sync::validate_batch(&batch, recipient_device_id)?;
            if batch.batch_id != persisted.id
                || batch.sender_device_id != persisted.sender_device_id
                || batch.records.len() != persisted.record_count
                || batch.blobs.len() != persisted.blob_count
            {
                return Err(sync_invalid("同步恢复批次与状态不一致。"));
            }
            let mut blob_paths = HashMap::new();
            for hash in persisted.completed_blob_hashes {
                let descriptor = batch
                    .blobs
                    .iter()
                    .find(|blob| blob.sha256 == hash)
                    .ok_or_else(|| sync_invalid("同步恢复刊物包未声明。"))?;
                let blob_path = root.join(format!("{hash}.fprpub"));
                let metadata =
                    fs::metadata(&blob_path).map_err(|_| sync_invalid("同步恢复刊物包不存在。"))?;
                if metadata.len() != descriptor.byte_length
                    || file_sha256_runtime(&blob_path)? != hash
                {
                    return Err(sync_invalid("同步恢复刊物包已变化。"));
                }
                blob_paths.insert(hash, blob_path);
            }
            Ok::<_, PlatformError>(IncomingTransfer {
                id: persisted.id,
                sender,
                batch: Some(batch),
                payload_sha256: persisted.payload_sha256,
                payload_byte_length: persisted.payload_byte_length,
                payload_path,
                record_count: persisted.record_count,
                blob_count: persisted.blob_count,
                preview: Some(persisted.preview),
                root: root.clone(),
                blob_paths,
                missing_blob_hashes: persisted.missing_blob_hashes,
                status: persisted.status,
                expires_at: persisted.expires_at,
                result: None,
            })
        })();
        match loaded {
            Ok(transfer) => {
                result.insert(transfer.id.clone(), transfer);
            }
            Err(_) => {
                let _ = fs::remove_dir_all(root);
            }
        }
    }
    Ok(result)
}

pub(super) fn write_mobile_incoming_state(
    transfer: &IncomingTransfer,
) -> Result<(), PlatformError> {
    let Some(preview) = transfer.preview.clone() else {
        return Ok(());
    };
    if transfer.batch.is_none() || !matches!(transfer.status.as_str(), "waiting" | "accepted") {
        return Ok(());
    }
    let state = PersistedIncomingState {
        version: 2,
        id: transfer.id.clone(),
        sender_device_id: transfer.sender.device_id.clone(),
        payload_sha256: transfer.payload_sha256.clone(),
        payload_byte_length: transfer.payload_byte_length,
        record_count: transfer.record_count,
        blob_count: transfer.blob_count,
        preview,
        missing_blob_hashes: transfer.missing_blob_hashes.clone(),
        completed_blob_hashes: transfer.blob_paths.keys().cloned().collect(),
        status: transfer.status.clone(),
        expires_at: transfer.expires_at.clone(),
        updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let temporary = transfer.root.join("state.json.part");
    let destination = transfer.root.join("state.json");
    let _ = fs::remove_file(&temporary);
    serde_json::to_writer(
        fs::File::create(&temporary).map_err(|_| PlatformError::storage_unavailable())?,
        &state,
    )
    .map_err(|_| PlatformError::storage_unavailable())?;
    fs::rename(temporary, destination).map_err(|_| PlatformError::storage_unavailable())
}

pub(super) fn file_sha256_runtime(path: &std::path::Path) -> Result<String, PlatformError> {
    use std::io::Read as _;
    let mut file = fs::File::open(path).map_err(|_| sync_invalid("同步恢复文件无法读取。"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| sync_invalid("同步恢复文件无法读取。"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub(super) fn validate_wire(version: i64) -> Result<(), PlatformError> {
    if version == mobile_sync::SYNC_WIRE_VERSION {
        Ok(())
    } else {
        Err(sync_invalid("局域网同步协议版本不兼容。"))
    }
}

pub(super) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn hex_text(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
