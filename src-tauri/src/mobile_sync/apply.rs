use super::*;

pub fn apply_transfer(
    database: &mut AndroidDatabase,
    paths: &PlatformPaths,
    batch: &SyncBatch,
    payload_sha256: &str,
    payload_path: &Path,
    blob_paths: &HashMap<String, PathBuf>,
) -> Result<SyncApplyResult, PlatformError> {
    validate_batch(batch, database.device_id())?;
    if sha256_file(payload_path)? != payload_sha256 {
        return Err(sync_invalid("同步批次内容校验失败。"));
    }
    let existing: Option<String> = database
        .connection()
        .query_row(
            "SELECT payload_sha256 FROM sync_receipts WHERE sender_device_id=?1 AND batch_id=?2",
            [&batch.sender_device_id, &batch.batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    if let Some(existing) = existing {
        if existing != payload_sha256 {
            return Err(sync_invalid("重复同步批次的内容不一致。"));
        }
        return Ok(SyncApplyResult {
            batch_id: batch.batch_id.clone(),
            status: "duplicate".into(),
            applied_records: 0,
            unchanged_records: batch.records.len(),
            imported_blobs: 0,
            sender_revision: batch.sender_revision,
            local_revision: current_revision(database.connection())?,
        });
    }

    let restore_root = paths
        .temporary_staging
        .join("sync-restore")
        .join(&batch.batch_id);
    let mut imported_publications = Vec::new();
    let result = (|| {
        for blob in &batch.blobs {
            let source = blob_paths
                .get(&blob.sha256)
                .ok_or_else(|| sync_invalid("同步批次缺少刊物内容包。"))?;
            let metadata =
                fs::metadata(source).map_err(|_| sync_invalid("同步刊物内容包不存在。"))?;
            if !metadata.is_file()
                || metadata.len() != blob.byte_length
                || sha256_file(source)? != blob.sha256
            {
                return Err(sync_invalid("同步刊物内容包完整性校验失败。"));
            }
            let extract_root = restore_root.join(&blob.sha256);
            let inspected = publication_package::inspect_and_extract(source, &extract_root)?;
            if inspected.plan.id != blob.publication_id
                || inspected.plan.hash != blob.content_sha256
                || inspected.manifest.source_format != blob.format_id
            {
                return Err(sync_invalid("同步刊物内容包身份不一致。"));
            }
            let imported =
                publication_package::restore(database, &paths.data.join("library"), &inspected)?;
            let _ = fs::remove_dir_all(&extract_root);
            if !imported.duplicate {
                imported_publications.push(imported.publication.summary.id.clone());
                mobile_reading::clear_publication_lifecycle_for_restore(
                    database,
                    &imported.publication.summary.id,
                )?;
            }
        }
        let raw = batch
            .records
            .iter()
            .map(|record| logical_to_raw(database.connection(), record))
            .collect::<Result<Vec<_>, _>>()?;
        let merged = mobile_portable::sync_apply_incoming_records(
            database,
            &raw,
            &batch.sender_device_id,
            &batch.batch_id,
            payload_sha256,
            batch.sender_revision,
            batch.model_version,
        )?;
        for record in &batch.records {
            if record.entity_type == "publication-lifecycle"
                && record.value.get("state").and_then(Value::as_str) == Some("deleted")
            {
                if let Some(id) = record.value.get("publicationId").and_then(Value::as_str) {
                    let _ = fs::remove_dir_all(paths.data.join("library").join(id));
                }
            }
        }
        Ok(SyncApplyResult {
            batch_id: batch.batch_id.clone(),
            status: if merged.duplicate {
                "duplicate"
            } else {
                "applied"
            }
            .into(),
            applied_records: merged.applied_records,
            unchanged_records: merged.unchanged_records,
            imported_blobs: imported_publications.len(),
            sender_revision: batch.sender_revision,
            local_revision: merged.local_revision,
        })
    })();
    if result.is_err() {
        for id in imported_publications {
            let _ = mobile_reading::purge_imported_publication(
                database,
                &paths.data.join("library"),
                &id,
            );
        }
    }
    let _ = fs::remove_dir_all(restore_root);
    result
}

pub fn acknowledge_transfer(
    database: &AndroidDatabase,
    peer_device_id: &str,
    sender_revision: i64,
    peer_revision: i64,
) -> Result<(), PlatformError> {
    if sender_revision < 0 || peer_revision < 0 {
        return Err(sync_invalid("同步确认 revision 无效。"));
    }
    let current = peer_state(database.connection(), peer_device_id)?.unwrap_or_default();
    database
        .connection()
        .execute(
            "INSERT INTO sync_peer_state(peer_device_id,outbound_acked_revision,inbound_applied_revision,peer_inspected_revision,last_sync_at) VALUES(?1,?2,?3,?4,?5) \
             ON CONFLICT(peer_device_id) DO UPDATE SET outbound_acked_revision=excluded.outbound_acked_revision,inbound_applied_revision=excluded.inbound_applied_revision,peer_inspected_revision=excluded.peer_inspected_revision,last_sync_at=excluded.last_sync_at",
            params![
                peer_device_id,
                current.outbound_acked_revision.max(sender_revision),
                current.inbound_applied_revision,
                current.peer_inspected_revision.max(peer_revision),
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}
