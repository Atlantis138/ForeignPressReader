use super::*;

pub fn validate_batch(batch: &SyncBatch, recipient_device_id: &str) -> Result<(), PlatformError> {
    if !matches!(
        batch.model_version,
        PREVIOUS_SYNC_MODEL_VERSION | 3 | SYNC_MODEL_VERSION
    ) || batch.recipient_device_id != recipient_device_id
        || !valid_sync_identifier(&batch.sender_device_id, batch.model_version)
        || batch.sender_device_id == recipient_device_id
        || !valid_sync_identifier(&batch.batch_id, batch.model_version)
        || batch.sender_revision < 0
        || !matches!(batch.mode.as_str(), "snapshot" | "incremental")
        || batch
            .from_sender_revision_exclusive
            .is_some_and(|revision| revision < 0 || revision > batch.sender_revision)
        || batch
            .inspected_peer_revision
            .is_some_and(|revision| revision < 0)
        || (batch.mode == "snapshot"
            && (batch.from_sender_revision_exclusive.is_some()
                || batch.inspected_peer_revision.is_some()))
        || (batch.mode == "incremental"
            && (batch.from_sender_revision_exclusive.is_none()
                || batch.inspected_peer_revision.is_none()))
        || chrono::DateTime::parse_from_rfc3339(&batch.created_at).is_err()
        || batch.records.len() > MAX_RECORDS
        || batch.blobs.len() > MAX_BLOBS
    {
        return Err(sync_invalid("同步批次信封无效。"));
    }
    let mut identities = HashSet::new();
    let mut present = HashMap::new();
    for record in &batch.records {
        if record.revision < 0
            || record.revision > batch.sender_revision
            || record.key.is_empty()
            || record.key.len() > 512
            || logical_key(&record.entity_type, &record.value)? != record.key
            || !identities.insert(identity(&record.entity_type, &record.key))
        {
            return Err(sync_invalid("同步逻辑记录无效或重复。"));
        }
        if record.entity_type == "setting"
            && crate::library_sync_settings::is_entity_key(&record.key)
            && (batch.model_version < 3
                || !record.value.get("value").is_some_and(|value| {
                    crate::library_sync_settings::valid_entity_setting(&record.key, value)
                }))
        {
            return Err(sync_invalid("同步书库细粒度记录无效。"));
        }
        if record.entity_type == "reader-record" {
            if batch.model_version < 4 {
                return Err(sync_invalid("阅读数据需要同步模型 v4。"));
            }
            crate::reader_records::validate(&record.value)?;
        }
        if record.entity_type == "publication-lifecycle" {
            let publication_id = required_string(&record.value, "publicationId")?;
            let hash = required_string(&record.value, "contentHash")?;
            let state = required_string(&record.value, "state")?;
            if !publication_package::is_safe_publication_id(publication_id)
                || !valid_sha256(hash)
                || !matches!(state, "present" | "deleted")
            {
                return Err(sync_invalid("同步刊物生命周期无效。"));
            }
            if state == "present" {
                present.insert(hash.to_owned(), record);
            }
        }
    }
    let mut hashes = HashSet::new();
    for blob in &batch.blobs {
        if blob.kind != "publication-package"
            || blob.media_type != "application/vnd.foreign-press-reader.publication+zip"
            || !publication_package::is_safe_publication_id(&blob.publication_id)
            || !valid_format_id(&blob.format_id)
            || !valid_sha256(&blob.sha256)
            || !valid_sha256(&blob.content_sha256)
            || blob.byte_length == 0
            || blob.byte_length > MAX_PACKAGE_BYTES
            || !hashes.insert(blob.sha256.clone())
        {
            return Err(sync_invalid("同步刊物内容包描述无效。"));
        }
        let lifecycle = present
            .get(&blob.content_sha256)
            .ok_or_else(|| sync_invalid("同步刊物内容包缺少生命周期记录。"))?;
        if required_string(&lifecycle.value, "publicationId")? != blob.publication_id
            || required_string(&lifecycle.value, "formatId")? != blob.format_id
        {
            return Err(sync_invalid("同步刊物内容包身份不一致。"));
        }
    }
    Ok(())
}

fn valid_format_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_sync_identifier(value: &str, model_version: i64) -> bool {
    if model_version >= 3 {
        return Uuid::parse_str(value).is_ok();
    }
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn stable_payload_sha256(batch: &SyncBatch) -> Result<String, PlatformError> {
    let value = serde_json::to_value(batch).map_err(|_| sync_invalid("同步批次无法序列化。"))?;
    Ok(hex::encode(Sha256::digest(
        canonical_json(&value).as_bytes(),
    )))
}

pub(super) fn export_logical_records(
    connection: &Connection,
    revisions: &HashMap<String, i64>,
    selection: Option<&[SyncEntityRef]>,
) -> Result<Vec<LogicalRecord>, PlatformError> {
    let mut selected_tables: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(refs) = selection {
        for item in refs {
            selected_tables
                .entry(entity_table(&item.entity_type)?.to_owned())
                .or_default()
                .push(item.key.clone());
        }
    }
    mobile_portable::sync_export_raw_records(connection, selection.map(|_| &selected_tables))?
        .into_iter()
        .filter(|raw| {
            raw.table != "settings"
                || raw.record.get("key").and_then(Value::as_str) != Some("library.management")
        })
        .map(|raw| {
            let (entity_type, key) = raw_identity(&raw)?;
            let value = raw_to_logical_value(&raw)?;
            Ok(LogicalRecord {
                revision: *revisions.get(&identity(entity_type, &key)).unwrap_or(&0),
                entity_type: entity_type.into(),
                key,
                value,
            })
        })
        .collect()
}

fn raw_identity(raw: &SyncRawRecord) -> Result<(&'static str, String), PlatformError> {
    let (entity_type, keys): (&str, &[&str]) = match raw.table.as_str() {
        "publication_lifecycle" => ("publication-lifecycle", &["publicationId"]),
        "settings" => ("setting", &["key"]),
        "reader_records" => ("reader-record", &["recordId"]),
        "reading_positions" => ("reading-position", &["publicationId"]),
        "user_lexemes" => ("user-lexeme", &["lexemeKey"]),
        "lexeme_examples" => ("lexeme-example", &["exampleId"]),
        "vocabulary_sources" => ("vocabulary-source", &["sourceId"]),
        "saved_contexts" => ("saved-context", &["contextId"]),
        "study_plans" => ("study-plan", &["planId"]),
        "study_plan_sources" => ("study-plan-source", &["sourceId"]),
        "study_plan_lexeme_origins" => ("study-plan-origin", &["originId"]),
        "study_plan_exclusions" => ("study-plan-exclusion", &["planId", "lexemeKey"]),
        "scheduler_profiles" => ("scheduler-profile", &["profileId"]),
        "review_cards" => ("review-card", &["lexemeKey"]),
        "review_events" => ("review-event", &["eventId"]),
        "reinforcement_events" => ("reinforcement-event", &["eventId"]),
        "review_suspensions" => ("review-suspension", &["lexemeKey"]),
        "study_progress_state" => ("study-progress-state", &["stateId"]),
        "study_lexeme_resets" => ("study-lexeme-reset", &["lexemeKey"]),
        _ => return Err(sync_invalid("未知同步数据表。")),
    };
    let values = keys
        .iter()
        .map(|key| {
            raw.record
                .get(*key)
                .and_then(Value::as_str)
                .ok_or_else(|| sync_invalid("同步记录缺少稳定标识。"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((entity_type, values.join("\u{1f}")))
}

fn raw_to_logical_value(raw: &SyncRawRecord) -> Result<Value, PlatformError> {
    let mut value = raw.record.clone();
    match raw.table.as_str() {
        "publication_lifecycle" => rename(&mut value, "titleSnapshot", "title"),
        "settings" => {
            let encoded = value
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| sync_invalid("同步设置记录无效。"))?;
            let parsed: Value =
                serde_json::from_str(encoded).map_err(|_| sync_invalid("同步设置 JSON 无效。"))?;
            let key = value.get("key").and_then(Value::as_str).unwrap_or("");
            value.insert("value".into(), project_setting(key, parsed));
        }
        "reading_positions" => {
            rename(&mut value, "anchorBlockId", "blockId");
            rename(&mut value, "anchorTokenIndex", "tokenIndex");
            rename(&mut value, "anchorFraction", "blockFraction");
        }
        "user_lexemes" => {
            parse_json_field(&mut value, "briefMeaningsJson", "briefMeanings")?;
            parse_json_field(&mut value, "senseGroupsJson", "senseGroups")?;
        }
        "saved_contexts" => {
            rename(&mut value, "publicationTitle", "publicationTitle");
            rename(&mut value, "articleTitle", "articleTitle");
        }
        _ => {}
    }
    Ok(Value::Object(value))
}

pub(super) fn logical_to_raw(
    connection: &Connection,
    logical: &LogicalRecord,
) -> Result<SyncRawRecord, PlatformError> {
    let table = entity_table(&logical.entity_type)?;
    let Value::Object(mut record) = logical.value.clone() else {
        return Err(sync_invalid("同步记录值必须是对象。"));
    };
    match logical.entity_type.as_str() {
        "publication-lifecycle" => rename(&mut record, "title", "titleSnapshot"),
        "setting" => {
            let key = record
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| sync_invalid("同步设置缺少标识。"))?;
            let incoming = record
                .get("value")
                .cloned()
                .ok_or_else(|| sync_invalid("同步设置缺少值。"))?;
            let merged = merge_setting_projection(connection, key, incoming)?;
            record.insert("value".into(), Value::String(canonical_json(&merged)));
        }
        "reading-position" => {
            rename(&mut record, "blockId", "anchorBlockId");
            rename(&mut record, "tokenIndex", "anchorTokenIndex");
            rename(&mut record, "blockFraction", "anchorFraction");
        }
        "user-lexeme" => {
            encode_json_field(&mut record, "briefMeanings", "briefMeaningsJson")?;
            encode_json_field(&mut record, "senseGroups", "senseGroupsJson")?;
        }
        _ => {}
    }
    Ok(SyncRawRecord {
        table: table.into(),
        record,
    })
}

pub(super) fn table_entity(table: &str) -> Result<&'static str, PlatformError> {
    match table {
        "publication_lifecycle" => Ok("publication-lifecycle"),
        "settings" => Ok("setting"),
        "reader_records" => Ok("reader-record"),
        "reading_positions" => Ok("reading-position"),
        "user_lexemes" => Ok("user-lexeme"),
        "lexeme_examples" => Ok("lexeme-example"),
        "vocabulary_sources" => Ok("vocabulary-source"),
        "saved_contexts" => Ok("saved-context"),
        "study_plans" => Ok("study-plan"),
        "study_plan_sources" => Ok("study-plan-source"),
        "study_plan_lexeme_origins" => Ok("study-plan-origin"),
        "study_plan_exclusions" => Ok("study-plan-exclusion"),
        "scheduler_profiles" => Ok("scheduler-profile"),
        "review_cards" => Ok("review-card"),
        "review_events" => Ok("review-event"),
        "reinforcement_events" => Ok("reinforcement-event"),
        "review_suspensions" => Ok("review-suspension"),
        "study_progress_state" => Ok("study-progress-state"),
        "study_lexeme_resets" => Ok("study-lexeme-reset"),
        _ => Err(sync_invalid("未知同步 revision 类型。")),
    }
}

fn entity_table(entity_type: &str) -> Result<&'static str, PlatformError> {
    match entity_type {
        "publication-lifecycle" => Ok("publication_lifecycle"),
        "setting" => Ok("settings"),
        "reader-record" => Ok("reader_records"),
        "reading-position" => Ok("reading_positions"),
        "user-lexeme" => Ok("user_lexemes"),
        "lexeme-example" => Ok("lexeme_examples"),
        "vocabulary-source" => Ok("vocabulary_sources"),
        "saved-context" => Ok("saved_contexts"),
        "study-plan" => Ok("study_plans"),
        "study-plan-source" => Ok("study_plan_sources"),
        "study-plan-origin" => Ok("study_plan_lexeme_origins"),
        "study-plan-exclusion" => Ok("study_plan_exclusions"),
        "scheduler-profile" => Ok("scheduler_profiles"),
        "review-card" => Ok("review_cards"),
        "review-event" => Ok("review_events"),
        "reinforcement-event" => Ok("reinforcement_events"),
        "review-suspension" => Ok("review_suspensions"),
        "study-progress-state" => Ok("study_progress_state"),
        "study-lexeme-reset" => Ok("study_lexeme_resets"),
        _ => Err(sync_invalid("未知同步实体类型。")),
    }
}

fn logical_key(entity_type: &str, value: &Value) -> Result<String, PlatformError> {
    let fields: &[&str] = match entity_type {
        "publication-lifecycle" => &["publicationId"],
        "setting" => &["key"],
        "reader-record" => &["recordId"],
        "reading-position" => &["publicationId"],
        "user-lexeme" => &["lexemeKey"],
        "lexeme-example" => &["exampleId"],
        "vocabulary-source" => &["sourceId"],
        "saved-context" => &["contextId"],
        "study-plan" => &["planId"],
        "study-plan-source" => &["sourceId"],
        "study-plan-origin" => &["originId"],
        "study-plan-exclusion" => &["planId", "lexemeKey"],
        "scheduler-profile" => &["profileId"],
        "review-card" => &["lexemeKey"],
        "review-event" | "reinforcement-event" => &["eventId"],
        "review-suspension" => &["lexemeKey"],
        "study-progress-state" => &["stateId"],
        "study-lexeme-reset" => &["lexemeKey"],
        _ => return Err(sync_invalid("未知同步实体类型。")),
    };
    fields
        .iter()
        .map(|field| required_string(value, field).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("\u{1f}"))
}

fn project_setting(key: &str, value: Value) -> Value {
    let Value::Object(object) = value else {
        return value;
    };
    let fields: &[&str] = match key {
        "reader.preferences" => &["theme", "fontSize", "lineHeight", "paperTint"],
        "speech.preferences" => &[
            "locale",
            "rate",
            "autoPlayStudy",
            "wordProviderId",
            "articleProviderId",
            "providerSettings",
        ],
        "library.management" => &["categories", "items"],
        _ => return Value::Object(object),
    };
    Value::Object(
        fields
            .iter()
            .filter_map(|key| {
                object
                    .get(*key)
                    .cloned()
                    .map(|value| ((*key).into(), value))
            })
            .collect(),
    )
}

fn merge_setting_projection(
    connection: &Connection,
    key: &str,
    incoming: Value,
) -> Result<Value, PlatformError> {
    if !matches!(
        key,
        "reader.preferences" | "speech.preferences" | "library.management"
    ) {
        return Ok(incoming);
    }
    let current: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut result = current
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Value::Object(incoming) = incoming {
        result.extend(incoming);
        Ok(Value::Object(result))
    } else {
        Ok(incoming)
    }
}

pub(super) fn compare_records(left: &LogicalRecord, right: &LogicalRecord) -> std::cmp::Ordering {
    dependency_rank(left)
        .cmp(&dependency_rank(right))
        .then_with(|| left.entity_type.cmp(&right.entity_type))
        .then_with(|| left.key.cmp(&right.key))
        .then_with(|| left.revision.cmp(&right.revision))
}

fn dependency_rank(record: &LogicalRecord) -> i32 {
    if record.entity_type == "publication-lifecycle" {
        return if record.value.get("state").and_then(Value::as_str) == Some("deleted") {
            100
        } else {
            0
        };
    }
    match record.entity_type.as_str() {
        "setting" => 5,
        "user-lexeme" => 10,
        "lexeme-example" => 12,
        "reader-record" => 16,
        "reading-position" => 15,
        "saved-context" | "vocabulary-source" => 20,
        "study-plan" => 30,
        "study-plan-source" => 40,
        "study-plan-origin" | "study-plan-exclusion" => 50,
        "scheduler-profile" => 55,
        "review-card" | "review-suspension" => 60,
        "review-event" | "reinforcement-event" => 70,
        "study-progress-state" | "study-lexeme-reset" => 90,
        _ => 80,
    }
}

pub(super) fn record_ref(record: &LogicalRecord) -> SyncEntityRef {
    SyncEntityRef {
        entity_type: record.entity_type.clone(),
        key: record.key.clone(),
        revision: record.revision,
    }
}

pub(super) fn identity(entity_type: &str, key: &str) -> String {
    format!("{entity_type}\0{key}")
}

pub(super) fn immutable_entity(entity_type: &str) -> bool {
    matches!(
        entity_type,
        "scheduler-profile" | "review-event" | "reinforcement-event"
    )
}

pub(super) fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, PlatformError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| sync_invalid("同步记录缺少必需字符串字段。"))
}

fn rename(object: &mut Map<String, Value>, from: &str, to: &str) {
    if from == to {
        return;
    }
    if let Some(value) = object.remove(from) {
        object.insert(to.into(), value);
    }
}

fn parse_json_field(
    object: &mut Map<String, Value>,
    from: &str,
    to: &str,
) -> Result<(), PlatformError> {
    let encoded = object
        .remove(from)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| sync_invalid("同步 JSON 字段无效。"))?;
    let parsed =
        serde_json::from_str(&encoded).map_err(|_| sync_invalid("同步 JSON 字段无效。"))?;
    object.insert(to.into(), parsed);
    Ok(())
}

fn encode_json_field(
    object: &mut Map<String, Value>,
    from: &str,
    to: &str,
) -> Result<(), PlatformError> {
    let value = object
        .remove(from)
        .ok_or_else(|| sync_invalid("同步 JSON 字段缺失。"))?;
    object.insert(to.into(), Value::String(canonical_json(&value)));
    Ok(())
}

pub(super) fn sync_invalid(message: &'static str) -> PlatformError {
    PlatformError::new("syncInvalid", message, false)
}
