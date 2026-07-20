use super::*;

#[cfg(target_os = "android")]
pub(super) fn start_discovery(
    app: &AppHandle,
    port: u16,
    envelope: &IdentityEnvelope,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let attrs = discovery_attributes(envelope);
    let attributes_json = serde_json::to_string(&attrs).map_err(|_| sync_discovery_error())?;
    app.foundation()
        .sync_discovery_start(
            port,
            &format!("FPR-{}", &envelope.identity.device_id[..8]),
            &attributes_json,
        )
        .map_err(|_| sync_discovery_error())
}

#[cfg(not(target_os = "android"))]
pub(super) fn start_discovery(
    _app: &AppHandle,
    _port: u16,
    _envelope: &IdentityEnvelope,
) -> Result<(), PlatformError> {
    Err(sync_discovery_error())
}

#[cfg(target_os = "android")]
pub(super) fn stop_discovery(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .sync_discovery_stop()
        .map_err(|_| sync_discovery_error())
}

#[cfg(target_os = "android")]
pub(super) fn trigger_discovery_refresh(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .sync_discovery_refresh()
        .map_err(|_| sync_discovery_error())
}

#[cfg(not(target_os = "android"))]
pub(super) fn trigger_discovery_refresh(_app: &AppHandle) -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub(super) fn stop_discovery(_app: &AppHandle) -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(target_os = "android")]
pub(super) fn discovery_attributes(envelope: &IdentityEnvelope) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("p".into(), PROTOCOL.into()),
        ("w".into(), mobile_sync::SYNC_WIRE_VERSION.to_string()),
        ("m".into(), mobile_sync::SYNC_MODEL_VERSION.to_string()),
        ("id".into(), envelope.identity.device_id.clone()),
        (
            "n".into(),
            android_device_name(&envelope.identity.device_id),
        ),
        ("os".into(), "android".into()),
        ("fp".into(), envelope.identity.certificate_sha256.clone()),
    ])
}

#[cfg(target_os = "android")]
pub(super) fn refresh_discovery(
    app: &AppHandle,
    state: &PlatformState,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let snapshot = match app.foundation().sync_discovery_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            state.sync_runtime().lock()?.diagnostic =
                Some("局域网发现不可用。请检查 Wi-Fi、访客网络/AP 隔离和本地网络权限。".into());
            return Ok(());
        }
    };
    let discovery_diagnostic = snapshot.diagnostic.clone();
    let local_id = state.database()?.device_id().to_owned();
    let mut peers = Vec::new();
    for service in snapshot.peers {
        if let Ok(peer) =
            discovered_from_attributes(&service.host, service.port, &service.attributes)
        {
            if peer.identity.device_id != local_id {
                peers.push(peer);
            }
        }
    }
    let mut runtime = state.sync_runtime().lock()?;
    for peer in peers {
        runtime.nearby.insert(peer.identity.device_id.clone(), peer);
    }
    runtime.diagnostic = discovery_diagnostic;
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub(super) fn refresh_discovery(
    _app: &AppHandle,
    _state: &PlatformState,
) -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(target_os = "android")]
pub(super) fn discovered_from_attributes(
    host: &str,
    port: u16,
    attrs: &HashMap<String, String>,
) -> Result<DiscoveredPeer, PlatformError> {
    if attrs.get("p").map(String::as_str) != Some(PROTOCOL)
        || attrs.get("w").and_then(|value| value.parse::<i64>().ok())
            != Some(mobile_sync::SYNC_WIRE_VERSION)
        || attrs.get("m").and_then(|value| value.parse::<i64>().ok())
            != Some(mobile_sync::SYNC_MODEL_VERSION)
        || host.parse::<IpAddr>().is_err()
        || port == 0
    {
        return Err(sync_invalid("局域网发现记录无效。"));
    }
    let count = attrs
        .get("cc")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0 && *value <= 16)
        .ok_or_else(|| sync_invalid("局域网发现证书分片无效。"))?;
    let certificate = (0..count)
        .map(|index| attrs.get(&format!("c{index}")).cloned())
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| sync_invalid("局域网发现证书不完整。"))?
        .join("");
    let identity = PeerIdentity {
        device_id: attrs.get("id").cloned().unwrap_or_default(),
        name: attrs.get("n").cloned().unwrap_or_default(),
        platform: attrs.get("os").cloned().unwrap_or_default(),
        certificate_sha256: attrs.get("fp").cloned().unwrap_or_default(),
        certificate_der_base64: certificate,
    };
    validate_peer(&identity)?;
    Ok(DiscoveredPeer {
        identity,
        host: host.trim_matches(['[', ']']).into(),
        port,
        last_seen_at: attrs
            .get("seen")
            .and_then(|value| value.parse::<i64>().ok())
            .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

pub(super) fn validate_peer(peer: &PeerIdentity) -> Result<(), PlatformError> {
    if peer.device_id.is_empty()
        || peer.name.is_empty()
        || !matches!(peer.platform.as_str(), "windows" | "android")
        || !valid_sha256(&peer.certificate_sha256)
    {
        return Err(sync_invalid("同步设备身份无效。"));
    }
    let der = BASE64
        .decode(&peer.certificate_der_base64)
        .map_err(|_| sync_invalid("同步设备证书无效。"))?;
    if hex::encode(Sha256::digest(&der)) != peer.certificate_sha256 {
        return Err(sync_invalid("同步设备证书无效。"));
    }
    Ok(())
}

pub(super) fn local_peer(envelope: &IdentityEnvelope) -> PeerIdentity {
    PeerIdentity {
        device_id: envelope.identity.device_id.clone(),
        name: android_device_name(&envelope.identity.device_id),
        platform: "android".into(),
        certificate_sha256: envelope.identity.certificate_sha256.clone(),
        certificate_der_base64: envelope.identity.certificate_der_base64.clone(),
    }
}
