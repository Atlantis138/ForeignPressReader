use super::*;

pub fn create_peer_summary(
    database: &AndroidDatabase,
    sender_device_id: &str,
    changed_since_revision: i64,
) -> Result<SyncPeerSummary, PlatformError> {
    if sender_device_id.is_empty()
        || sender_device_id == database.device_id()
        || changed_since_revision < 0
    {
        return Err(sync_invalid("同步摘要请求无效。"));
    }
    let peer = peer_state(database.connection(), sender_device_id)?;
    let ids = database
        .connection()
        .prepare("SELECT id FROM publications ORDER BY id")
        .map_err(|_| PlatformError::database_corrupt())?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut hashes = ids
        .iter()
        .map(|id| crate::publication_repair::content_hash(database, id))
        .collect::<Result<Vec<_>, _>>()?;
    hashes.sort();
    hashes.dedup();
    Ok(SyncPeerSummary {
        model_version: SYNC_MODEL_VERSION,
        device_id: database.device_id().to_owned(),
        current_revision: current_revision(database.connection())?,
        last_applied_sender_revision: peer
            .map(|value| value.inbound_applied_revision)
            .unwrap_or(0),
        changed_entities_since_revision: changed_since_revision,
        changed_entities: revision_refs(database.connection(), changed_since_revision)?,
        available_blob_hashes: hashes,
    })
}

pub fn duplicate_receipt_result(
    database: &AndroidDatabase,
    sender_device_id: &str,
    batch_id: &str,
    payload_sha256: &str,
) -> Result<Option<SyncApplyResult>, PlatformError> {
    let existing: Option<String> = database
        .connection()
        .query_row(
            "SELECT payload_sha256 FROM sync_receipts WHERE sender_device_id=?1 AND batch_id=?2",
            [sender_device_id, batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    if existing != payload_sha256 {
        return Err(sync_invalid("重复同步批次的内容不一致。"));
    }
    Ok(Some(SyncApplyResult {
        batch_id: batch_id.into(),
        status: "duplicate".into(),
        applied_records: 0,
        unchanged_records: 0,
        imported_blobs: 0,
        sender_revision: 0,
        local_revision: current_revision(database.connection())?,
    }))
}

pub fn peer_inspected_revision(
    database: &AndroidDatabase,
    peer_device_id: &str,
) -> Result<i64, PlatformError> {
    Ok(peer_state(database.connection(), peer_device_id)?
        .map(|value| value.peer_inspected_revision)
        .unwrap_or(0))
}

pub fn preview_incoming_batch(
    database: &AndroidDatabase,
    batch: &SyncBatch,
) -> Result<IncomingSyncPreviewPlan, PlatformError> {
    validate_batch(batch, database.device_id())?;
    let refs = batch.records.iter().map(record_ref).collect::<Vec<_>>();
    let current = export_logical_records(database.connection(), &HashMap::new(), Some(&refs))?
        .into_iter()
        .map(|record| (identity(&record.entity_type, &record.key), record))
        .collect::<HashMap<_, _>>();
    let mut new_publications = 0;
    let mut updated_records = 0;
    let mut deleted_publications = 0;

    for record in &batch.records {
        let existing = current.get(&identity(&record.entity_type, &record.key));
        if existing.is_some_and(|value| value.value == record.value) {
            continue;
        }
        if existing.is_some() && immutable_entity(&record.entity_type) {
            return Err(sync_invalid("同步批次中的不可变学习记录与本机数据冲突。"));
        }

        if record.entity_type == "publication-lifecycle" {
            let current_state = existing
                .and_then(|value| value.value.get("state"))
                .and_then(Value::as_str);
            match record.value.get("state").and_then(Value::as_str) {
                Some("present") if current_state != Some("present") => {
                    new_publications += 1;
                    continue;
                }
                Some("deleted") if current_state == Some("present") => {
                    deleted_publications += 1;
                    continue;
                }
                _ => {}
            }
        }
        updated_records += 1;
    }

    let mut missing_blob_hashes = Vec::new();
    let mut total_bytes = 0_u64;
    for blob in &batch.blobs {
        total_bytes = total_bytes
            .checked_add(blob.byte_length)
            .ok_or_else(|| sync_invalid("同步刊物包总大小无效。"))?;
        missing_blob_hashes.push(blob.sha256.clone());
    }

    Ok(IncomingSyncPreviewPlan {
        total_records: batch.records.len(),
        new_publications,
        updated_records,
        deleted_publications,
        missing_blob_hashes,
        total_bytes,
    })
}

pub fn prepare_transfer(
    database: &AndroidDatabase,
    paths: &PlatformPaths,
    peer_device_id: &str,
    summary: &SyncPeerSummary,
) -> Result<PreparedMobileTransfer, PlatformError> {
    if peer_device_id == database.device_id()
        || summary.device_id != peer_device_id
        || summary.model_version != SYNC_MODEL_VERSION
    {
        return Err(sync_invalid("同步目标设备身份或模型版本不匹配。"));
    }
    if let Some(transfer) = load_resumable_transfer(paths, peer_device_id)? {
        return Ok(transfer);
    }
    let revisions = revision_refs(database.connection(), 0)?;
    let revisions_by_identity = revisions
        .iter()
        .map(|item| (identity(&item.entity_type, &item.key), item.revision))
        .collect::<HashMap<_, _>>();
    let peer = peer_state(database.connection(), peer_device_id)?;
    let current_revision = current_revision(database.connection())?;
    let mut selected = if peer.is_none() {
        revisions.clone()
    } else {
        let mut refs = revisions
            .iter()
            .filter(|item| item.revision > summary.last_applied_sender_revision)
            .cloned()
            .collect::<Vec<_>>();
        refs.extend(summary.changed_entities.iter().cloned());
        refs
    };
    let positions = selected
        .iter()
        .filter(|item| item.entity_type == "publication-lifecycle")
        .map(|item| SyncEntityRef {
            entity_type: "reading-position".into(),
            key: item.key.clone(),
            revision: 0,
        })
        .collect::<Vec<_>>();
    selected.extend(positions);
    let mut records = export_logical_records(
        database.connection(),
        &revisions_by_identity,
        Some(&selected),
    )?;
    let mut selected_identities = selected
        .iter()
        .map(|item| identity(&item.entity_type, &item.key))
        .collect::<HashSet<_>>();
    expand_selected_dependencies(&records, &mut selected_identities);
    records
        .retain(|record| selected_identities.contains(&identity(&record.entity_type, &record.key)));
    records.sort_by(compare_records);

    let batch_id = Uuid::new_v4().to_string();
    let root = paths.persistent_staging.join("sync-outbox").join(&batch_id);
    fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    let available = summary
        .available_blob_hashes
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let mut blobs = Vec::new();
    let mut blob_source_paths = HashMap::new();
    let result = (|| {
        for record in &records {
            if record.entity_type != "publication-lifecycle"
                || record.value.get("state").and_then(Value::as_str) != Some("present")
            {
                continue;
            }
            let content_hash = required_string(&record.value, "contentHash")?;
            if available.contains(&crate::publication_repair::content_hash(
                database,
                required_string(&record.value, "publicationId")?,
            )?) {
                continue;
            }
            let publication_id = required_string(&record.value, "publicationId")?;
            let format_id = required_string(&record.value, "formatId")?;
            let destination = root.join(format!("{content_hash}.fprpub"));
            let created = publication_package::create(
                database,
                &paths.data.join("library"),
                publication_id,
                &destination,
            )?;
            blobs.push(PublicationPackageBlobRef {
                kind: "publication-package".into(),
                publication_id: publication_id.into(),
                format_id: format_id.into(),
                content_sha256: content_hash.into(),
                sha256: created.payload_sha256.clone(),
                byte_length: created.byte_length,
                media_type: "application/vnd.foreign-press-reader.publication+zip".into(),
            });
            blob_source_paths.insert(created.payload_sha256, destination);
        }
        blobs.sort_by(|left, right| {
            left.sha256
                .cmp(&right.sha256)
                .then_with(|| left.publication_id.cmp(&right.publication_id))
                .then_with(|| left.format_id.cmp(&right.format_id))
        });
        let batch = SyncBatch {
            model_version: SYNC_MODEL_VERSION,
            batch_id,
            sender_device_id: database.device_id().to_owned(),
            recipient_device_id: peer_device_id.to_owned(),
            created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            mode: if peer.is_some() {
                "incremental"
            } else {
                "snapshot"
            }
            .into(),
            from_sender_revision_exclusive: peer.map(|_| summary.last_applied_sender_revision),
            sender_revision: current_revision,
            inspected_peer_revision: peer.map(|_| summary.current_revision),
            records,
            blobs,
        };
        validate_batch(&batch, peer_device_id)?;
        let payload_path = root.join("batch.ndjson");
        let (payload_sha256, payload_byte_length) = write_batch_payload(&payload_path, &batch)?;
        let updated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let expires_at = (Utc::now() + chrono::Duration::minutes(30))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let transfer = PreparedMobileTransfer {
            batch,
            payload_sha256,
            blob_source_paths,
            root: root.clone(),
            payload_path,
            payload_byte_length,
            updated_at,
            expires_at,
        };
        write_outgoing_state(&transfer, peer_device_id)?;
        Ok(transfer)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

pub(super) fn expand_selected_dependencies(
    records: &[LogicalRecord],
    selected_identities: &mut HashSet<String>,
) {
    let present_publications = records
        .iter()
        .filter(|record| {
            record.entity_type == "publication-lifecycle"
                && record.value.get("state").and_then(Value::as_str) == Some("present")
                && selected_identities.contains(&identity(&record.entity_type, &record.key))
        })
        .map(|record| record.key.as_str())
        .collect::<HashSet<_>>();
    for record in records {
        if record.entity_type == "reading-position"
            && present_publications.contains(record.key.as_str())
        {
            selected_identities.insert(identity(&record.entity_type, &record.key));
        }
    }
}

pub fn cleanup_prepared(transfer: &PreparedMobileTransfer) {
    let _ = fs::remove_dir_all(&transfer.root);
}

pub fn expanded_blob_bytes(blob_paths: &HashMap<String, PathBuf>) -> Result<u64, PlatformError> {
    let mut total = 0_u64;
    for path in blob_paths.values() {
        let file = File::open(path).map_err(|_| sync_invalid("同步刊物包无法读取。"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|_| sync_invalid("同步刊物包格式无效。"))?;
        if archive.len() > 10_000 {
            return Err(sync_invalid("同步刊物包文件数量异常。"));
        }
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|_| sync_invalid("同步刊物包格式无效。"))?;
            total = total
                .checked_add(entry.size())
                .filter(|value| *value <= MAX_PACKAGE_BYTES.saturating_mul(blob_paths.len() as u64))
                .ok_or_else(|| sync_invalid("同步刊物包展开大小异常。"))?;
        }
    }
    Ok(total)
}

pub fn preview_record_page(
    connection: &Connection,
    records: &[LogicalRecord],
    total: usize,
    offset: usize,
    limit: usize,
) -> Result<Value, PlatformError> {
    let refs = records.iter().map(record_ref).collect::<Vec<_>>();
    let current = export_logical_records(connection, &HashMap::new(), Some(&refs))?
        .into_iter()
        .map(|r| (identity(&r.entity_type, &r.key), r))
        .collect::<HashMap<_, _>>();
    let items = records.iter().map(|r| {
        let existing = current.get(&identity(&r.entity_type, &r.key));
        let action = if existing.is_some_and(|e| e.value == r.value) { "unchanged" } else if r.entity_type == "publication-lifecycle" && r.value["state"] == "deleted" { "delete" } else if existing.is_some() { "update" } else { "new" };
        let label = r.value.get("articleId").and_then(Value::as_str).map(|id| connection.query_row("SELECT title FROM articles WHERE id=?1",[id],|row| row.get::<_,String>(0)).unwrap_or_else(|_| "待恢复的文章".into()).chars().take(160).collect::<String>());
        serde_json::json!({"type":r.entity_type,"key":r.key,"label":label,"action":action,"before":existing.map(describe_sync_value),"after":describe_sync_value(r)})
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({"total":total,"offset":offset,"limit":limit,"items":items}))
}
fn describe_sync_value(record: &LogicalRecord) -> String {
    if record.entity_type == "reader-record" {
        let payload: Value =
            serde_json::from_str(record.value["payload"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        let summary = match record.value["kind"].as_str() {
            Some("bookmark") => if payload == true {
                "已加书签"
            } else {
                "未加书签"
            }
            .to_owned(),
            Some("read") => if payload == true { "已读" } else { "未读" }.to_owned(),
            Some("translation-selection") => if payload.is_null() {
                "查看当前缓存译文"
            } else {
                "查看保留的译文版本"
            }
            .to_owned(),
            Some("translation") => format!(
                "保留译文 · {}：{}",
                payload["model"].as_str().unwrap_or(""),
                payload["text"].as_str().unwrap_or("")
            )
            .chars()
            .take(400)
            .collect(),
            _ => "已保存文章阅读位置".into(),
        };
        return format!(
            "{} · 修改时间：{}",
            summary,
            record.value["updatedAt"].as_str().unwrap_or("")
        );
    }
    let names = [
        ("title", "标题"),
        ("name", "名称"),
        ("lemma", "单词"),
        ("state", "状态"),
        ("kind", "类型"),
        ("payload", "内容"),
        ("value", "设置值"),
        ("sourceText", "原文"),
        ("text", "内容"),
        ("translation", "译文"),
        ("due", "到期"),
        ("updatedAt", "修改时间"),
        ("changedAt", "修改时间"),
        ("articleId", "文章"),
        ("rating", "评分"),
    ];
    let parts = names
        .iter()
        .filter_map(|(key, name)| {
            record.value.get(key).map(|v| {
                format!(
                    "{}：{}",
                    name,
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string())
                        .chars()
                        .take(160)
                        .collect::<String>()
                )
            })
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        format!("记录 {}", record.key.chars().take(100).collect::<String>())
    } else {
        parts.join(" · ").chars().take(500).collect()
    }
}
