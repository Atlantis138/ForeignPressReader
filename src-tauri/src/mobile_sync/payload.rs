use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BatchHeaderLine {
    pub(super) kind: String,
    pub(super) stream_version: i64,
    pub(super) model_version: i64,
    pub(super) batch_id: String,
    pub(super) sender_device_id: String,
    pub(super) recipient_device_id: String,
    pub(super) created_at: String,
    pub(super) mode: String,
    pub(super) from_sender_revision_exclusive: Option<i64>,
    pub(super) sender_revision: i64,
    pub(super) inspected_peer_revision: Option<i64>,
    pub(super) record_count: usize,
    pub(super) blob_count: usize,
}

#[derive(Serialize)]
pub(super) struct BatchRecordLine<'a> {
    pub(super) kind: &'static str,
    pub(super) record: &'a LogicalRecord,
}

#[derive(Serialize)]
struct BatchBlobLine<'a> {
    kind: &'static str,
    blob: &'a PublicationPackageBlobRef,
}

pub fn write_batch_payload(path: &Path, batch: &SyncBatch) -> Result<(String, u64), PlatformError> {
    let temporary = path.with_extension("ndjson.part");
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut writer = BufWriter::new(file);
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let header = BatchHeaderLine {
        kind: "header".into(),
        stream_version: 1,
        model_version: batch.model_version,
        batch_id: batch.batch_id.clone(),
        sender_device_id: batch.sender_device_id.clone(),
        recipient_device_id: batch.recipient_device_id.clone(),
        created_at: batch.created_at.clone(),
        mode: batch.mode.clone(),
        from_sender_revision_exclusive: batch.from_sender_revision_exclusive,
        sender_revision: batch.sender_revision,
        inspected_peer_revision: batch.inspected_peer_revision,
        record_count: batch.records.len(),
        blob_count: batch.blobs.len(),
    };
    let result = (|| {
        write_ndjson_line(&mut writer, &mut digest, &mut total, &header)?;
        for record in &batch.records {
            write_ndjson_line(
                &mut writer,
                &mut digest,
                &mut total,
                &BatchRecordLine {
                    kind: "record",
                    record,
                },
            )?;
        }
        for blob in &batch.blobs {
            write_ndjson_line(
                &mut writer,
                &mut digest,
                &mut total,
                &BatchBlobLine { kind: "blob", blob },
            )?;
        }
        writer
            .flush()
            .map_err(|_| PlatformError::storage_unavailable())?;
        drop(writer);
        fs::rename(&temporary, path).map_err(|_| PlatformError::storage_unavailable())?;
        Ok((hex::encode(digest.finalize()), total))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_ndjson_line<T: Serialize>(
    writer: &mut BufWriter<File>,
    digest: &mut Sha256,
    total: &mut u64,
    value: &T,
) -> Result<(), PlatformError> {
    let mut line = serde_json::to_vec(value).map_err(|_| sync_invalid("同步批次行无法序列化。"))?;
    line.push(b'\n');
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return Err(sync_invalid("同步批次单行超过 1 MiB 限制。"));
    }
    *total = total
        .checked_add(line.len() as u64)
        .filter(|value| *value <= MAX_BATCH_BYTES)
        .ok_or_else(|| sync_invalid("同步批次元数据超过 512 MiB 限制。"))?;
    digest.update(&line);
    writer
        .write_all(&line)
        .map_err(|_| PlatformError::storage_unavailable())
}

pub fn read_batch_payload(path: &Path) -> Result<SyncBatch, PlatformError> {
    let metadata = fs::metadata(path).map_err(|_| sync_invalid("同步批次文件不存在。"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BATCH_BYTES {
        return Err(sync_invalid("同步批次文件大小无效。"));
    }
    let reader = BufReader::new(File::open(path).map_err(|_| sync_invalid("同步批次无法读取。"))?);
    let mut lines = reader.split(b'\n');
    let first = lines
        .next()
        .ok_or_else(|| sync_invalid("同步批次缺少批次头。"))?
        .map_err(|_| sync_invalid("同步批次无法读取。"))?;
    if first.is_empty() || first.len() > MAX_NDJSON_LINE_BYTES {
        return Err(sync_invalid("同步批次头无效。"));
    }
    let header: BatchHeaderLine =
        serde_json::from_slice(&first).map_err(|_| sync_invalid("同步批次头无效。"))?;
    if header.kind != "header"
        || header.stream_version != 1
        || header.model_version != SYNC_MODEL_VERSION
        || header.record_count > MAX_RECORDS
        || header.blob_count > MAX_BLOBS
    {
        return Err(sync_invalid("同步批次头无效。"));
    }
    let mut records = Vec::with_capacity(header.record_count.min(16_384));
    let mut blobs = Vec::with_capacity(header.blob_count.min(1_024));
    let mut blob_section = false;
    for encoded in lines {
        let encoded = encoded.map_err(|_| sync_invalid("同步批次无法读取。"))?;
        if encoded.is_empty() {
            return Err(sync_invalid("同步批次包含空行。"));
        }
        if encoded.len() > MAX_NDJSON_LINE_BYTES {
            return Err(sync_invalid("同步批次单行超过 1 MiB 限制。"));
        }
        let mut value: Value =
            serde_json::from_slice(&encoded).map_err(|_| sync_invalid("同步批次行 JSON 无效。"))?;
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let payload = value
            .as_object_mut()
            .and_then(|object| {
                object.remove(if kind == "record" {
                    "record"
                } else if kind == "blob" {
                    "blob"
                } else {
                    ""
                })
            })
            .ok_or_else(|| sync_invalid("同步批次行类型无效。"))?;
        if kind == "record" {
            if blob_section || records.len() >= header.record_count {
                return Err(sync_invalid("同步批次记录顺序或数量无效。"));
            }
            records.push(
                serde_json::from_value(payload).map_err(|_| sync_invalid("同步批次记录无效。"))?,
            );
        } else {
            blob_section = true;
            if blobs.len() >= header.blob_count {
                return Err(sync_invalid("同步批次 Blob 数量无效。"));
            }
            blobs.push(
                serde_json::from_value(payload)
                    .map_err(|_| sync_invalid("同步批次 Blob 无效。"))?,
            );
        }
    }
    if records.len() != header.record_count || blobs.len() != header.blob_count {
        return Err(sync_invalid("同步批次内容不完整。"));
    }
    Ok(SyncBatch {
        model_version: header.model_version,
        batch_id: header.batch_id,
        sender_device_id: header.sender_device_id,
        recipient_device_id: header.recipient_device_id,
        created_at: header.created_at,
        mode: header.mode,
        from_sender_revision_exclusive: header.from_sender_revision_exclusive,
        sender_revision: header.sender_revision,
        inspected_peer_revision: header.inspected_peer_revision,
        records,
        blobs,
    })
}

pub(super) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let sorted = values.iter().collect::<BTreeMap<_, _>>();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub(super) fn sha256_file(path: &Path) -> Result<String, PlatformError> {
    let mut file = File::open(path).map_err(|_| sync_invalid("无法读取同步刊物内容包。"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| sync_invalid("无法读取同步刊物内容包。"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub(super) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
