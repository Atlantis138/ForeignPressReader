use super::*;

#[test]
fn public_facade_keeps_the_mobile_runtime_paths() {
    let _ = std::mem::size_of::<crate::mobile_sync_runtime::PeerIdentity>();
    let _ = std::mem::size_of::<crate::mobile_sync_runtime::PageState>();
    let _ = std::mem::size_of::<crate::mobile_sync_runtime::MobileSyncRuntime>();
    let _ = crate::mobile_sync_runtime::open_page;
    let _ = crate::mobile_sync_runtime::close_page;
    let _ = crate::mobile_sync_runtime::get_state;
    let _ = crate::mobile_sync_runtime::refresh_discovery_now;
    let _ = crate::mobile_sync_runtime::start_pairing;
    let _ = crate::mobile_sync_runtime::confirm_pairing;
    let _ = crate::mobile_sync_runtime::reject_pairing;
    let _ = crate::mobile_sync_runtime::send_to;
    let _ = crate::mobile_sync_runtime::accept_incoming;
    let _ = crate::mobile_sync_runtime::reject_incoming;
    let _ = crate::mobile_sync_runtime::cancel_operation;
    let _ = crate::mobile_sync_runtime::discard_pending_transfer;
    let _ = crate::mobile_sync_runtime::revoke_trust;
}

#[test]
fn matches_the_shared_lan_sync_wire_v2_vector() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../test-vectors/lan-sync-wire-v2.json"))
            .expect("wire vector");
    let peer = |side: &str| PeerIdentity {
        device_id: vector[side]["deviceId"].as_str().unwrap().into(),
        name: side.into(),
        platform: if side == "left" { "windows" } else { "android" }.into(),
        certificate_sha256: vector[side]["certificateSha256"].as_str().unwrap().into(),
        certificate_der_base64: String::new(),
    };
    let left = peer("left");
    let right = peer("right");
    let nonce = vector["nonce"].as_str().unwrap();
    let expected_code = vector["expectedPairingCode"].as_str().unwrap();
    let expected_token = vector["expectedTrustToken"].as_str().unwrap();

    assert_eq!(vector["protocol"].as_str(), Some(PROTOCOL));
    assert_eq!(
        vector["wireVersion"].as_i64(),
        Some(mobile_sync::SYNC_WIRE_VERSION)
    );
    assert_eq!(vector["port"].as_u64(), Some(SYNC_PORT as u64));
    assert_eq!(
        vector["limits"]["controlJsonBytes"].as_u64(),
        Some(JSON_LIMIT as u64)
    );
    assert_eq!(
        vector["limits"]["batchMetadataBytes"].as_u64(),
        Some(BATCH_LIMIT)
    );

    assert_eq!(
        vector["limits"]["connectTimeoutMs"].as_u64(),
        Some(CONNECT_TIMEOUT.as_millis() as u64)
    );
    assert_eq!(
        vector["limits"]["jsonRequestTimeoutMs"].as_u64(),
        Some(JSON_REQUEST_TIMEOUT.as_millis() as u64)
    );
    assert_eq!(
        vector["limits"]["blobIdleTimeoutMs"].as_u64(),
        Some(BLOB_IDLE_TIMEOUT.as_millis() as u64)
    );
    assert_eq!(
        vector["limits"]["transferLifetimeMs"].as_u64(),
        Some(BLOB_TOTAL_TIMEOUT.as_millis() as u64)
    );

    assert_eq!(pairing_code(nonce, &left, &right), expected_code);
    assert_eq!(pairing_code(nonce, &right, &left), expected_code);
    assert_eq!(
        derive_token(
            &left.device_id,
            vector["left"]["secret"].as_str().unwrap(),
            &right.device_id,
            vector["right"]["secret"].as_str().unwrap(),
        ),
        expected_token
    );
    assert_eq!(
        derive_token(
            &right.device_id,
            vector["right"]["secret"].as_str().unwrap(),
            &left.device_id,
            vector["left"]["secret"].as_str().unwrap(),
        ),
        expected_token
    );
}
