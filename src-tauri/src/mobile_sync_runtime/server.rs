use super::*;

pub(super) fn sync_router(app: AppHandle) -> Router {
    Router::new()
        .route(&format!("{API_ROOT}/info"), get(api_info))
        .route(&format!("{API_ROOT}/pair/prepare"), post(api_pair_prepare))
        .route(&format!("{API_ROOT}/pair/confirm"), post(api_pair_confirm))
        .route(&format!("{API_ROOT}/pair/status"), post(api_pair_status))
        .route(&format!("{API_ROOT}/summary"), post(api_summary))
        .route(&format!("{API_ROOT}/prepare"), post(api_prepare))
        .route(
            &format!("{API_ROOT}/transfer/status"),
            post(api_transfer_status),
        )
        .route(
            &format!("{API_ROOT}/transfer/:transfer_id/batch"),
            put(api_batch),
        )
        .route(
            &format!("{API_ROOT}/transfer/:transfer_id/blob/:hash"),
            put(api_blob),
        )
        .route(&format!("{API_ROOT}/commit"), post(api_commit))
        .route(&format!("{API_ROOT}/cancel"), post(api_cancel))
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .with_state(app)
}

pub(super) async fn api_info(State(app): State<AppHandle>) -> ApiResult<Value> {
    let state = app.state::<PlatformState>();
    let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let identity = runtime
        .identity
        .as_ref()
        .ok_or_else(ApiError::unavailable)?;
    let peer = local_peer(identity);
    Ok(Json(json!({
        "protocol": PROTOCOL,
        "wireVersion": mobile_sync::SYNC_WIRE_VERSION,
        "wireVersions": [mobile_sync::SYNC_WIRE_VERSION],
        "modelVersion": mobile_sync::SYNC_MODEL_VERSION,
        "port": SYNC_PORT,
        "deviceId": peer.device_id,
        "name": peer.name,
        "platform": peer.platform,
        "certificateSha256": peer.certificate_sha256,
        "certificateDerBase64": peer.certificate_der_base64,
    })))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PairPrepareRequest {
    pub(super) wire_version: i64,
    pub(super) sender: PeerIdentity,
    pub(super) nonce: String,
    pub(super) sender_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PairPrepareResponse {
    pub(super) wire_version: i64,
    pub(super) session_id: String,
    pub(super) receiver: PeerIdentity,
    pub(super) code: String,
    pub(super) expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PairConfirmRequest {
    pub(super) wire_version: i64,
    pub(super) session_id: String,
    pub(super) sender_confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PairStatusRequest {
    pub(super) wire_version: i64,
    pub(super) session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PairStatusResponse {
    pub(super) wire_version: i64,
    pub(super) session_id: String,
    pub(super) status: String,
    pub(super) receiver_confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) receiver_secret: Option<String>,
}

pub(super) async fn api_pair_prepare(
    State(app): State<AppHandle>,
    Json(request): Json<PairPrepareRequest>,
) -> ApiResult<PairPrepareResponse> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    validate_peer(&request.sender).map_err(ApiError::from)?;
    if request.nonce.len() != 48
        || request.sender_secret.len() != 64
        || !hex_text(&request.nonce)
        || !hex_text(&request.sender_secret)
    {
        return Err(ApiError::bad("配对请求无效。"));
    }
    let state = app.state::<PlatformState>();
    let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let identity = runtime.identity.clone().ok_or_else(ApiError::unavailable)?;
    if identity.peers.contains_key(&request.sender.device_id) {
        return Err(ApiError::conflict("设备已经配对。"));
    }
    if runtime
        .pairing
        .as_ref()
        .map(|pairing| pairing.state.status.as_str())
        == Some("waiting")
    {
        return Err(ApiError::conflict("另一项配对正在进行。"));
    }
    let receiver = local_peer(&identity);
    let code = pairing_code(&request.nonce, &request.sender, &receiver);
    let session_id = Uuid::new_v4().to_string();
    let local_secret = random_hex(32);
    let expires_at = (Utc::now() + chrono::Duration::seconds(PAIR_LIFETIME_SECONDS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    runtime.pairing = Some(PairingRuntime {
        state: PairingState {
            session_id: session_id.clone(),
            direction: "incoming".into(),
            peer: device_summary(&request.sender, false, true, &Utc::now().to_rfc3339()),
            code: code.clone(),
            local_confirmed: false,
            remote_confirmed: false,
            status: "waiting".into(),
            message: Some("请核对两台设备上的六位数字，并分别确认。".into()),
            expires_at: expires_at.clone(),
        },
        peer_identity: request.sender,
        endpoint: None,
        local_secret: local_secret.clone(),
        remote_secret: Some(local_secret),
        sender_secret: Some(request.sender_secret),
        sender_confirmed: false,
    });
    Ok(Json(PairPrepareResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        session_id,
        receiver,
        code,
        expires_at,
    }))
}

pub(super) async fn api_pair_confirm(
    State(app): State<AppHandle>,
    Json(request): Json<PairConfirmRequest>,
) -> ApiResult<Value> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let should_finalize = {
        let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let pairing = runtime
            .pairing
            .as_mut()
            .filter(|pairing| {
                pairing.state.session_id == request.session_id
                    && pairing.state.direction == "incoming"
            })
            .ok_or_else(|| ApiError::not_found("配对请求不存在。"))?;
        if !request.sender_confirmed {
            pairing.state.status = "rejected".into();
            pairing.state.message = Some("另一台设备取消了配对。".into());
            false
        } else {
            pairing.sender_confirmed = true;
            pairing.state.remote_confirmed = true;
            pairing.state.local_confirmed
        }
    };
    if should_finalize {
        finalize_incoming_pair(&app, &state, &request.session_id).map_err(ApiError::from)?;
    }
    Ok(Json(
        json!({ "wireVersion": mobile_sync::SYNC_WIRE_VERSION }),
    ))
}

pub(super) async fn api_pair_status(
    State(app): State<AppHandle>,
    Json(request): Json<PairStatusRequest>,
) -> ApiResult<PairStatusResponse> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let should_finalize = {
        let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let pairing = runtime
            .pairing
            .as_ref()
            .filter(|pairing| {
                pairing.state.session_id == request.session_id
                    && pairing.state.direction == "incoming"
            })
            .ok_or_else(|| ApiError::not_found("配对请求不存在。"))?;
        pairing.sender_confirmed
            && pairing.state.local_confirmed
            && pairing.state.status == "waiting"
    };
    if should_finalize {
        finalize_incoming_pair(&app, &state, &request.session_id).map_err(ApiError::from)?;
    }
    let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let pairing = runtime
        .pairing
        .as_ref()
        .filter(|pairing| pairing.state.session_id == request.session_id)
        .ok_or_else(|| ApiError::not_found("配对请求不存在。"))?;
    Ok(Json(PairStatusResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        session_id: request.session_id,
        status: if matches!(
            pairing.state.status.as_str(),
            "paired" | "rejected" | "expired"
        ) {
            pairing.state.status.clone()
        } else {
            "waiting".into()
        },
        receiver_confirmed: pairing.state.local_confirmed,
        receiver_secret: (pairing.state.status == "paired")
            .then(|| pairing.remote_secret.clone())
            .flatten(),
    }))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SummaryRequest {
    pub(super) wire_version: i64,
    #[serde(default)]
    pub(super) changed_since_revision: Option<i64>,
    #[serde(default)]
    pub(super) snapshot_id: Option<String>,
    #[serde(default)]
    pub(super) cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SummaryResponse {
    pub(super) wire_version: i64,
    pub(super) snapshot_id: String,
    pub(super) device_id: String,
    pub(super) current_revision: i64,
    pub(super) last_applied_sender_revision: i64,
    pub(super) changed_entities_since_revision: i64,
    pub(super) changed_entities: Vec<SyncEntityRef>,
    pub(super) available_blob_hashes: Vec<String>,
    pub(super) next_cursor: Option<String>,
    pub(super) expires_at: String,
}

pub(super) async fn api_summary(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<SummaryRequest>,
) -> ApiResult<SummaryResponse> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let peer = authenticate(&state, &headers)?;
    let (snapshot_id, snapshot) = if let Some(snapshot_id) = request.snapshot_id {
        let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let snapshot = runtime
            .summary_snapshots
            .get(&snapshot_id)
            .filter(|snapshot| snapshot.peer_device_id == peer.identity.device_id)
            .filter(|snapshot| {
                chrono::DateTime::parse_from_rfc3339(&snapshot.expires_at)
                    .map(|expires| expires > Utc::now())
                    .unwrap_or(false)
            })
            .cloned()
            .ok_or_else(|| ApiError::not_found("同步摘要快照已过期。"))?;
        (snapshot_id, snapshot)
    } else {
        let summary = {
            let database = state.database().map_err(ApiError::from)?;
            mobile_sync::create_peer_summary(
                &database,
                &peer.identity.device_id,
                request.changed_since_revision.unwrap_or(0),
            )
            .map_err(ApiError::from)?
        };
        let snapshot_id = Uuid::new_v4().to_string();
        let snapshot = SummarySnapshot {
            peer_device_id: peer.identity.device_id.clone(),
            summary,
            expires_at: (Utc::now() + chrono::Duration::seconds(60))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        state
            .sync_runtime()
            .lock()
            .map_err(ApiError::from)?
            .summary_snapshots
            .insert(snapshot_id.clone(), snapshot.clone());
        (snapshot_id, snapshot)
    };
    let offset = request
        .cursor
        .as_deref()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| ApiError::bad("同步摘要游标无效。"))?;
    let entity_count = snapshot.summary.changed_entities.len();
    let total = entity_count.saturating_add(snapshot.summary.available_blob_hashes.len());
    if offset > total {
        return Err(ApiError::bad("同步摘要游标无效。"));
    }
    let end = total.min(offset.saturating_add(1_000));
    let changed_entities =
        snapshot.summary.changed_entities[offset.min(entity_count)..end.min(entity_count)].to_vec();
    let blob_start = offset.saturating_sub(entity_count);
    let blob_end = end.saturating_sub(entity_count);
    let available_blob_hashes =
        snapshot.summary.available_blob_hashes[blob_start..blob_end].to_vec();
    let next_cursor = (end < total).then(|| end.to_string());
    if next_cursor.is_none() {
        state
            .sync_runtime()
            .lock()
            .map_err(ApiError::from)?
            .summary_snapshots
            .remove(&snapshot_id);
    }
    Ok(Json(SummaryResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        snapshot_id,
        device_id: snapshot.summary.device_id,
        current_revision: snapshot.summary.current_revision,
        last_applied_sender_revision: snapshot.summary.last_applied_sender_revision,
        changed_entities_since_revision: snapshot.summary.changed_entities_since_revision,
        changed_entities,
        available_blob_hashes,
        next_cursor,
        expires_at: snapshot.expires_at,
    }))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrepareRequest {
    pub(super) wire_version: i64,
    pub(super) batch_id: String,
    pub(super) payload_sha256: String,
    pub(super) payload_byte_length: u64,
    pub(super) record_count: usize,
    pub(super) blob_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrepareResponse {
    pub(super) wire_version: i64,
    pub(super) transfer_id: String,
    pub(super) status: String,
    pub(super) preview: TransferPreview,
    pub(super) missing_blob_hashes: Vec<String>,
    pub(super) expires_at: String,
    pub(super) needs_batch: bool,
    pub(super) batch_uploaded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) result: Option<SyncApplyResult>,
}

pub(super) async fn api_prepare(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<PrepareRequest>,
) -> ApiResult<PrepareResponse> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    if Uuid::parse_str(&request.batch_id).is_err()
        || !valid_sha256(&request.payload_sha256)
        || request.payload_byte_length == 0
        || request.payload_byte_length > BATCH_LIMIT
        || request.record_count > 250_000
        || request.blob_count > 10_000
    {
        return Err(ApiError::bad("同步批次准备描述无效。"));
    }
    if let Some(result) = {
        let database = state.database().map_err(ApiError::from)?;
        mobile_sync::duplicate_receipt_result(
            &database,
            &trusted.identity.device_id,
            &request.batch_id,
            &request.payload_sha256,
        )
        .map_err(ApiError::from)?
    } {
        return Ok(Json(PrepareResponse {
            wire_version: mobile_sync::SYNC_WIRE_VERSION,
            transfer_id: request.batch_id,
            status: "committed".into(),
            preview: TransferPreview {
                total_records: request.record_count,
                new_publications: 0,
                updated_records: 0,
                deleted_publications: 0,
                missing_blobs: 0,
                total_bytes: request.payload_byte_length,
            },
            missing_blob_hashes: Vec::new(),
            expires_at: (Utc::now() + chrono::Duration::minutes(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            needs_batch: false,
            batch_uploaded: true,
            result: Some(result),
        }));
    }
    let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    if let Some(existing) = runtime.incoming.get(&request.batch_id) {
        if existing.payload_sha256 != request.payload_sha256
            || existing.payload_byte_length != request.payload_byte_length
        {
            return Err(ApiError::conflict("重复批次内容不一致。"));
        }
        return Ok(Json(prepare_response(existing)));
    }
    if runtime.incoming.values().any(|transfer| {
        matches!(
            transfer.status.as_str(),
            "awaiting-batch" | "waiting" | "accepted" | "applying"
        )
    }) {
        return Err(ApiError::conflict("接收端已有同步请求待处理。"));
    }
    let root = state
        .paths
        .persistent_staging
        .join("sync-inbox")
        .join(&request.batch_id);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).map_err(|_| ApiError::unavailable())?;
    let expires_at = (Utc::now() + chrono::Duration::seconds(TRANSFER_LIFETIME_SECONDS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let transfer = IncomingTransfer {
        id: request.batch_id.clone(),
        sender: trusted.identity,
        batch: None,
        payload_sha256: request.payload_sha256,
        payload_byte_length: request.payload_byte_length,
        payload_path: root.join("batch.ndjson"),
        record_count: request.record_count,
        blob_count: request.blob_count,
        preview: None,
        root,
        blob_paths: HashMap::new(),
        missing_blob_hashes: Vec::new(),
        status: "awaiting-batch".into(),
        expires_at,
        result: None,
    };
    let response = prepare_response(&transfer);
    runtime.incoming.insert(transfer.id.clone(), transfer);
    Ok(Json(response))
}

pub(super) async fn api_batch(
    State(app): State<AppHandle>,
    AxumPath(transfer_id): AxumPath<String>,
    headers: HeaderMap,
    mut body: Body,
) -> ApiResult<PrepareResponse> {
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    let (root, destination, expected, expected_hash, record_count, blob_count) = {
        let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let transfer = runtime
            .incoming
            .get(&transfer_id)
            .filter(|transfer| transfer.sender.device_id == trusted.identity.device_id)
            .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
        if transfer.batch.is_some() {
            return Ok(Json(prepare_response(transfer)));
        }
        if transfer.status != "awaiting-batch" {
            return Err(ApiError::conflict("同步批次当前不可上传。"));
        }
        (
            transfer.root.clone(),
            transfer.payload_path.clone(),
            transfer.payload_byte_length,
            transfer.payload_sha256.clone(),
            transfer.record_count,
            transfer.blob_count,
        )
    };
    let media_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or("");
    if media_type != mobile_sync::BATCH_MEDIA_TYPE {
        return Err(ApiError::bad("同步批次媒体类型无效。"));
    }
    let declared = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ApiError::bad("同步批次大小无效。"))?;
    if declared != expected || declared == 0 || declared > BATCH_LIMIT {
        return Err(ApiError::bad("同步批次声明长度不一致。"));
    }
    if available_space(&root).map_err(|_| ApiError::unavailable())?
        < expected.saturating_add(64 * 1024 * 1024)
    {
        return Err(ApiError::insufficient_storage("同步批次可用空间不足。"));
    }
    let temporary = destination.with_extension("ndjson.part");
    let _ = tokio::fs::remove_file(&temporary).await;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|_| ApiError::unavailable())?;
    let received = tokio::time::timeout(BLOB_TOTAL_TIMEOUT, async {
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        loop {
            let frame = tokio::time::timeout(BLOB_IDLE_TIMEOUT, body.frame())
                .await
                .map_err(|_| ApiError::request_timeout("同步批次传输停滞。"))?;
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|_| ApiError::bad("同步批次传输中断。"))?;
            if let Ok(data) = frame.into_data() {
                bytes = bytes
                    .checked_add(data.len() as u64)
                    .filter(|value| *value <= expected)
                    .ok_or_else(|| ApiError::bad("同步批次超过声明长度。"))?;
                digest.update(&data);
                file.write_all(&data)
                    .await
                    .map_err(|_| ApiError::unavailable())?;
                if let Ok(mut runtime) = state.sync_runtime().lock() {
                    if let Some(operation) = runtime
                        .operation
                        .as_mut()
                        .filter(|operation| operation.operation_id == transfer_id)
                    {
                        operation.stage = "uploading-batch".into();
                        operation.completed_bytes = bytes;
                    }
                }
            }
        }
        file.flush().await.map_err(|_| ApiError::unavailable())?;
        Ok::<_, ApiError>((bytes, hex::encode(digest.finalize())))
    })
    .await;
    let (bytes, actual_hash) = match received {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        Err(_) => {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(ApiError::request_timeout("同步批次传输超过 30 分钟。"));
        }
    };
    drop(file);
    if bytes != expected || actual_hash != expected_hash {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(ApiError::bad("同步批次完整性校验失败。"));
    }
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(|_| ApiError::unavailable())?;
    let parse_path = destination.clone();
    let batch = tokio::task::spawn_blocking(move || mobile_sync::read_batch_payload(&parse_path))
        .await
        .map_err(|_| ApiError::unavailable())?
        .map_err(ApiError::from)?;
    let plan = {
        let database = state.database().map_err(ApiError::from)?;
        mobile_sync::validate_batch(&batch, database.device_id()).map_err(ApiError::from)?;
        if batch.batch_id != transfer_id
            || batch.sender_device_id != trusted.identity.device_id
            || batch.records.len() != record_count
            || batch.blobs.len() != blob_count
        {
            return Err(ApiError::bad("同步批次头与准备描述不一致。"));
        }
        mobile_sync::preview_incoming_batch(&database, &batch).map_err(ApiError::from)?
    };
    if available_space(&root).map_err(|_| ApiError::unavailable())?
        < plan.total_bytes.saturating_add(64 * 1024 * 1024)
    {
        return Err(ApiError::insufficient_storage("接收刊物包的可用空间不足。"));
    }
    let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let transfer = runtime
        .incoming
        .get_mut(&transfer_id)
        .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
    transfer.preview = Some(TransferPreview {
        total_records: plan.total_records,
        new_publications: plan.new_publications,
        updated_records: plan.updated_records,
        deleted_publications: plan.deleted_publications,
        missing_blobs: plan.missing_blob_hashes.len(),
        total_bytes: expected.saturating_add(plan.total_bytes),
    });
    transfer.missing_blob_hashes = plan.missing_blob_hashes;
    transfer.batch = Some(batch);
    transfer.status = "waiting".into();
    write_mobile_incoming_state(transfer).map_err(ApiError::from)?;
    Ok(Json(prepare_response(transfer)))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TransferRequest {
    pub(super) wire_version: i64,
    pub(super) transfer_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TransferStatusResponse {
    pub(super) wire_version: i64,
    pub(super) transfer_id: String,
    pub(super) status: String,
    pub(super) missing_blob_hashes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) result: Option<SyncApplyResult>,
}

pub(super) async fn api_transfer_status(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<TransferRequest>,
) -> ApiResult<TransferStatusResponse> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let transfer = runtime
        .incoming
        .get(&request.transfer_id)
        .filter(|transfer| transfer.sender.device_id == trusted.identity.device_id)
        .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
    Ok(Json(transfer_status(transfer)))
}

pub(super) async fn api_blob(
    State(app): State<AppHandle>,
    AxumPath((transfer_id, hash)): AxumPath<(String, String)>,
    headers: HeaderMap,
    mut body: Body,
) -> ApiResult<Value> {
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    let (root, expected, already_received) = {
        let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let transfer = runtime
            .incoming
            .get(&transfer_id)
            .filter(|transfer| transfer.sender.device_id == trusted.identity.device_id)
            .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
        if transfer.status != "accepted" {
            return Err(ApiError::conflict("接收端尚未接受本次同步。"));
        }
        let batch = transfer
            .batch
            .as_ref()
            .ok_or_else(|| ApiError::conflict("同步批次尚未上传完成。"))?;
        let blob = transfer
            .missing_blob_hashes
            .iter()
            .any(|missing| missing == &hash)
            .then(|| batch.blobs.iter().find(|blob| blob.sha256 == hash))
            .flatten()
            .ok_or_else(|| ApiError::not_found("同步批次未声明该刊物包。"))?;
        (
            transfer.root.clone(),
            blob.byte_length,
            transfer.blob_paths.contains_key(&hash),
        )
    };
    if already_received {
        return Ok(Json(json!({
            "wireVersion": mobile_sync::SYNC_WIRE_VERSION,
            "receivedBytes": expected,
        })));
    }
    let declared = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ApiError::bad("同步刊物包大小无效。"))?;
    if declared != expected || declared == 0 || declared > MAX_PACKAGE_BYTES {
        return Err(ApiError::bad("同步刊物包大小不一致。"));
    }
    let temporary = root.join(format!("{hash}.part"));
    let destination = root.join(format!("{hash}.fprpub"));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|_| ApiError::unavailable())?;
    let received = tokio::time::timeout(BLOB_TOTAL_TIMEOUT, async {
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        loop {
            let frame = tokio::time::timeout(BLOB_IDLE_TIMEOUT, body.frame())
                .await
                .map_err(|_| ApiError::request_timeout("同步刊物包传输停滞。"))?;
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|_| ApiError::bad("同步刊物包传输中断。"))?;
            if let Ok(data) = frame.into_data() {
                bytes = bytes
                    .checked_add(data.len() as u64)
                    .filter(|bytes| *bytes <= expected)
                    .ok_or_else(|| ApiError::bad("同步刊物包超过声明大小。"))?;
                digest.update(&data);
                file.write_all(&data)
                    .await
                    .map_err(|_| ApiError::unavailable())?;
            }
        }
        file.flush().await.map_err(|_| ApiError::unavailable())?;
        Ok::<_, ApiError>((bytes, hex::encode(digest.finalize())))
    })
    .await;
    let (bytes, actual_hash) = match received {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        Err(_) => {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(ApiError::request_timeout("同步刊物包传输超过 30 分钟。"));
        }
    };
    drop(file);
    if bytes != expected || actual_hash != hash {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(ApiError::bad("同步刊物包完整性校验失败。"));
    }
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(|_| ApiError::unavailable())?;
    {
        let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        if let Some(transfer) = runtime.incoming.get_mut(&transfer_id) {
            transfer.blob_paths.insert(hash, destination);
            write_mobile_incoming_state(transfer).map_err(ApiError::from)?;
        }
        if let Some(operation) = runtime.operation.as_mut() {
            if operation.operation_id == transfer_id {
                operation.stage = "uploading".into();
                operation.message = "正在接收刊物内容…".into();
                operation.completed_bytes = operation.completed_bytes.saturating_add(bytes);
            }
        }
    }
    Ok(Json(
        json!({ "wireVersion": mobile_sync::SYNC_WIRE_VERSION, "receivedBytes": bytes }),
    ))
}

pub(super) async fn api_commit(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<TransferRequest>,
) -> ApiResult<Value> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    let transfer = {
        let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let transfer = {
            let transfer = runtime
                .incoming
                .get_mut(&request.transfer_id)
                .filter(|transfer| transfer.sender.device_id == trusted.identity.device_id)
                .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
            if transfer.status == "committed" {
                return Ok(Json(json!({
                    "wireVersion": mobile_sync::SYNC_WIRE_VERSION,
                    "result": transfer.result,
                })));
            }
            if transfer.status != "accepted" {
                return Err(ApiError::conflict("同步批次未被接受或正在应用。"));
            }
            if transfer.batch.is_none() {
                return Err(ApiError::conflict("同步批次尚未上传完成。"));
            }
            for hash in &transfer.missing_blob_hashes {
                if !transfer.blob_paths.contains_key(hash) {
                    return Err(ApiError::conflict("同步批次仍缺少刊物包。"));
                }
            }
            transfer.status = "applying".into();
            transfer.clone()
        };
        if let Some(operation) = runtime.operation.as_mut() {
            operation.stage = "applying".into();
            operation.message = "正在校验并原子应用同步数据…".into();
        }
        transfer
    };
    let expanded_bytes =
        mobile_sync::expanded_blob_bytes(&transfer.blob_paths).map_err(ApiError::from)?;
    if available_space(&state.paths.data).map_err(|_| ApiError::unavailable())?
        < expanded_bytes.saturating_add(64 * 1024 * 1024)
    {
        if let Ok(mut runtime) = state.sync_runtime().lock() {
            if let Some(item) = runtime.incoming.get_mut(&request.transfer_id) {
                item.status = "accepted".into();
            }
        }
        return Err(ApiError::insufficient_storage(
            "刊物包展开后的可用空间不足。",
        ));
    }
    let apply_result = match state.database() {
        Ok(mut database) => mobile_sync::apply_transfer(
            &mut database,
            &state.paths,
            transfer
                .batch
                .as_ref()
                .ok_or_else(|| sync_invalid("同步批次尚未上传完成。"))?,
            &transfer.payload_sha256,
            &transfer.payload_path,
            &transfer.blob_paths,
        ),
        Err(error) => Err(error),
    };
    let result = match apply_result {
        Ok(result) => result,
        Err(error) => {
            let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
            if let Some(item) = runtime.incoming.get_mut(&request.transfer_id) {
                if item.status == "applying" {
                    item.status = "accepted".into();
                }
            }
            if let Some(operation) = runtime.operation.as_mut() {
                operation.stage = "error".into();
                operation.message = error.message.into();
            }
            return Err(ApiError::from(error));
        }
    };
    {
        let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        if let Some(item) = runtime.incoming.get_mut(&request.transfer_id) {
            item.status = "committed".into();
            item.result = Some(result.clone());
        }
        complete_operation(&mut runtime, &transfer.sender, "receiving", &result);
    }
    let _ = fs::remove_dir_all(transfer.root);
    Ok(Json(
        json!({ "wireVersion": mobile_sync::SYNC_WIRE_VERSION, "result": result }),
    ))
}

pub(super) async fn api_cancel(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<TransferRequest>,
) -> ApiResult<Value> {
    validate_wire(request.wire_version).map_err(ApiError::from)?;
    let state = app.state::<PlatformState>();
    let trusted = authenticate(&state, &headers)?;
    let root = {
        let mut runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
        let transfer = runtime
            .incoming
            .get(&request.transfer_id)
            .filter(|transfer| transfer.sender.device_id == trusted.identity.device_id)
            .ok_or_else(|| ApiError::not_found("同步传输不存在。"))?;
        if transfer.status == "applying" {
            return Err(ApiError::conflict("同步数据正在原子应用，当前不能取消。"));
        }
        let root = transfer.root.clone();
        runtime.incoming.remove(&request.transfer_id);
        root
    };
    let _ = fs::remove_dir_all(root);
    Ok(Json(
        json!({ "wireVersion": mobile_sync::SYNC_WIRE_VERSION }),
    ))
}
