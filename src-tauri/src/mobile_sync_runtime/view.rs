use super::*;

pub(super) fn page_state(runtime: &RuntimeInner) -> PageState {
    let identity = runtime.identity.as_ref();
    let local = identity.map(|identity| {
        device_summary(
            &local_peer(identity),
            true,
            runtime.active,
            &Utc::now().to_rfc3339(),
        )
    });
    let mut nearby = runtime
        .nearby
        .values()
        .map(|peer| {
            device_summary(
                &peer.identity,
                identity
                    .map(|identity| identity.peers.contains_key(&peer.identity.device_id))
                    .unwrap_or(false),
                peer_is_online(peer),
                &peer.last_seen_at,
            )
        })
        .collect::<Vec<_>>();
    nearby.sort_by(|left, right| left.name.cmp(&right.name));
    let mut trusted = identity
        .map(|identity| {
            identity
                .peers
                .values()
                .map(|peer| {
                    let discovered = runtime.nearby.get(&peer.identity.device_id);
                    let online = discovered
                        .map(|found| {
                            found.identity.certificate_sha256 == peer.identity.certificate_sha256
                                && peer_is_online(found)
                        })
                        .unwrap_or(false);
                    let mut summary = device_summary(
                        discovered
                            .map(|found| &found.identity)
                            .unwrap_or(&peer.identity),
                        true,
                        online,
                        discovered
                            .map(|found| found.last_seen_at.as_str())
                            .unwrap_or(&peer.paired_at),
                    );
                    if discovered.is_some_and(|found| {
                        found.identity.certificate_sha256 != peer.identity.certificate_sha256
                    }) {
                        summary.online = false;
                        summary.reachability = "identity-changed".into();
                        summary.diagnostic = Some(DeviceDiagnostic {
                            code: "identity-changed".into(),
                            message: "设备证书指纹已变化，已阻止连接。".into(),
                        });
                    }
                    summary
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    trusted.sort_by(|left, right| left.name.cmp(&right.name));
    let incoming = runtime
        .incoming
        .values()
        .find(|transfer| transfer.status == "waiting")
        .filter(|transfer| transfer.preview.is_some())
        .map(|transfer| IncomingPreview {
            transfer_id: transfer.id.clone(),
            sender: device_summary(&transfer.sender, true, true, &Utc::now().to_rfc3339()),
            total_records: transfer.preview.as_ref().unwrap().total_records,
            new_publications: transfer.preview.as_ref().unwrap().new_publications,
            updated_records: transfer.preview.as_ref().unwrap().updated_records,
            deleted_publications: transfer.preview.as_ref().unwrap().deleted_publications,
            missing_blobs: transfer.preview.as_ref().unwrap().missing_blobs,
            total_bytes: transfer.preview.as_ref().unwrap().total_bytes,
            expires_at: transfer.expires_at.clone(),
        });
    let resumable_incoming = runtime
        .incoming
        .values()
        .filter(|transfer| {
            transfer.preview.is_some() && matches!(transfer.status.as_str(), "waiting" | "accepted")
        })
        .map(|transfer| {
            let completed_blobs = transfer
                .blob_paths
                .keys()
                .map(|hash| {
                    transfer
                        .batch
                        .as_ref()
                        .and_then(|batch| batch.blobs.iter().find(|blob| &blob.sha256 == hash))
                        .map(|blob| blob.byte_length)
                        .unwrap_or(0)
                })
                .sum::<u64>();
            ResumableTransferSummary {
                transfer_id: transfer.id.clone(),
                direction: "receiving".into(),
                peer: device_summary(&transfer.sender, true, false, &Utc::now().to_rfc3339()),
                completed_bytes: transfer.payload_byte_length.saturating_add(completed_blobs),
                total_bytes: transfer.preview.as_ref().unwrap().total_bytes,
                updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                expires_at: transfer.expires_at.clone(),
            }
        })
        .collect::<Vec<_>>();
    PageState {
        active: runtime.active,
        local_device: local,
        nearby_devices: nearby,
        trusted_devices: trusted,
        pairing: runtime
            .pairing
            .as_ref()
            .map(|pairing| pairing.state.clone()),
        incoming,
        operation: runtime.operation.clone(),
        resumable_transfers: resumable_incoming,
        last_completed: runtime.last_completed.clone(),
        diagnostic: runtime.diagnostic.clone(),
    }
}

pub(super) fn device_summary(
    peer: &PeerIdentity,
    trusted: bool,
    online: bool,
    last_seen_at: &str,
) -> DeviceSummary {
    DeviceSummary {
        device_id: peer.device_id.clone(),
        name: peer.name.clone(),
        platform: peer.platform.clone(),
        trusted,
        online,
        reachability: if online { "online" } else { "offline" }.into(),
        diagnostic: None,
        last_seen_at: last_seen_at.into(),
        certificate_sha256: peer.certificate_sha256.clone(),
    }
}

pub(super) fn peer_is_online(peer: &DiscoveredPeer) -> bool {
    chrono::DateTime::parse_from_rfc3339(&peer.last_seen_at)
        .map(|seen| {
            Utc::now()
                .signed_duration_since(seen.with_timezone(&Utc))
                .num_seconds()
                < 15
        })
        .unwrap_or(false)
}

pub(super) fn prepare_response(transfer: &IncomingTransfer) -> PrepareResponse {
    let preview = transfer.preview.clone().unwrap_or(TransferPreview {
        total_records: transfer.record_count,
        new_publications: 0,
        updated_records: 0,
        deleted_publications: 0,
        missing_blobs: transfer.blob_count,
        total_bytes: transfer.payload_byte_length,
    });
    PrepareResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        transfer_id: transfer.id.clone(),
        status: if transfer.status == "committed" {
            "committed".into()
        } else if matches!(transfer.status.as_str(), "accepted" | "applying") {
            "accepted".into()
        } else {
            "waiting".into()
        },
        preview,
        missing_blob_hashes: transfer
            .missing_blob_hashes
            .iter()
            .filter(|hash| !transfer.blob_paths.contains_key(*hash))
            .cloned()
            .collect(),
        expires_at: transfer.expires_at.clone(),
        needs_batch: transfer.batch.is_none() && transfer.status != "committed",
        batch_uploaded: transfer.batch.is_some(),
        result: transfer.result.clone(),
    }
}

pub(super) fn transfer_status(transfer: &IncomingTransfer) -> TransferStatusResponse {
    TransferStatusResponse {
        wire_version: mobile_sync::SYNC_WIRE_VERSION,
        transfer_id: transfer.id.clone(),
        status: if transfer.status == "applying" {
            "accepted".into()
        } else {
            transfer.status.clone()
        },
        missing_blob_hashes: transfer
            .missing_blob_hashes
            .iter()
            .filter(|hash| !transfer.blob_paths.contains_key(*hash))
            .cloned()
            .collect(),
        result: transfer.result.clone(),
    }
}

pub(super) fn complete_operation(
    runtime: &mut RuntimeInner,
    peer: &PeerIdentity,
    direction: &str,
    result: &SyncApplyResult,
) {
    runtime.last_completed = Some(CompletedResult {
        direction: direction.into(),
        peer_name: peer.name.clone(),
        completed_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        applied_records: result.applied_records,
        unchanged_records: result.unchanged_records,
        imported_publications: result.imported_blobs,
    });
    if let Some(operation) = runtime.operation.as_mut() {
        operation.stage = "completed".into();
        operation.message = if direction == "sending" {
            "增量同步已发送并确认。".into()
        } else {
            "增量同步已安全应用。".into()
        };
        operation.completed_bytes = operation.total_bytes;
    }
}

pub(super) fn update_operation(runtime: &mut RuntimeInner, stage: &str, message: &str) {
    if let Some(operation) = runtime.operation.as_mut() {
        operation.stage = stage.into();
        operation.message = message.into();
    }
}

pub(super) fn operation_is_active(operation: &OperationState) -> bool {
    !matches!(
        operation.stage.as_str(),
        "completed" | "cancelled" | "error" | "resumable"
    )
}

pub(super) fn expire(runtime: &mut RuntimeInner) {
    let now = Utc::now();
    let trusted = runtime
        .identity
        .as_ref()
        .map(|identity| identity.peers.keys().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();
    runtime.nearby.retain(|device_id, peer| {
        trusted.contains(device_id)
            || chrono::DateTime::parse_from_rfc3339(&peer.last_seen_at)
                .map(|seen| {
                    now.signed_duration_since(seen.with_timezone(&Utc))
                        .num_seconds()
                        < 30
                })
                .unwrap_or(false)
    });
    if let Some(pairing) = runtime.pairing.as_mut() {
        if pairing.state.status == "waiting"
            && chrono::DateTime::parse_from_rfc3339(&pairing.state.expires_at)
                .map(|expires| expires < now)
                .unwrap_or(true)
        {
            pairing.state.status = "expired".into();
            pairing.state.message = Some("配对请求已过期。".into());
        }
    }
    let expired_ids = runtime
        .incoming
        .iter()
        .filter(|(_, transfer)| {
            matches!(
                transfer.status.as_str(),
                "awaiting-batch" | "waiting" | "accepted"
            ) && chrono::DateTime::parse_from_rfc3339(&transfer.expires_at)
                .map(|expires| expires < now)
                .unwrap_or(true)
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in expired_ids {
        if let Some(transfer) = runtime.incoming.remove(&id) {
            let _ = fs::remove_dir_all(transfer.root);
        }
    }
    runtime.summary_snapshots.retain(|_, snapshot| {
        chrono::DateTime::parse_from_rfc3339(&snapshot.expires_at)
            .map(|expires| expires > now)
            .unwrap_or(false)
    });
}

pub(super) fn pairing_code(nonce: &str, left: &PeerIdentity, right: &PeerIdentity) -> String {
    let mut ids = [left.device_id.as_str(), right.device_id.as_str()];
    ids.sort();
    let mut fingerprints = [
        left.certificate_sha256.as_str(),
        right.certificate_sha256.as_str(),
    ];
    fingerprints.sort();
    let value = [
        PROTOCOL,
        &mobile_sync::SYNC_WIRE_VERSION.to_string(),
        nonce,
        ids[0],
        ids[1],
        fingerprints[0],
        fingerprints[1],
    ]
    .join("\u{1f}");
    let digest = hex::encode(Sha256::digest(value.as_bytes()));
    let number = u64::from_str_radix(&digest[..12], 16).unwrap_or(0) % 1_000_000;
    format!("{number:06}")
}

pub(super) fn derive_token(
    left_id: &str,
    left_secret: &str,
    right_id: &str,
    right_secret: &str,
) -> String {
    let mut participants = [
        format!("{left_id}\u{1e}{left_secret}"),
        format!("{right_id}\u{1e}{right_secret}"),
    ];
    participants.sort();
    hex::encode(Sha256::digest(
        [PROTOCOL, "trust-v1", &participants[0], &participants[1]]
            .join("\u{1f}")
            .as_bytes(),
    ))
}

pub(super) fn random_hex(bytes: usize) -> String {
    let mut result = String::new();
    while result.len() < bytes * 2 {
        result.push_str(&Uuid::new_v4().simple().to_string());
    }
    result.truncate(bytes * 2);
    result
}

pub(super) fn android_device_name(device_id: &str) -> String {
    format!("Android 设备 · {}", &device_id[..device_id.len().min(6)])
}

pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}
