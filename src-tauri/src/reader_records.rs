use crate::{database::AndroidDatabase, platform_error::PlatformError};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn invalid() -> PlatformError {
    PlatformError::new("invalidReadingData", "阅读数据无效。", false)
}
fn safe_id(value: &str) -> bool {
    (8..=100).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, PlatformError> {
    value.get(key).and_then(Value::as_str).ok_or_else(invalid)
}

pub fn validate(record: &Value) -> Result<(), PlatformError> {
    if record.as_object().map_or(true, |v| v.len() != 7)
        || !safe_id(text(record, "publicationId")?)
        || !safe_id(text(record, "articleId")?)
        || text(record, "recordId")?.len() > 250
        || text(record, "payload")?.encode_utf16().count() > 512_000
        || (text(record, "deviceId")?.is_empty()
            || text(record, "deviceId")?.encode_utf16().count() > 100)
        || chrono::DateTime::parse_from_rfc3339(text(record, "updatedAt")?).is_err()
    {
        return Err(invalid());
    }
    let value: Value = serde_json::from_str(text(record, "payload")?).map_err(|_| invalid())?;
    let kind = text(record, "kind")?;
    let valid = match kind {
        "position" => {
            value.as_object().is_some_and(|v| v.len() == 4)
                && value
                    .get("scrollTop")
                    .and_then(Value::as_f64)
                    .is_some_and(|n| n.is_finite() && n >= 0.0)
                && value
                    .get("anchorFraction")
                    .and_then(Value::as_f64)
                    .is_some_and(|n| (0.0..=1.0).contains(&n))
                && value
                    .get("anchorBlockId")
                    .is_some_and(|v| v.is_null() || v.as_str().is_some_and(safe_id))
                && value.get("anchorTokenIndex").is_some_and(|v| {
                    v.is_null() || v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                })
        }
        "bookmark" | "read" => value.is_boolean(),
        "translation-selection" => value.is_null() || value.as_str().is_some_and(safe_id),
        "translation" => {
            let version = text(&value, "versionId")?;
            let block = text(&value, "blockId")?;
            let hash = text(&value, "sourceHash")?;
            if value.as_object().map_or(true, |v| v.len() != 6)
                || !safe_id(version)
                || !safe_id(block)
                || hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                || text(&value, "text")?.trim().is_empty()
                || text(record, "recordId")? != format!("translation:{version}:{block}")
            {
                return Err(invalid());
            }
            text(&value, "model")?;
            text(&value, "promptVersion")?;
            return Ok(());
        }
        _ => false,
    };
    if !valid || text(record, "recordId")? != format!("{}:{}", kind, text(record, "articleId")?) {
        return Err(invalid());
    }
    Ok(())
}

fn value(database: &AndroidDatabase, record_id: &str) -> Result<Value, PlatformError> {
    let encoded: Option<String> = database
        .connection()
        .query_row(
            "SELECT payload FROM reader_records WHERE record_id=?1",
            [record_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    match encoded {
        Some(v) => serde_json::from_str(&v).map_err(|_| PlatformError::database_corrupt()),
        None => Ok(Value::Null),
    }
}
fn publication_id(database: &AndroidDatabase, article_id: &str) -> Result<String, PlatformError> {
    database
        .connection()
        .query_row(
            "SELECT publication_id FROM articles WHERE id=?1",
            [article_id],
            |r| r.get(0),
        )
        .map_err(|_| invalid())
}
fn write(
    database: &AndroidDatabase,
    article_id: &str,
    kind: &str,
    payload: Value,
    record_id: &str,
    updated_at: &str,
) -> Result<(), PlatformError> {
    let publication_id = publication_id(database, article_id)?;
    let encoded = payload.to_string();
    validate(
        &json!({"recordId":record_id,"publicationId":publication_id,"articleId":article_id,"kind":kind,"payload":encoded,"updatedAt":updated_at,"deviceId":database.device_id()}),
    )?;
    database.connection().execute("INSERT INTO reader_records(record_id,publication_id,article_id,kind,payload,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(record_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,device_id=excluded.device_id WHERE reader_records.payload<>excluded.payload",params![record_id,publication_id,article_id,kind,encoded,updated_at,database.device_id()]).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}
pub fn position(
    database: &AndroidDatabase,
    article_id: &str,
) -> Result<Option<crate::mobile_reading::ReadingPosition>, PlatformError> {
    let v = value(database, &format!("position:{article_id}"))?;
    if v.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(v)
            .map(Some)
            .map_err(|_| PlatformError::database_corrupt())
    }
}
pub fn selected(
    database: &AndroidDatabase,
    article_id: &str,
) -> Result<Option<std::collections::HashMap<String, Value>>, PlatformError> {
    let v = value(database, &format!("translation-selection:{article_id}"))?;
    let Some(version) = v.as_str() else {
        return Ok(None);
    };
    let mut statement = database.connection().prepare("SELECT payload FROM reader_records WHERE article_id=?1 AND kind='translation' AND json_extract(payload,'$.versionId')=?2").map_err(|_| PlatformError::database_corrupt())?;
    let values = statement
        .query_map(params![article_id, version], |r| r.get::<_, String>(0))
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut result = std::collections::HashMap::new();
    for row in values {
        let segment: Value =
            serde_json::from_str(&row.map_err(|_| PlatformError::database_corrupt())?)
                .map_err(|_| invalid())?;
        result.insert(text(&segment, "blockId")?.to_owned(), segment);
    }
    Ok(Some(result))
}
pub fn get(database: &AndroidDatabase, article_id: &str) -> Result<Value, PlatformError> {
    publication_id(database, article_id)?;
    let mut statement = database.connection().prepare("SELECT json_extract(payload,'$.versionId'),min(updated_at),json_group_array(DISTINCT json_extract(payload,'$.model')),count(*) FROM reader_records WHERE article_id=?1 AND kind='translation' GROUP BY json_extract(payload,'$.versionId') ORDER BY min(updated_at) DESC,json_extract(payload,'$.versionId')").map_err(|_| PlatformError::database_corrupt())?;
    let versions = statement.query_map([article_id],|r| Ok(json!({"id":r.get::<_,String>(0)?,"createdAt":r.get::<_,String>(1)?,"models":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!([])),"segmentCount":r.get::<_,i64>(3)?}))).map_err(|_| PlatformError::database_corrupt())?.collect::<Result<Vec<_>,_>>().map_err(|_| PlatformError::database_corrupt())?;
    Ok(
        json!({"bookmarked":value(database,&format!("bookmark:{article_id}"))?==true,"read":value(database,&format!("read:{article_id}"))?==true,"selectedVersionId":value(database,&format!("translation-selection:{article_id}"))?,"versions":versions}),
    )
}
pub fn change(
    database: &AndroidDatabase,
    article_id: &str,
    change: &Value,
) -> Result<Value, PlatformError> {
    let kind = text(change, "kind")?;
    if kind == "preserve-translation" {
        preserve(database, article_id)?;
    } else {
        if !matches!(kind, "bookmark" | "read" | "translation-selection") {
            return Err(invalid());
        }
        let payload = change.get("value").ok_or_else(invalid)?;
        if kind == "translation-selection"
            && !payload.is_null()
            && !get(database, article_id)?["versions"]
                .as_array()
                .is_some_and(|versions| versions.iter().any(|v| &v["id"] == payload))
        {
            return Err(invalid());
        }
        write(
            database,
            article_id,
            kind,
            payload.clone(),
            &format!("{kind}:{article_id}"),
            &Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )?;
    }
    get(database, article_id)
}
pub fn preserve(
    database: &AndroidDatabase,
    article_id: &str,
) -> Result<Option<String>, PlatformError> {
    publication_id(database, article_id)?;
    let mut statement = database.connection().prepare("SELECT b.id,b.text,t.source_hash,t.model,t.prompt_version,t.text FROM blocks b JOIN translations t ON t.rowid=(SELECT t2.rowid FROM translations t2 WHERE t2.block_id=b.id AND t2.target_language='zh-CN' ORDER BY t2.created_at DESC,t2.model,t2.prompt_version LIMIT 1) WHERE b.article_id=?1 ORDER BY b.id").map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([article_id], |r| {
            Ok([
                r.get::<_, String>(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ])
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let segments: Vec<_> = rows
        .into_iter()
        .filter(|r| hex::encode(Sha256::digest(r[1].as_bytes())) == r[2])
        .map(|r| {
            [
                r[0].clone(),
                r[2].clone(),
                r[3].clone(),
                r[4].clone(),
                r[5].clone(),
            ]
        })
        .collect();
    if segments.is_empty() {
        return Ok(None);
    }
    let version = hex::encode(Sha256::digest(
        json!([article_id, segments]).to_string().as_bytes(),
    ));
    let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    database
        .connection()
        .execute_batch("SAVEPOINT preserve_translation")
        .map_err(|_| PlatformError::storage_unavailable())?;
    let result: Result<(), PlatformError> = (|| {
        for [block, hash, model, prompt, text] in &segments {
            let record_id = format!("translation:{version}:{block}");
            if value(database, &record_id)?.is_null() {
                write(
                    database,
                    article_id,
                    "translation",
                    json!({"versionId":version,"blockId":block,"sourceHash":hash,"model":model,"promptVersion":prompt,"text":text}),
                    &record_id,
                    &timestamp,
                )?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = database
            .connection()
            .execute_batch("ROLLBACK TO preserve_translation");
    }
    database
        .connection()
        .execute_batch("RELEASE preserve_translation")
        .map_err(|_| PlatformError::storage_unavailable())?;
    result?;
    Ok(Some(version))
}

pub fn search(database: &AndroidDatabase, query: &Value) -> Result<Value, PlatformError> {
    let input = text(query, "text")?;
    let filter = text(query, "filter")?;
    let offset = query
        .get("offset")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or_else(invalid)?;
    let limit = query
        .get("limit")
        .and_then(Value::as_i64)
        .filter(|n| (1..=100).contains(n))
        .ok_or_else(invalid)?;
    if input.chars().count() > 500 || !matches!(filter, "all" | "bookmarked" | "read" | "unread") {
        return Err(invalid());
    }
    let terms: Vec<_> = input
        .split_whitespace()
        .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
        .collect();
    let bookmark = "EXISTS(SELECT 1 FROM reader_records r WHERE r.record_id='bookmark:'||a.id AND r.payload='true')";
    let read = "EXISTS(SELECT 1 FROM reader_records r WHERE r.record_id='read:'||a.id AND r.payload='true')";
    let filter_sql = match filter {
        "bookmarked" => bookmark.to_owned(),
        "read" => read.to_owned(),
        "unread" => format!("NOT {read}"),
        _ => "1".into(),
    };
    let where_sql = format!("WHERE {filter_sql} AND (?1='' OR a.title LIKE ?2 ESCAPE '\\' OR a.id IN (SELECT b.article_id FROM reader_search JOIN blocks b ON b.rowid=reader_search.rowid WHERE reader_search MATCH ?3))");
    let pattern = format!(
        "%{}%",
        input
            .trim()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let match_query = if terms.is_empty() {
        "\"\"".to_owned()
    } else {
        terms.join(" AND ")
    };
    let total: i64 = database
        .connection()
        .query_row(
            &format!("SELECT count(*) FROM articles a {where_sql}"),
            params![input.trim(), pattern, match_query],
            |r| r.get(0),
        )
        .map_err(|_| invalid())?;
    let sql = format!("SELECT a.id,a.publication_id,a.title,p.title,{bookmark},{read},COALESCE((SELECT substr(b.text,1,220) FROM blocks b WHERE b.article_id=a.id AND b.text IS NOT NULL AND b.type<>'heading' ORDER BY b.position LIMIT 1),'') FROM articles a JOIN publications p ON p.id=a.publication_id {where_sql} ORDER BY p.imported_at DESC,a.position,a.id LIMIT ?4 OFFSET ?5");
    let mut statement = database
        .connection()
        .prepare(&sql)
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement.query_map(params![input.trim(),pattern,match_query,limit,offset],|r| Ok(json!({"articleId":r.get::<_,String>(0)?,"publicationId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"publicationTitle":r.get::<_,String>(3)?,"bookmarked":r.get::<_,bool>(4)?,"read":r.get::<_,bool>(5)?,"excerpt":r.get::<_,String>(6)?}))).map_err(|_| invalid())?.collect::<Result<Vec<_>,_>>().map_err(|_| PlatformError::database_corrupt())?;
    Ok(json!({"items":rows,"total":total,"offset":offset,"limit":limit}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mobile_reading, platform_paths::PlatformPaths};
    #[test]
    fn shared_reader_vector_survives_cache_clear_and_search_and_marks() {
        let root = tempfile::tempdir().unwrap();
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().unwrap();
        let mut db = AndroidDatabase::open(&paths, "test").unwrap();
        let content: Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-content-v2.json")).unwrap();
        let plan: mobile_reading::ParsedPublicationPlan =
            serde_json::from_value(content["expectedPlan"].clone()).unwrap();
        mobile_reading::commit_publication(&mut db, &plan, "epub", || Ok(())).unwrap();
        let vector: Value =
            serde_json::from_str(include_str!("../../test-vectors/reader-records-v4.json"))
                .unwrap();
        validate(&vector["record"]).unwrap();
        assert_eq!(
            crate::publication_repair::content_hash(&db, &plan.id).unwrap(),
            vector["publicationContentHash"].as_str().unwrap()
        );
        let article = vector["articleId"].as_str().unwrap();
        db.connection().execute("INSERT INTO translations(block_id,source_hash,target_language,model,prompt_version,text,created_at) VALUES(?1,?2,'zh-CN',?3,?4,?5,'2026-09-06T00:00:00Z')",params![vector["blockId"].as_str().unwrap(),vector["sourceHash"].as_str().unwrap(),vector["model"].as_str().unwrap(),vector["promptVersion"].as_str().unwrap(),vector["translation"].as_str().unwrap()]).unwrap();
        assert_eq!(
            preserve(&db, article).unwrap().unwrap(),
            vector["versionId"].as_str().unwrap()
        );
        let payload: String = db
            .connection()
            .query_row(
                "SELECT payload FROM reader_records WHERE kind='translation'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(payload, vector["record"]["payload"].as_str().unwrap());
        change(
            &db,
            article,
            &json!({"kind":"translation-selection","value":vector["versionId"]}),
        )
        .unwrap();
        change(&db, article, &json!({"kind":"bookmark","value":true})).unwrap();
        db.connection()
            .execute("DELETE FROM translations", [])
            .unwrap();
        assert!(get(&db, article).unwrap()["bookmarked"].as_bool().unwrap());
        assert_eq!(
            selected(&db, article).unwrap().unwrap()[vector["blockId"].as_str().unwrap()]["text"],
            vector["translation"]
        );
        let results = search(
            &db,
            &json!({"text":"","filter":"bookmarked","offset":0,"limit":30}),
        )
        .unwrap();
        assert_eq!(results["total"], 1);
        let mut invalid = vector["record"].clone();
        invalid["payload"] = json!("true");
        assert!(validate(&invalid).is_err());
    }
}
