use super::*;

pub async fn open_page(app: &AppHandle, state: &PlatformState) -> Result<PageState, PlatformError> {
    let _lifecycle = state.sync_runtime().lifecycle.lock().await;
    if state.sync_runtime().is_active()? {
        #[cfg(target_os = "android")]
        {
            let (port, identity) = {
                let runtime = state.sync_runtime().lock()?;
                (runtime.port, runtime.identity.clone())
            };
            if let Some(identity) = identity {
                start_discovery(app, port, &identity)?;
            }
        }
        return get_state(app, state);
    }
    let device_id = state.database()?.device_id().to_owned();
    let identity = load_or_create_identity(app, &device_id)?;
    let restored_incoming = load_incoming_transfers(&state.paths, &identity, &device_id)?;
    let config = RustlsConfig::from_pem(
        identity.identity.certificate_pem.clone().into_bytes(),
        identity.identity.private_key_pem.clone().into_bytes(),
    )
    .await
    .map_err(|_| sync_unavailable())?;
    let listener = TcpListener::bind(("0.0.0.0", SYNC_PORT)).map_err(|_| {
        PlatformError::new(
            "syncPortInUse",
            "固定端口 53318 无法使用，请关闭占用该端口的应用后重试。",
            true,
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|_| sync_unavailable())?;
    let port = listener
        .local_addr()
        .map_err(|_| sync_unavailable())?
        .port();
    let handle = Handle::new();
    let router = sync_router(app.clone());
    let server_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = axum_server::from_tcp_rustls(listener, config)
            .handle(server_handle)
            .serve(router.into_make_service())
            .await;
    });
    {
        let mut runtime = state.sync_runtime().lock()?;
        runtime.active = true;
        runtime.port = port;
        runtime.identity = Some(identity.clone());
        runtime.server_handle = Some(handle);
        runtime.diagnostic = None;
        runtime.nearby.clear();
        runtime.incoming = restored_incoming;
    }
    if let Err(error) = start_discovery(app, port, &identity) {
        state.sync_runtime().stop_server()?;
        return Err(error);
    }
    get_state(app, state)
}

pub async fn close_page(app: &AppHandle, state: &PlatformState) -> Result<(), PlatformError> {
    let _lifecycle = state.sync_runtime().lifecycle.lock().await;
    let _ = stop_discovery(app);
    {
        let mut runtime = state.sync_runtime().lock()?;
        let applying = runtime
            .operation
            .as_ref()
            .is_some_and(|operation| operation.stage == "applying")
            || runtime
                .incoming
                .values()
                .any(|transfer| transfer.status == "applying");
        runtime.active = false;
        if let Some(handle) = runtime.server_handle.take() {
            handle.graceful_shutdown(if applying {
                None
            } else {
                Some(Duration::from_secs(2))
            });
        }
        if let Some(task) = runtime.pair_task.take() {
            task.abort();
        }
        if !applying {
            if let Some(task) = runtime.operation_task.take() {
                task.abort();
            }
            runtime.operation = None;
        }
        runtime.pairing = None;
        runtime.nearby.clear();
    }
    remove_mobile_partial_files(&state.paths.persistent_staging.join("sync-inbox"));
    Ok(())
}

pub fn get_state(app: &AppHandle, state: &PlatformState) -> Result<PageState, PlatformError> {
    refresh_discovery(app, state)?;
    let mut runtime = state.sync_runtime().lock()?;
    expire(&mut runtime);
    let mut page = page_state(&runtime);
    drop(runtime);
    append_resumable_transfers(state, &mut page)?;
    Ok(page)
}

pub fn refresh_discovery_now(
    app: &AppHandle,
    state: &PlatformState,
) -> Result<PageState, PlatformError> {
    trigger_discovery_refresh(app)?;
    refresh_discovery(app, state)?;
    let mut runtime = state.sync_runtime().lock()?;
    expire(&mut runtime);
    let mut page = page_state(&runtime);
    drop(runtime);
    append_resumable_transfers(state, &mut page)?;
    Ok(page)
}

fn append_resumable_transfers(
    state: &PlatformState,
    page: &mut PageState,
) -> Result<(), PlatformError> {
    for transfer in mobile_sync::resumable_transfer_summaries(&state.paths)? {
        let Some(peer) = page
            .trusted_devices
            .iter()
            .find(|peer| peer.device_id == transfer.peer_device_id)
            .cloned()
        else {
            continue;
        };
        page.resumable_transfers.push(ResumableTransferSummary {
            transfer_id: transfer.batch_id,
            direction: "sending".into(),
            peer,
            completed_bytes: transfer.payload_byte_length,
            total_bytes: transfer.total_byte_length,
            updated_at: transfer.updated_at,
            expires_at: transfer.expires_at,
        });
    }
    Ok(())
}

pub async fn start_pairing(
    app: &AppHandle,
    state: &PlatformState,
    device_id: &str,
) -> Result<PageState, PlatformError> {
    let (endpoint, local) = {
        let mut runtime = state.sync_runtime().lock()?;
        if !runtime.active {
            return Err(sync_busy("局域网同步页面未打开。"));
        }
        if runtime
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.state.status == "waiting")
        {
            return Err(sync_busy("已有设备配对正在进行。"));
        }
        if let Some(task) = runtime.pair_task.take() {
            task.abort();
        }
        runtime.pairing = None;
        let identity = runtime.identity.as_ref().ok_or_else(sync_unavailable)?;
        if identity.peers.contains_key(device_id) {
            return Err(sync_busy("该设备已经受信任。"));
        }
        (
            runtime
                .nearby
                .get(device_id)
                .cloned()
                .ok_or_else(|| sync_busy("该设备当前不在线。"))?,
            local_peer(identity),
        )
    };
    if !peer_is_online(&endpoint) {
        return Err(sync_busy("该设备当前不可达，请刷新发现后重试。"));
    }
    let nonce = random_hex(24);
    let local_secret = random_hex(32);
    let request = PairPrepareRequest {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        sender: local.clone(),
        nonce: nonce.clone(),
        sender_secret: local_secret.clone(),
    };
    let response: PairPrepareResponse =
        post_json(&endpoint, "/pair/prepare", &request, None).await?;
    validate_wire(response.wire_version)?;
    validate_peer(&response.receiver)?;
    if response.receiver.device_id != endpoint.identity.device_id
        || response.receiver.certificate_sha256 != endpoint.identity.certificate_sha256
        || response.receiver.certificate_der_base64 != endpoint.identity.certificate_der_base64
    {
        return Err(sync_invalid("发现设备与 TLS 身份不一致。"));
    }
    let code = pairing_code(&nonce, &local, &response.receiver);
    if code != response.code {
        return Err(sync_invalid("设备配对验证码校验失败。"));
    }
    {
        let mut runtime = state.sync_runtime().lock()?;
        runtime.pairing = Some(PairingRuntime {
            state: PairingState {
                session_id: response.session_id,
                direction: "outgoing".into(),
                peer: device_summary(&endpoint.identity, false, true, &endpoint.last_seen_at),
                code,
                local_confirmed: false,
                remote_confirmed: false,
                status: "waiting".into(),
                message: Some("请核对两台设备上的六位数字，并分别确认。".into()),
                expires_at: response.expires_at,
            },
            peer_identity: response.receiver,
            endpoint: Some(endpoint),
            local_secret,
            remote_secret: None,
            sender_secret: None,
            sender_confirmed: false,
        });
    }
    get_state(app, state)
}

pub fn confirm_pairing(
    app: &AppHandle,
    state: &PlatformState,
    session_id: &str,
) -> Result<PageState, PlatformError> {
    let pairing = {
        let mut runtime = state.sync_runtime().lock()?;
        let pairing = runtime
            .pairing
            .as_mut()
            .filter(|pairing| pairing.state.session_id == session_id)
            .ok_or_else(|| sync_invalid("配对请求不存在。"))?;
        pairing.state.local_confirmed = true;
        pairing.state.message = Some("已确认，正在等待另一台设备。".into());
        pairing.clone()
    };
    if pairing.state.direction == "incoming" {
        if pairing.sender_confirmed {
            finalize_incoming_pair(app, state, session_id)?;
        }
    } else {
        let app_handle = app.clone();
        let session = session_id.to_owned();
        let task = tauri::async_runtime::spawn(async move {
            finish_outgoing_pair(&app_handle, &session).await;
        });
        state.sync_runtime().lock()?.pair_task = Some(task);
    }
    get_state(app, state)
}

pub async fn reject_pairing(
    app: &AppHandle,
    state: &PlatformState,
    session_id: &str,
) -> Result<PageState, PlatformError> {
    let endpoint = {
        let mut runtime = state.sync_runtime().lock()?;
        let pairing = runtime
            .pairing
            .as_mut()
            .filter(|pairing| pairing.state.session_id == session_id)
            .ok_or_else(|| sync_invalid("配对请求不存在。"))?;
        pairing.state.status = "rejected".into();
        pairing.state.message = Some("配对已拒绝。".into());
        pairing.endpoint.clone()
    };
    if let Some(endpoint) = endpoint {
        let _ = post_json::<_, Value>(
            &endpoint,
            "/pair/confirm",
            &PairConfirmRequest {
                wire_version: mobile_sync::SYNC_WIRE_VERSION,
                session_id: session_id.into(),
                sender_confirmed: false,
            },
            None,
        )
        .await;
    }
    get_state(app, state)
}

pub fn send_to(
    app: &AppHandle,
    state: &PlatformState,
    device_id: &str,
) -> Result<PageState, PlatformError> {
    let (endpoint, trusted) = {
        let mut runtime = state.sync_runtime().lock()?;
        if runtime.operation.as_ref().is_some_and(operation_is_active) {
            return Err(sync_busy("已有同步传输正在进行。"));
        }
        if let Some(task) = runtime.operation_task.take() {
            task.abort();
        }
        runtime.operation = None;
        let identity = runtime.identity.as_ref().ok_or_else(sync_unavailable)?;
        let trusted = identity
            .peers
            .get(device_id)
            .cloned()
            .ok_or_else(|| sync_busy("请先完成设备配对。"))?;
        let endpoint = runtime
            .nearby
            .get(device_id)
            .cloned()
            .ok_or_else(|| sync_busy("该设备当前不在线。"))?;
        if !peer_is_online(&endpoint) {
            return Err(sync_busy("该设备当前不可达，请刷新发现后重试。"));
        }
        if endpoint.identity.certificate_sha256 != trusted.identity.certificate_sha256 {
            return Err(sync_invalid("设备证书已变化；请撤销信任后重新配对。"));
        }
        runtime.operation = Some(OperationState {
            operation_id: Uuid::new_v4().to_string(),
            direction: "sending".into(),
            peer: device_summary(&endpoint.identity, true, true, &endpoint.last_seen_at),
            stage: "summarizing".into(),
            message: "正在比较两台设备的增量状态…".into(),
            completed_bytes: 0,
            total_bytes: 0,
            resumable: false,
        });
        (endpoint, trusted)
    };
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let outcome = run_send(&app_handle, endpoint, trusted).await;
        if let Err(error) = outcome {
            if let Some(state) = app_handle.try_state::<PlatformState>() {
                if let Ok(mut runtime) = state.sync_runtime().lock() {
                    if let Some(operation) = runtime.operation.as_mut() {
                        operation.stage = if operation.resumable {
                            "resumable"
                        } else {
                            "error"
                        }
                        .into();
                        operation.message = error.to_string();
                    }
                }
            }
        }
    });
    state.sync_runtime().lock()?.operation_task = Some(task);
    get_state(app, state)
}

pub fn accept_incoming(
    app: &AppHandle,
    state: &PlatformState,
    transfer_id: &str,
) -> Result<PageState, PlatformError> {
    {
        let mut runtime = state.sync_runtime().lock()?;
        let transfer = runtime
            .incoming
            .get_mut(transfer_id)
            .filter(|transfer| transfer.status == "waiting")
            .ok_or_else(|| sync_invalid("同步请求已经处理。"))?;
        let preview = transfer
            .preview
            .as_ref()
            .ok_or_else(|| sync_invalid("同步批次尚未验证完成。"))?;
        let total = preview.total_bytes;
        transfer.status = "accepted".into();
        write_mobile_incoming_state(transfer)?;
        let peer = transfer.sender.clone();
        runtime.operation = Some(OperationState {
            operation_id: transfer_id.into(),
            direction: "receiving".into(),
            peer: device_summary(&peer, true, true, &Utc::now().to_rfc3339()),
            stage: "waiting-confirmation".into(),
            message: "已接受，正在等待发送端上传缺失内容…".into(),
            completed_bytes: 0,
            total_bytes: total,
            resumable: true,
        });
    }
    get_state(app, state)
}

pub fn reject_incoming(
    app: &AppHandle,
    state: &PlatformState,
    transfer_id: &str,
) -> Result<PageState, PlatformError> {
    let root = {
        let mut runtime = state.sync_runtime().lock()?;
        runtime
            .incoming
            .remove(transfer_id)
            .ok_or_else(|| sync_invalid("同步请求不存在。"))?
            .root
    };
    let _ = fs::remove_dir_all(root);
    get_state(app, state)
}

pub fn cancel_operation(
    app: &AppHandle,
    state: &PlatformState,
) -> Result<PageState, PlatformError> {
    let (roots, outgoing_id) = {
        let mut runtime = state.sync_runtime().lock()?;
        if runtime
            .operation
            .as_ref()
            .is_some_and(|operation| operation.stage == "applying")
            || runtime
                .incoming
                .values()
                .any(|transfer| transfer.status == "applying")
        {
            return Err(sync_busy("同步数据正在原子应用，当前不能取消。"));
        }
        if let Some(task) = runtime.operation_task.take() {
            task.abort();
        }
        let outgoing_id = runtime
            .operation
            .as_ref()
            .filter(|operation| operation.direction == "sending" && operation.resumable)
            .map(|operation| operation.operation_id.clone());
        if let Some(operation) = runtime.operation.as_mut() {
            operation.stage = "cancelled".into();
            operation.message = "同步已取消。".into();
        }
        let roots = runtime
            .incoming
            .values_mut()
            .filter(|transfer| transfer.status == "accepted")
            .map(|transfer| {
                transfer.status = "cancelled".into();
                transfer.root.clone()
            })
            .collect::<Vec<_>>();
        runtime
            .incoming
            .retain(|_, transfer| transfer.status != "cancelled");
        (roots, outgoing_id)
    };
    for root in roots {
        let _ = fs::remove_dir_all(root);
    }
    if let Some(transfer_id) = outgoing_id {
        let _ = fs::remove_dir_all(
            state
                .paths
                .persistent_staging
                .join("sync-outbox")
                .join(transfer_id),
        );
    }
    get_state(app, state)
}

pub fn discard_pending_transfer(
    app: &AppHandle,
    state: &PlatformState,
    transfer_id: &str,
) -> Result<PageState, PlatformError> {
    let root = {
        let mut runtime = state.sync_runtime().lock()?;
        if runtime.operation.as_ref().is_some_and(|operation| {
            operation.operation_id == transfer_id && operation.stage == "applying"
        }) {
            return Err(sync_busy("同步数据正在应用，无法丢弃。"));
        }
        runtime
            .incoming
            .remove(transfer_id)
            .map(|transfer| transfer.root)
    };
    if let Some(root) = root {
        let _ = fs::remove_dir_all(root);
    }
    let outgoing = state
        .paths
        .persistent_staging
        .join("sync-outbox")
        .join(transfer_id);
    let _ = fs::remove_dir_all(outgoing);
    get_state(app, state)
}

pub fn revoke_trust(
    app: &AppHandle,
    state: &PlatformState,
    device_id: &str,
) -> Result<PageState, PlatformError> {
    let mut envelope = {
        let runtime = state.sync_runtime().lock()?;
        if runtime.operation.as_ref().is_some_and(|operation| {
            operation_is_active(operation) && operation.peer.device_id == device_id
        }) {
            return Err(sync_busy("该设备正在同步，无法撤销信任。"));
        }
        runtime.identity.clone().ok_or_else(sync_unavailable)?
    };
    envelope.peers.remove(device_id);
    let incoming_roots = {
        let mut runtime = state.sync_runtime().lock()?;
        let ids = runtime
            .incoming
            .iter()
            .filter(|(_, transfer)| transfer.sender.device_id == device_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| runtime.incoming.remove(&id).map(|transfer| transfer.root))
            .collect::<Vec<_>>()
    };
    for root in incoming_roots {
        let _ = fs::remove_dir_all(root);
    }
    for transfer in mobile_sync::resumable_transfers(&state.paths)? {
        if transfer.batch.recipient_device_id == device_id {
            mobile_sync::cleanup_prepared(&transfer);
        }
    }
    save_identity(app, &envelope)?;
    state.sync_runtime().lock()?.identity = Some(envelope);
    get_state(app, state)
}

impl MobileSyncRuntime {
    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, RuntimeInner>, PlatformError> {
        self.inner
            .lock()
            .map_err(|_| PlatformError::new("syncUnavailable", "跨设备同步暂时不可用。", true))
    }

    pub(super) fn is_active(&self) -> Result<bool, PlatformError> {
        Ok(self.lock()?.active)
    }

    fn stop_server(&self) -> Result<(), PlatformError> {
        let mut runtime = self.lock()?;
        runtime.active = false;
        if let Some(handle) = runtime.server_handle.take() {
            handle.shutdown();
        }
        Ok(())
    }
}
