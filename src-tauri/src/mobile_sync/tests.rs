use super::*;

#[test]
fn public_facade_keeps_the_sync_v2_paths() {
    let _ = crate::mobile_sync::SYNC_MODEL_VERSION;
    let _ = crate::mobile_sync::SYNC_WIRE_VERSION;
    let _ = crate::mobile_sync::MAX_BATCH_BYTES;
    let _ = crate::mobile_sync::MAX_NDJSON_LINE_BYTES;
    let _ = crate::mobile_sync::BATCH_MEDIA_TYPE;
    let _ = std::mem::size_of::<crate::mobile_sync::SyncBatch>();
    let _ = std::mem::size_of::<crate::mobile_sync::SyncPeerSummary>();
    let _ = std::mem::size_of::<crate::mobile_sync::SyncApplyResult>();
    let _ = std::mem::size_of::<crate::mobile_sync::PreparedMobileTransfer>();
    let _ = crate::mobile_sync::create_peer_summary;
    let _ = crate::mobile_sync::duplicate_receipt_result;
    let _ = crate::mobile_sync::peer_inspected_revision;
    let _ = crate::mobile_sync::preview_incoming_batch;
    let _ = crate::mobile_sync::prepare_transfer;
    let _ = crate::mobile_sync::cleanup_prepared;
    let _ = crate::mobile_sync::expanded_blob_bytes;
    let _ = crate::mobile_sync::resumable_transfers;
    let _ = crate::mobile_sync::resumable_transfer_summaries;
    let _ = crate::mobile_sync::write_batch_payload;
    let _ = crate::mobile_sync::read_batch_payload;
    let _ = crate::mobile_sync::apply_transfer;
    let _ = crate::mobile_sync::acknowledge_transfer;
    let _ = crate::mobile_sync::validate_batch;
    let _ = crate::mobile_sync::stable_payload_sha256;
}

#[test]
fn matches_the_shared_sync_model_v2_payload_vector() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../test-vectors/sync-model-v2.json"))
            .expect("sync model vector");
    let batch: SyncBatch = serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    validate_batch(&batch, &batch.recipient_device_id).expect("valid v2 batch");
    assert_eq!(
        stable_payload_sha256(&batch).expect("payload hash"),
        vector["expectedStablePayloadSha256"].as_str().unwrap()
    );
}

#[test]
fn matches_and_validates_the_shared_sync_model_v3_payload_vector() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../test-vectors/sync-model-v3.json"))
            .expect("sync model vector");
    let batch: SyncBatch = serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    validate_batch(&batch, &batch.recipient_device_id).expect("valid v3 batch");
    assert_eq!(
        stable_payload_sha256(&batch).expect("payload hash"),
        vector["expectedStablePayloadSha256"].as_str().unwrap()
    );
}

#[test]
fn present_publication_selection_restores_its_cascaded_reading_position() {
    let publication_id = "pub_aaaaaaaaaaaaaaaaaaaaaaaa";
    let records = vec![
        LogicalRecord {
            entity_type: "publication-lifecycle".into(),
            key: publication_id.into(),
            revision: 1,
            value: serde_json::json!({
                "publicationId": publication_id,
                "contentHash": "a".repeat(64),
                "formatId": "epub",
                "title": "Fixture",
                "state": "present",
                "changedAt": "2026-07-31T00:00:00.000Z",
                "deviceId": "sender"
            }),
        },
        LogicalRecord {
            entity_type: "reading-position".into(),
            key: publication_id.into(),
            revision: 2,
            value: serde_json::json!({ "publicationId": publication_id }),
        },
    ];
    let mut selected = HashSet::from([identity("publication-lifecycle", publication_id)]);
    prepare::expand_selected_dependencies(&records, &mut selected);
    assert!(selected.contains(&identity("reading-position", publication_id)));
}

#[test]
fn rejects_invalid_revision_ranges_and_package_descriptors() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../test-vectors/sync-model-v2.json"))
            .expect("sync model vector");
    let mut original: SyncBatch =
        serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    original.batch_id = "22222222-2222-4222-8222-222222222222".into();

    let mut invalid_range = original.clone();
    invalid_range.mode = "incremental".into();
    invalid_range.from_sender_revision_exclusive = None;
    invalid_range.inspected_peer_revision = None;
    assert!(validate_batch(&invalid_range, &invalid_range.recipient_device_id).is_err());

    let mut invalid_package = original;
    invalid_package.blobs[0].media_type = "application/zip".into();
    assert!(validate_batch(&invalid_package, &invalid_package.recipient_device_id).is_err());

    let mut invalid_revision: SyncBatch =
        serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    invalid_revision.batch_id = "22222222-2222-4222-8222-222222222222".into();
    invalid_revision.records[0].revision = invalid_revision.sender_revision + 1;
    assert!(validate_batch(&invalid_revision, &invalid_revision.recipient_device_id).is_err());

    let mut invalid_format: SyncBatch =
        serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    invalid_format.batch_id = "22222222-2222-4222-8222-222222222222".into();
    invalid_format.blobs[0].format_id = "../epub".into();
    assert!(validate_batch(&invalid_format, &invalid_format.recipient_device_id).is_err());

    let mut unsafe_publication: SyncBatch =
        serde_json::from_value(vector["batch"].clone()).expect("sync batch");
    unsafe_publication.batch_id = "22222222-2222-4222-8222-222222222222".into();
    let lifecycle = unsafe_publication
        .records
        .iter_mut()
        .find(|record| record.entity_type == "publication-lifecycle")
        .expect("lifecycle");
    lifecycle.key = "../../outside".into();
    lifecycle.value["publicationId"] = Value::String("../../outside".into());
    assert!(validate_batch(&unsafe_publication, &unsafe_publication.recipient_device_id).is_err());
}

#[test]
fn matches_the_shared_wire_v2_ndjson_vector() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../test-vectors/lan-sync-wire-v2-model-v4.json"
    ))
    .expect("wire vector");
    let batch: SyncBatch = serde_json::from_value(vector["batch"].clone()).expect("wire batch");
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("batch.ndjson");
    let (hash, bytes) = write_batch_payload(&path, &batch).expect("write NDJSON batch");

    assert_eq!(bytes, vector["expectedBatchNdjsonBytes"].as_u64().unwrap());
    assert_eq!(hash, vector["expectedBatchNdjsonSha256"].as_str().unwrap());
    assert_eq!(read_batch_payload(&path).expect("read NDJSON batch"), batch);
}

#[test]
fn wire_v2_ndjson_rejects_count_mismatch_and_oversized_line() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../test-vectors/lan-sync-wire-v2-model-v4.json"
    ))
    .expect("wire vector");
    let mut batch: SyncBatch = serde_json::from_value(vector["batch"].clone()).expect("wire batch");
    let directory = tempfile::tempdir().expect("temporary directory");
    let mismatch = directory.path().join("mismatch.ndjson");
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
        record_count: 2,
        blob_count: 0,
    };
    let mut encoded = serde_json::to_vec(&header).unwrap();
    encoded.push(b'\n');
    encoded.extend(
        serde_json::to_vec(&BatchRecordLine {
            kind: "record",
            record: &batch.records[0],
        })
        .unwrap(),
    );
    encoded.push(b'\n');
    fs::write(&mismatch, encoded).unwrap();
    assert!(read_batch_payload(&mismatch).is_err());

    batch.records[0].value = Value::String("x".repeat(MAX_NDJSON_LINE_BYTES));
    let oversized = directory.path().join("oversized.ndjson");
    assert!(write_batch_payload(&oversized, &batch).is_err());
    assert!(!oversized.with_extension("ndjson.part").exists());
}
