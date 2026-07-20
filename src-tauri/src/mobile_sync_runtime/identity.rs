use super::*;

pub(super) fn load_or_create_identity(
    app: &AppHandle,
    device_id: &str,
) -> Result<IdentityEnvelope, PlatformError> {
    if let Some(value) = secure_load(app, IDENTITY_SLOT)? {
        let envelope: IdentityEnvelope =
            serde_json::from_str(&value).map_err(|_| sync_identity_error())?;
        validate_envelope(&envelope, device_id)?;
        return Ok(envelope);
    }
    let CertifiedKey { cert, key_pair } = generate_simple_self_signed(vec!["fprsync.local".into()])
        .map_err(|_| sync_identity_error())?;
    let der = cert.der().as_ref();
    let identity = LocalIdentity {
        device_id: device_id.into(),
        certificate_pem: cert.pem(),
        private_key_pem: key_pair.serialize_pem(),
        certificate_der_base64: BASE64.encode(der),
        certificate_sha256: hex::encode(Sha256::digest(der)),
        created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let envelope = IdentityEnvelope {
        version: 1,
        identity,
        peers: BTreeMap::new(),
    };
    save_identity(app, &envelope)?;
    Ok(envelope)
}

pub(super) fn validate_envelope(
    envelope: &IdentityEnvelope,
    device_id: &str,
) -> Result<(), PlatformError> {
    if envelope.version != 1
        || envelope.identity.device_id != device_id
        || !valid_sha256(&envelope.identity.certificate_sha256)
        || !envelope
            .identity
            .certificate_pem
            .contains("BEGIN CERTIFICATE")
        || !envelope
            .identity
            .private_key_pem
            .contains("BEGIN PRIVATE KEY")
    {
        return Err(sync_identity_error());
    }
    let der = BASE64
        .decode(&envelope.identity.certificate_der_base64)
        .map_err(|_| sync_identity_error())?;
    if hex::encode(Sha256::digest(&der)) != envelope.identity.certificate_sha256 {
        return Err(sync_identity_error());
    }
    for peer in envelope.peers.values() {
        validate_peer(&peer.identity)?;
        if !valid_sha256(&peer.token) {
            return Err(sync_identity_error());
        }
    }
    Ok(())
}

pub(super) fn save_identity(
    app: &AppHandle,
    envelope: &IdentityEnvelope,
) -> Result<(), PlatformError> {
    let value = serde_json::to_string(envelope).map_err(|_| sync_identity_error())?;
    secure_save(app, IDENTITY_SLOT, &value)
}

#[cfg(target_os = "android")]
pub(super) fn secure_load(app: &AppHandle, slot: &str) -> Result<Option<String>, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_load(slot)
        .map(|value| value.value)
        .map_err(|_| sync_identity_error())
}

#[cfg(not(target_os = "android"))]
pub(super) fn secure_load(_app: &AppHandle, _slot: &str) -> Result<Option<String>, PlatformError> {
    Err(sync_unavailable())
}

#[cfg(target_os = "android")]
pub(super) fn secure_save(app: &AppHandle, slot: &str, value: &str) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_save(slot, value)
        .map_err(|_| sync_identity_error())
}

#[cfg(not(target_os = "android"))]
pub(super) fn secure_save(
    _app: &AppHandle,
    _slot: &str,
    _value: &str,
) -> Result<(), PlatformError> {
    Err(sync_unavailable())
}
