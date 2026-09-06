use crate::platform_error::PlatformError;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

pub const CATEGORY_PREFIX: &str = "library.category.";
pub const ITEM_PREFIX: &str = "library.item.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CategoryValue {
    id: String,
    name: String,
    created_at: String,
    state: String,
    deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemValue {
    publication_id: String,
    custom_title: Option<String>,
    category_id: Option<String>,
    state: String,
    deleted_at: Option<String>,
}

#[derive(Debug, Clone)]
struct Stored<T> {
    key: String,
    value: T,
    updated_at: String,
}

pub fn is_entity_key(key: &str) -> bool {
    key.starts_with(CATEGORY_PREFIX) || key.starts_with(ITEM_PREFIX)
}

pub fn valid_entity_setting(key: &str, value: &Value) -> bool {
    parse_category(key, value).is_some() || parse_item(key, value).is_some()
}

pub fn write_management(
    connection: &Connection,
    device_id: &str,
    management: &Value,
) -> Result<(), PlatformError> {
    connection
        .execute_batch("SAVEPOINT library_management_sync")
        .map_err(|_| PlatformError::storage_unavailable())?;
    let result = (|| {
        let timestamp = now();
        synchronize_fine_grained(connection, management, &timestamp, device_id)?;
        write_management_mirror(connection, management, &timestamp, device_id)
    })();
    match result {
        Ok(()) => connection
            .execute_batch("RELEASE SAVEPOINT library_management_sync")
            .map_err(|_| PlatformError::storage_unavailable()),
        Err(error) => {
            let _ = connection.execute_batch(
                "ROLLBACK TO SAVEPOINT library_management_sync; RELEASE SAVEPOINT library_management_sync",
            );
            Err(error)
        }
    }
}

pub fn reconcile(
    connection: &Connection,
    fine_grained_authoritative: bool,
    legacy_management_changed: bool,
) -> Result<(), PlatformError> {
    if !fine_grained_authoritative && !legacy_management_changed {
        return Ok(());
    }
    if legacy_management_changed && !fine_grained_authoritative {
        if let Some((encoded, updated_at, device_id)) = management_row(connection)? {
            let value = serde_json::from_str::<Value>(&encoded)
                .unwrap_or_else(|_| Value::Object(Map::new()));
            synchronize_fine_grained(connection, &value, &updated_at, &device_id)?;
        }
    }
    rebuild_management_mirror(connection)
}

fn synchronize_fine_grained(
    connection: &Connection,
    management: &Value,
    updated_at: &str,
    device_id: &str,
) -> Result<(), PlatformError> {
    let existing_categories = read_categories(connection)?;
    let existing_items = read_items(connection)?;
    let mut current = HashSet::new();

    if let Some(categories) = management.get("categories").and_then(Value::as_array) {
        for category in categories {
            let Some(id) = category
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_category_id(id))
            else {
                continue;
            };
            let name = normalize_text(category.get("name").and_then(Value::as_str), 100);
            if name.is_empty() {
                continue;
            }
            let created_at = category
                .get("createdAt")
                .and_then(Value::as_str)
                .filter(|value| valid_timestamp(value))
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_owned();
            let key = format!("{CATEGORY_PREFIX}{id}");
            current.insert(key.clone());
            upsert(
                connection,
                &key,
                &CategoryValue {
                    id: id.to_owned(),
                    name,
                    created_at,
                    state: "present".into(),
                    deleted_at: None,
                },
                updated_at,
                device_id,
            )?;
        }
    }
    for stored in existing_categories.values() {
        if current.contains(&stored.key) || stored.value.state == "deleted" {
            continue;
        }
        let mut deleted = stored.value.clone();
        deleted.state = "deleted".into();
        deleted.deleted_at = Some(updated_at.to_owned());
        upsert(connection, &stored.key, &deleted, updated_at, device_id)?;
    }

    current.clear();
    if let Some(items) = management.get("items").and_then(Value::as_object) {
        for (publication_id, item) in items {
            if !is_publication_id(publication_id) {
                continue;
            }
            let custom_title = item
                .get("customTitle")
                .and_then(Value::as_str)
                .map(|value| normalize_text(Some(value), 200))
                .filter(|value| !value.is_empty());
            let category_id = item
                .get("categoryId")
                .and_then(Value::as_str)
                .filter(|value| is_category_id(value))
                .map(str::to_owned);
            if custom_title.is_none() && category_id.is_none() {
                continue;
            }
            let key = format!("{ITEM_PREFIX}{publication_id}");
            current.insert(key.clone());
            upsert(
                connection,
                &key,
                &ItemValue {
                    publication_id: publication_id.clone(),
                    custom_title,
                    category_id,
                    state: "present".into(),
                    deleted_at: None,
                },
                updated_at,
                device_id,
            )?;
        }
    }
    for stored in existing_items.values() {
        if current.contains(&stored.key) || stored.value.state == "deleted" {
            continue;
        }
        let mut deleted = stored.value.clone();
        deleted.state = "deleted".into();
        deleted.deleted_at = Some(updated_at.to_owned());
        upsert(connection, &stored.key, &deleted, updated_at, device_id)?;
    }
    Ok(())
}

fn rebuild_management_mirror(connection: &Connection) -> Result<(), PlatformError> {
    let category_settings = read_categories(connection)?;
    let mut categories = category_settings
        .values()
        .filter(|stored| stored.value.state == "present")
        .map(|stored| stored.value.clone())
        .collect::<Vec<_>>();
    categories.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let category_ids = categories
        .iter()
        .map(|value| value.id.clone())
        .collect::<HashSet<_>>();
    let deleted_categories = category_settings
        .values()
        .filter(|stored| stored.value.state == "deleted")
        .map(|stored| (stored.value.id.clone(), stored.clone()))
        .collect::<BTreeMap<_, _>>();

    for stored in read_items(connection)?.values() {
        let Some(category_id) = stored.value.category_id.as_deref() else {
            continue;
        };
        if stored.value.state != "present" || category_ids.contains(category_id) {
            continue;
        }
        let changed_at = next_derived_timestamp([
            Some(stored.updated_at.as_str()),
            deleted_categories
                .get(category_id)
                .map(|category| category.updated_at.as_str()),
        ]);
        let changed_by = local_device_id(connection)?;
        let mut next = stored.value.clone();
        next.category_id = None;
        if next.custom_title.is_none() {
            next.state = "deleted".into();
            next.deleted_at = Some(changed_at.clone());
        }
        upsert(connection, &stored.key, &next, &changed_at, &changed_by)?;
    }

    let mut management = management_row(connection)?
        .and_then(|(encoded, _, _)| serde_json::from_str::<Value>(&encoded).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let categories = disambiguate_names(categories)
        .into_iter()
        .map(|category| {
            serde_json::json!({
                "id": category.id,
                "name": category.name,
                "createdAt": category.created_at,
            })
        })
        .collect::<Vec<_>>();
    let mut items = Map::new();
    for stored in read_items(connection)?.values() {
        if stored.value.state != "present" {
            continue;
        }
        let category_id = stored
            .value
            .category_id
            .as_ref()
            .filter(|id| category_ids.contains(*id))
            .cloned();
        if stored.value.custom_title.is_some() || category_id.is_some() {
            items.insert(
                stored.value.publication_id.clone(),
                serde_json::json!({
                    "customTitle": stored.value.custom_title,
                    "categoryId": category_id,
                }),
            );
        }
    }
    let active = management
        .get("activeCategoryId")
        .and_then(Value::as_str)
        .filter(|value| {
            *value == "all" || *value == "uncategorized" || category_ids.contains(*value)
        })
        .unwrap_or("all")
        .to_owned();
    management.insert("activeCategoryId".into(), Value::String(active));
    management.insert("categories".into(), Value::Array(categories));
    management.insert("items".into(), Value::Object(items));
    write_management_mirror(
        connection,
        &Value::Object(management),
        &now(),
        &local_device_id(connection)?,
    )
}

fn disambiguate_names(mut categories: Vec<CategoryValue>) -> Vec<CategoryValue> {
    categories.sort_by(|left, right| left.id.cmp(&right.id));
    let mut used = HashSet::new();
    for category in &mut categories {
        let mut name = category.name.clone();
        let mut folded = name.to_lowercase();
        if used.contains(&folded) {
            let suffix = format!(" ({})", &category.id[category.id.len().saturating_sub(6)..]);
            name = truncate_chars(&name, 100_usize.saturating_sub(suffix.chars().count()));
            name.push_str(&suffix);
            folded = name.to_lowercase();
            let mut index = 2;
            while used.contains(&folded) {
                let suffix = format!(" {index}");
                index += 1;
                name = truncate_chars(&name, 100_usize.saturating_sub(suffix.chars().count()));
                name.push_str(&suffix);
                folded = name.to_lowercase();
            }
        }
        used.insert(folded);
        category.name = name;
    }
    categories.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    categories
}

fn read_categories(
    connection: &Connection,
) -> Result<BTreeMap<String, Stored<CategoryValue>>, PlatformError> {
    let mut result = BTreeMap::new();
    for row in read_rows(connection, CATEGORY_PREFIX)? {
        if let Ok(value) = serde_json::from_str::<Value>(&row.1) {
            if let Some(value) = parse_category(&row.0, &value) {
                result.insert(
                    row.0.clone(),
                    Stored {
                        key: row.0,
                        value,
                        updated_at: row.2,
                    },
                );
            }
        }
    }
    Ok(result)
}

fn read_items(
    connection: &Connection,
) -> Result<BTreeMap<String, Stored<ItemValue>>, PlatformError> {
    let mut result = BTreeMap::new();
    for row in read_rows(connection, ITEM_PREFIX)? {
        if let Ok(value) = serde_json::from_str::<Value>(&row.1) {
            if let Some(value) = parse_item(&row.0, &value) {
                result.insert(
                    row.0.clone(),
                    Stored {
                        key: row.0,
                        value,
                        updated_at: row.2,
                    },
                );
            }
        }
    }
    Ok(result)
}

fn read_rows(
    connection: &Connection,
    prefix: &str,
) -> Result<Vec<(String, String, String)>, PlatformError> {
    let mut statement = connection
        .prepare("SELECT key,value,updated_at FROM settings WHERE substr(key,1,?1)=?2 ORDER BY key")
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map(params![prefix.len() as i64, prefix], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|_| PlatformError::database_corrupt())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())
}

fn management_row(
    connection: &Connection,
) -> Result<Option<(String, String, String)>, PlatformError> {
    connection
        .query_row(
            "SELECT value,updated_at,device_id FROM settings WHERE key='library.management'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())
}

fn write_management_mirror(
    connection: &Connection,
    management: &Value,
    updated_at: &str,
    device_id: &str,
) -> Result<(), PlatformError> {
    let encoded =
        serde_json::to_string(management).map_err(|_| PlatformError::storage_unavailable())?;
    upsert_encoded(
        connection,
        "library.management",
        &encoded,
        updated_at,
        device_id,
    )
}

fn upsert<T: Serialize>(
    connection: &Connection,
    key: &str,
    value: &T,
    updated_at: &str,
    device_id: &str,
) -> Result<(), PlatformError> {
    let encoded = serde_json::to_string(value).map_err(|_| PlatformError::storage_unavailable())?;
    upsert_encoded(connection, key, &encoded, updated_at, device_id)
}

fn upsert_encoded(
    connection: &Connection,
    key: &str,
    value: &str,
    updated_at: &str,
    device_id: &str,
) -> Result<(), PlatformError> {
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at,device_id) VALUES(?1,?2,?3,?4) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id \
             WHERE settings.value<>excluded.value",
            params![key, value, updated_at, device_id],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}

fn parse_category(key: &str, value: &Value) -> Option<CategoryValue> {
    let id = key.strip_prefix(CATEGORY_PREFIX)?;
    if !is_category_id(id) || value.as_object()?.len() != 5 {
        return None;
    }
    let mut parsed = serde_json::from_value::<CategoryValue>(value.clone()).ok()?;
    let normalized_name = normalize_text(Some(&parsed.name), 100);
    if parsed.id != id
        || normalized_name.is_empty()
        || parsed.name != normalized_name
        || !valid_timestamp(&parsed.created_at)
        || !valid_state(&parsed.state, parsed.deleted_at.as_deref())
    {
        return None;
    }
    parsed.name = normalized_name;
    Some(parsed)
}

fn parse_item(key: &str, value: &Value) -> Option<ItemValue> {
    let publication_id = key.strip_prefix(ITEM_PREFIX)?;
    if !is_publication_id(publication_id) || value.as_object()?.len() != 5 {
        return None;
    }
    let mut parsed = serde_json::from_value::<ItemValue>(value.clone()).ok()?;
    let normalized_title = parsed
        .custom_title
        .as_deref()
        .map(|value| normalize_text(Some(value), 200))
        .filter(|value| !value.is_empty());
    if parsed.publication_id != publication_id
        || parsed.custom_title != normalized_title
        || parsed
            .category_id
            .as_deref()
            .is_some_and(|value| !is_category_id(value))
        || !valid_state(&parsed.state, parsed.deleted_at.as_deref())
        || (parsed.state == "present"
            && parsed.custom_title.is_none()
            && parsed.category_id.is_none())
    {
        return None;
    }
    parsed.custom_title = normalized_title;
    Some(parsed)
}

fn valid_state(state: &str, deleted_at: Option<&str>) -> bool {
    (state == "present" && deleted_at.is_none())
        || (state == "deleted" && deleted_at.is_some_and(valid_timestamp))
}

fn is_category_id(value: &str) -> bool {
    value.len() == 41
        && value.starts_with("category_")
        && value[9..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_publication_id(value: &str) -> bool {
    (8..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn normalize_text(value: Option<&str>, limit: usize) -> String {
    value
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn valid_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn local_device_id(connection: &Connection) -> Result<String, PlatformError> {
    connection
        .query_row(
            "SELECT value FROM app_metadata WHERE key='device_id'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| PlatformError::database_corrupt())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn next_derived_timestamp<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> String {
    let mut milliseconds = Utc::now().timestamp_millis();
    for value in values.into_iter().flatten() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
            milliseconds = milliseconds.max(parsed.timestamp_millis().saturating_add(1));
        }
    }
    DateTime::<Utc>::from_timestamp_millis(milliseconds)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::AndroidDatabase, platform_paths::PlatformPaths};

    #[test]
    fn disambiguates_long_multibyte_category_names_without_splitting_utf8() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        let database = AndroidDatabase::open(&paths, "test").expect("database");
        let name = "分类".repeat(50);
        let management = serde_json::json!({
            "viewMode": "grid",
            "sortBy": "importedAt",
            "sortDirection": "desc",
            "activeCategoryId": "all",
            "categories": [
                {"id": format!("category_{}", "a".repeat(32)), "name": name.clone(), "createdAt": "2026-07-30T00:00:00.000Z"},
                {"id": format!("category_{}", "b".repeat(32)), "name": name, "createdAt": "2026-07-30T01:00:00.000Z"}
            ],
            "items": {}
        });
        write_management(database.connection(), database.device_id(), &management)
            .expect("fine-grained settings");
        reconcile(database.connection(), true, false).expect("reconcile duplicate names");

        let encoded = management_row(database.connection())
            .expect("management row")
            .expect("management exists")
            .0;
        let projected: Value = serde_json::from_str(&encoded).expect("management json");
        let names = projected["categories"]
            .as_array()
            .expect("categories")
            .iter()
            .map(|category| category["name"].as_str().expect("name"))
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 2);
        assert_ne!(names[0], names[1]);
        assert!(names.iter().all(|value| value.chars().count() <= 100));
    }

    #[test]
    fn category_tombstone_preserves_receiver_title_and_unassigns_its_publication() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        let database = AndroidDatabase::open(&paths, "test").expect("database");
        let source_category = format!("category_{}", "a".repeat(32));
        let receiver_category = format!("category_{}", "b".repeat(32));
        let publication_id = "pub_aaaaaaaaaaaaaaaaaaaaaaaa";
        let management = serde_json::json!({
            "viewMode": "grid",
            "sortBy": "importedAt",
            "sortDirection": "desc",
            "activeCategoryId": source_category.clone(),
            "categories": [
                {"id": source_category.clone(), "name": "Source", "createdAt": "2026-07-30T00:00:00.000Z"},
                {"id": receiver_category.clone(), "name": "Receiver", "createdAt": "2026-07-30T01:00:00.000Z"}
            ],
            "items": {
                (publication_id): {"customTitle": "Receiver title", "categoryId": source_category.clone()}
            }
        });
        write_management(database.connection(), database.device_id(), &management)
            .expect("initial projection");
        database
            .connection()
            .execute(
                "UPDATE settings SET updated_at='2099-01-01T00:00:00.000Z' WHERE key=?1",
                [format!("{ITEM_PREFIX}{publication_id}")],
            )
            .expect("future item version");

        let deleted_at = "2026-07-31T00:00:00.000Z";
        upsert(
            database.connection(),
            &format!("{CATEGORY_PREFIX}{source_category}"),
            &CategoryValue {
                id: source_category.clone(),
                name: "Source".into(),
                created_at: "2026-07-30T00:00:00.000Z".into(),
                state: "deleted".into(),
                deleted_at: Some(deleted_at.into()),
            },
            deleted_at,
            "11111111-1111-4111-8111-111111111111",
        )
        .expect("category tombstone");
        reconcile(database.connection(), true, false).expect("reconcile");

        let encoded: String = database
            .connection()
            .query_row(
                "SELECT value FROM settings WHERE key='library.management'",
                [],
                |row| row.get(0),
            )
            .expect("management");
        let value: Value = serde_json::from_str(&encoded).expect("json");
        assert_eq!(
            value["categories"]
                .as_array()
                .expect("categories")
                .iter()
                .map(|category| category["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![receiver_category.as_str()]
        );
        assert_eq!(
            value["items"][publication_id]["customTitle"],
            "Receiver title"
        );
        assert!(value["items"][publication_id]["categoryId"].is_null());

        let (item_encoded, item_updated_at): (String, String) = database
            .connection()
            .query_row(
                "SELECT value,updated_at FROM settings WHERE key=?1",
                [format!("{ITEM_PREFIX}{publication_id}")],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("item");
        let item: Value = serde_json::from_str(&item_encoded).expect("item json");
        assert_eq!(item["state"], "present");
        assert!(item["categoryId"].is_null());
        assert!(item_updated_at.as_str() > "2099-01-01T00:00:00.000Z");
    }
}
