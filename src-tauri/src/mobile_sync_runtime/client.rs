use super::*;

pub(super) async fn finish_outgoing_pair(app: &AppHandle, session_id: &str) {
    let result = async {
        let state = app.state::<PlatformState>();
        let pairing = {
            let runtime = state.sync_runtime().lock()?;
            runtime
                .pairing
                .as_ref()
                .filter(|pairing| pairing.state.session_id == session_id)
                .cloned()
                .ok_or_else(|| sync_invalid("配对请求不存在。"))?
        };
        let endpoint = pairing.endpoint.clone().ok_or_else(sync_unavailable)?;
        let _: Value = post_json(
            &endpoint,
            "/pair/confirm",
            &PairConfirmRequest {
                wire_version: mobile_sync::SYNC_WIRE_VERSION,
                session_id: session_id.into(),
                sender_confirmed: true,
            },
            None,
        )
        .await?;
        loop {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let response: PairStatusResponse = post_json(
                &endpoint,
                "/pair/status",
                &PairStatusRequest {
                    wire_version: mobile_sync::SYNC_WIRE_VERSION,
                    session_id: session_id.into(),
                },
                None,
            )
            .await?;
            {
                let mut runtime = state.sync_runtime().lock()?;
                if let Some(current) = runtime
                    .pairing
                    .as_mut()
                    .filter(|current| current.state.session_id == session_id)
                {
                    current.state.remote_confirmed = response.receiver_confirmed;
                }
            }
            if response.status == "waiting" {
                continue;
            }
            if response.status != "paired" {
                let mut runtime = state.sync_runtime().lock()?;
                if let Some(current) = runtime.pairing.as_mut() {
                    current.state.status = response.status;
                    current.state.message = Some("另一台设备拒绝配对或请求已过期。".into());
                }
                return Ok::<(), PlatformError>(());
            }
            let remote_secret = response
                .receiver_secret
                .ok_or_else(|| sync_invalid("配对密钥交换不完整。"))?;
            let local_id = app
                .state::<PlatformState>()
                .database()?
                .device_id()
                .to_owned();
            let token = derive_token(
                &local_id,
                &pairing.local_secret,
                &pairing.peer_identity.device_id,
                &remote_secret,
            );
            trust_peer(app, &state, pairing.peer_identity.clone(), token)?;
            let mut runtime = state.sync_runtime().lock()?;
            if let Some(current) = runtime.pairing.as_mut() {
                current.state.status = "paired".into();
                current.state.remote_confirmed = true;
                current.state.peer.trusted = true;
                current.state.message = Some("设备已配对，可以开始增量同步。".into());
            }
            return Ok(());
        }
    }
    .await;
    if let Err(error) = result {
        if let Some(state) = app.try_state::<PlatformState>() {
            if let Ok(mut runtime) = state.sync_runtime().lock() {
                if let Some(pairing) = runtime.pairing.as_mut() {
                    pairing.state.status = "error".into();
                    pairing.state.message = Some(error.to_string());
                }
            }
        }
    }
}

pub(super) async fn run_send(
    app: &AppHandle,
    endpoint: DiscoveredPeer,
    trusted: TrustedPeer,
) -> Result<(), PlatformError> {
    let state = app.state::<PlatformState>();
    let (local_device_id, changed_since) = {
        let database = state.database()?;
        (
            database.device_id().to_owned(),
            mobile_sync::peer_inspected_revision(&database, &endpoint.identity.device_id)?,
        )
    };
    let mut page: SummaryResponse = post_json(
        &endpoint,
        "/summary",
        &SummaryRequest {
            wire_version: mobile_sync::SYNC_WIRE_VERSION,
            changed_since_revision: Some(changed_since),
            snapshot_id: None,
            cursor: None,
        },
        Some((&trusted, &local_device_id)),
    )
    .await?;
    let mut changed_entities = page.changed_entities.clone();
    let mut available_blob_hashes = page.available_blob_hashes.clone();
    while let Some(cursor) = page.next_cursor.clone() {
        page = post_json(
            &endpoint,
            "/summary",
            &SummaryRequest {
                wire_version: mobile_sync::SYNC_WIRE_VERSION,
                changed_since_revision: None,
                snapshot_id: Some(page.snapshot_id.clone()),
                cursor: Some(cursor),
            },
            Some((&trusted, &local_device_id)),
        )
        .await?;
        changed_entities.extend(page.changed_entities.clone());
        available_blob_hashes.extend(page.available_blob_hashes.clone());
    }
    let summary = SyncPeerSummary {
        model_version: mobile_sync::SYNC_MODEL_VERSION,
        device_id: page.device_id.clone(),
        current_revision: page.current_revision,
        last_applied_sender_revision: page.last_applied_sender_revision,
        changed_entities_since_revision: page.changed_entities_since_revision,
        changed_entities,
        available_blob_hashes,
    };
    {
        let mut runtime = state.sync_runtime().lock()?;
        update_operation(&mut runtime, "preparing", "正在生成增量批次与缺失刊物包…");
    }
    let prepared = {
        let database = state.database()?;
        mobile_sync::prepare_transfer(
            &database,
            &state.paths,
            &endpoint.identity.device_id,
            &summary,
        )?
    };
    {
        let mut runtime = state.sync_runtime().lock()?;
        if let Some(operation) = runtime.operation.as_mut() {
            operation.operation_id = prepared.batch.batch_id.clone();
            operation.resumable = true;
            operation.total_bytes = prepared.payload_byte_length.saturating_add(
                prepared
                    .batch
                    .blobs
                    .iter()
                    .map(|blob| blob.byte_length)
                    .sum::<u64>(),
            );
        }
    }
    let outcome = run_prepared_send(
        app,
        &endpoint,
        &trusted,
        &local_device_id,
        &prepared,
        &summary,
    )
    .await;
    if outcome
        .as_ref()
        .map(|_| true)
        .unwrap_or_else(|error| matches!(error.code, "syncRejected" | "syncUnauthorized"))
    {
        mobile_sync::cleanup_prepared(&prepared);
    }
    outcome
}

pub(super) async fn run_prepared_send(
    app: &AppHandle,
    endpoint: &DiscoveredPeer,
    trusted: &TrustedPeer,
    local_device_id: &str,
    prepared: &PreparedMobileTransfer,
    summary: &SyncPeerSummary,
) -> Result<(), PlatformError> {
    let state = app.state::<PlatformState>();
    if prepared.batch.records.is_empty() && prepared.batch.blobs.is_empty() {
        {
            let database = state.database()?;
            mobile_sync::acknowledge_transfer(
                &database,
                &endpoint.identity.device_id,
                prepared.batch.sender_revision,
                summary.current_revision,
            )?;
        }
        let mut runtime = state.sync_runtime().lock()?;
        complete_operation(
            &mut runtime,
            &endpoint.identity,
            "sending",
            &SyncApplyResult {
                batch_id: prepared.batch.batch_id.clone(),
                status: "applied".into(),
                applied_records: 0,
                unchanged_records: 0,
                imported_blobs: 0,
                sender_revision: prepared.batch.sender_revision,
                local_revision: summary.current_revision,
            },
        );
        return Ok(());
    }
    let mut response: PrepareResponse = post_json(
        endpoint,
        "/prepare",
        &PrepareRequest {
            wire_version: mobile_sync::SYNC_WIRE_VERSION,
            batch_id: prepared.batch.batch_id.clone(),
            payload_sha256: prepared.payload_sha256.clone(),
            payload_byte_length: prepared.payload_byte_length,
            record_count: prepared.batch.records.len(),
            blob_count: prepared.batch.blobs.len(),
        },
        Some((trusted, local_device_id)),
    )
    .await?;
    if response.needs_batch {
        {
            let mut runtime = state.sync_runtime().lock()?;
            update_operation(&mut runtime, "uploading-batch", "正在发送流式同步批次…");
            if let Some(operation) = runtime.operation.as_mut() {
                operation.operation_id = prepared.batch.batch_id.clone();
                operation.resumable = true;
            }
        }
        upload_file(
            endpoint,
            &format!("/transfer/{}/batch", response.transfer_id),
            &prepared.payload_path,
            prepared.payload_byte_length,
            trusted,
            local_device_id,
            mobile_sync::BATCH_MEDIA_TYPE,
        )
        .await?;
        response = post_json(
            endpoint,
            "/prepare",
            &PrepareRequest {
                wire_version: mobile_sync::SYNC_WIRE_VERSION,
                batch_id: prepared.batch.batch_id.clone(),
                payload_sha256: prepared.payload_sha256.clone(),
                payload_byte_length: prepared.payload_byte_length,
                record_count: prepared.batch.records.len(),
                blob_count: prepared.batch.blobs.len(),
            },
            Some((trusted, local_device_id)),
        )
        .await?;
    }
    if response.status == "committed" {
        let result = response
            .result
            .ok_or_else(|| sync_invalid("同步提交回执无效。"))?;
        let database = state.database()?;
        mobile_sync::acknowledge_transfer(
            &database,
            &endpoint.identity.device_id,
            prepared.batch.sender_revision,
            result.local_revision,
        )?;
        drop(database);
        let mut runtime = state.sync_runtime().lock()?;
        complete_operation(&mut runtime, &endpoint.identity, "sending", &result);
        return Ok(());
    }
    {
        let mut runtime = state.sync_runtime().lock()?;
        if let Some(operation) = runtime.operation.as_mut() {
            operation.stage = "waiting-confirmation".into();
            operation.message = "已发送差异预览，等待接收端确认…".into();
            operation.total_bytes = response.preview.total_bytes;
            operation.completed_bytes = prepared.payload_byte_length;
            operation.resumable = true;
        }
    }
    let mut status = TransferStatusResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        transfer_id: response.transfer_id.clone(),
        status: response.status,
        missing_blob_hashes: response.missing_blob_hashes,
        result: None,
    };
    while status.status == "waiting" {
        tokio::time::sleep(Duration::from_millis(700)).await;
        status = post_json(
            endpoint,
            "/transfer/status",
            &TransferRequest {
                wire_version: mobile_sync::SYNC_WIRE_VERSION,
                transfer_id: response.transfer_id.clone(),
            },
            Some((trusted, local_device_id)),
        )
        .await?;
    }
    if status.status != "accepted" {
        return Err(sync_busy(if status.status == "rejected" {
            "接收端拒绝了本次同步。"
        } else {
            "本次同步已取消或过期。"
        }));
    }
    {
        let mut runtime = state.sync_runtime().lock()?;
        update_operation(&mut runtime, "uploading", "正在发送接收端缺失的刊物内容…");
    }
    for hash in &status.missing_blob_hashes {
        let path = prepared
            .blob_source_paths
            .get(hash)
            .ok_or_else(|| sync_invalid("发送批次缺少刊物包。"))?;
        let size = prepared
            .batch
            .blobs
            .iter()
            .find(|blob| &blob.sha256 == hash)
            .map(|blob| blob.byte_length)
            .ok_or_else(|| sync_invalid("发送批次刊物包描述无效。"))?;
        upload_file(
            endpoint,
            &format!("/transfer/{}/blob/{hash}", response.transfer_id),
            path,
            size,
            trusted,
            local_device_id,
            "application/vnd.foreign-press-reader.publication+zip",
        )
        .await?;
        if let Ok(mut runtime) = state.sync_runtime().lock() {
            if let Some(operation) = runtime.operation.as_mut() {
                operation.completed_bytes = operation.completed_bytes.saturating_add(size);
            }
        }
    }
    {
        let mut runtime = state.sync_runtime().lock()?;
        update_operation(
            &mut runtime,
            "applying",
            "刊物内容已发送，等待接收端原子应用…",
        );
    }
    let committed: CommitResponse = post_json_with_timeout(
        endpoint,
        "/commit",
        &TransferRequest {
            wire_version: mobile_sync::SYNC_WIRE_VERSION,
            transfer_id: response.transfer_id,
        },
        Some((trusted, local_device_id)),
        BLOB_TOTAL_TIMEOUT,
    )
    .await?;
    {
        let database = state.database()?;
        mobile_sync::acknowledge_transfer(
            &database,
            &endpoint.identity.device_id,
            prepared.batch.sender_revision,
            committed.result.local_revision,
        )?;
    }
    let mut runtime = state.sync_runtime().lock()?;
    complete_operation(
        &mut runtime,
        &endpoint.identity,
        "sending",
        &committed.result,
    );
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitResponse {
    wire_version: i64,
    result: SyncApplyResult,
}

pub(super) fn finalize_incoming_pair(
    app: &AppHandle,
    state: &PlatformState,
    session_id: &str,
) -> Result<(), PlatformError> {
    let pairing = {
        let runtime = state.sync_runtime().lock()?;
        runtime
            .pairing
            .as_ref()
            .filter(|pairing| pairing.state.session_id == session_id)
            .cloned()
            .ok_or_else(|| sync_invalid("配对请求不存在。"))?
    };
    let sender_secret = pairing
        .sender_secret
        .as_deref()
        .ok_or_else(|| sync_invalid("配对密钥交换不完整。"))?;
    let receiver_secret = pairing
        .remote_secret
        .as_deref()
        .ok_or_else(|| sync_invalid("配对密钥交换不完整。"))?;
    let local_id = state.database()?.device_id().to_owned();
    let token = derive_token(
        &pairing.peer_identity.device_id,
        sender_secret,
        &local_id,
        receiver_secret,
    );
    trust_peer(app, state, pairing.peer_identity, token)?;
    let mut runtime = state.sync_runtime().lock()?;
    if let Some(current) = runtime.pairing.as_mut() {
        current.state.status = "paired".into();
        current.state.remote_confirmed = true;
        current.state.peer.trusted = true;
        current.state.message = Some("设备已配对，可以开始增量同步。".into());
    }
    Ok(())
}

pub(super) fn trust_peer(
    app: &AppHandle,
    state: &PlatformState,
    peer: PeerIdentity,
    token: String,
) -> Result<(), PlatformError> {
    let mut envelope = state
        .sync_runtime()
        .lock()?
        .identity
        .clone()
        .ok_or_else(sync_unavailable)?;
    envelope.peers.insert(
        peer.device_id.clone(),
        TrustedPeer {
            identity: peer,
            token,
            paired_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
    );
    save_identity(app, &envelope)?;
    state.sync_runtime().lock()?.identity = Some(envelope);
    Ok(())
}

pub(super) fn authenticate(
    state: &PlatformState,
    headers: &HeaderMap,
) -> Result<TrustedPeer, ApiError> {
    let device_id = headers
        .get("x-fpr-device-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    let runtime = state.sync_runtime().lock().map_err(ApiError::from)?;
    let peer = runtime
        .identity
        .as_ref()
        .and_then(|identity| identity.peers.get(device_id))
        .filter(|peer| constant_time_eq(peer.token.as_bytes(), token.as_bytes()))
        .cloned()
        .ok_or_else(|| ApiError::unauthorized("同步设备未受信任。"))?;
    Ok(peer)
}

pub(super) async fn post_json<T: Serialize, R: DeserializeOwned>(
    endpoint: &DiscoveredPeer,
    route: &str,
    body: &T,
    trusted: Option<(&TrustedPeer, &str)>,
) -> Result<R, PlatformError> {
    post_json_with_timeout(endpoint, route, body, trusted, JSON_REQUEST_TIMEOUT).await
}

pub(super) async fn post_json_with_timeout<T: Serialize, R: DeserializeOwned>(
    endpoint: &DiscoveredPeer,
    route: &str,
    body: &T,
    trusted: Option<(&TrustedPeer, &str)>,
    timeout: Duration,
) -> Result<R, PlatformError> {
    let client = pinned_client(endpoint)?;
    let mut request = client.post(format!(
        "https://fprsync.local:{}{API_ROOT}{route}",
        endpoint.port
    ));
    if let Some((trusted, local_device_id)) = trusted {
        request = request
            .header("x-fpr-device-id", local_device_id)
            .bearer_auth(&trusted.token);
    }
    let response = request
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| sync_network())?;
    decode_response(response).await
}

pub(super) async fn upload_file(
    endpoint: &DiscoveredPeer,
    route: &str,
    path: &PathBuf,
    size: u64,
    trusted: &TrustedPeer,
    local_device_id: &str,
    media_type: &str,
) -> Result<(), PlatformError> {
    let client = pinned_client(endpoint)?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| sync_invalid("刊物包无法读取。"))?;
    let stream = ReaderStream::new(file)
        .timeout(BLOB_IDLE_TIMEOUT)
        .map(|item| match item {
            Ok(chunk) => chunk,
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "同步刊物包传输停滞",
            )),
        });
    let response = client
        .put(format!(
            "https://fprsync.local:{}{API_ROOT}{route}",
            endpoint.port
        ))
        .header("x-fpr-device-id", local_device_id)
        .bearer_auth(&trusted.token)
        .header("content-type", media_type)
        .header("content-length", size)
        .body(reqwest::Body::wrap_stream(stream))
        .timeout(BLOB_TOTAL_TIMEOUT)
        .send()
        .await
        .map_err(|_| sync_network())?;
    let _: Value = decode_response(response).await?;
    Ok(())
}

pub(super) async fn decode_response<R: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<R, PlatformError> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| sync_network())?;
    if bytes.len() > JSON_LIMIT {
        return Err(sync_invalid("同步响应过大。"));
    }
    if !status.is_success() {
        return Err(match status {
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                PlatformError::new(
                    "syncUnauthorized",
                    "另一台设备不再信任本机，请重新配对。",
                    false,
                )
            }
            reqwest::StatusCode::BAD_REQUEST
            | reqwest::StatusCode::CONFLICT
            | reqwest::StatusCode::PAYLOAD_TOO_LARGE => {
                PlatformError::new("syncRejected", "另一台设备拒绝了本次同步请求。", false)
            }
            _ => sync_network(),
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| sync_invalid("同步响应 JSON 无效。"))
}

pub(super) fn pinned_client(endpoint: &DiscoveredPeer) -> Result<Client, PlatformError> {
    let der = BASE64
        .decode(&endpoint.identity.certificate_der_base64)
        .map_err(|_| sync_invalid("同步设备证书无效。"))?;
    let certificate =
        Certificate::from_der(&der).map_err(|_| sync_invalid("同步设备证书无效。"))?;
    let ip: IpAddr = endpoint
        .host
        .parse()
        .map_err(|_| sync_invalid("同步设备地址无效。"))?;
    Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .tls_built_in_root_certs(false)
        .add_root_certificate(certificate)
        .resolve("fprsync.local", SocketAddr::new(ip, endpoint.port))
        .build()
        .map_err(|_| sync_unavailable())
}
