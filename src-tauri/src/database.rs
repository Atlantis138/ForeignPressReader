use crate::{platform_error::PlatformError, platform_paths::PlatformPaths};
use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const FORMAL_V1_SQL: &str = include_str!("../migrations/0001_formal_v1.sql");
const PARSED_PUBLICATION_STORAGE_V2_SQL: &str =
    include_str!("../migrations/0002_parsed_publication_storage.sql");
pub const SCHEMA_GENERATION: &str = "formal-v1";
pub const LATEST_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    pub schema_version: i64,
    pub generation: String,
    pub content_id_version: i64,
    pub integrity: &'static str,
    pub device_id_fingerprint: String,
}

#[derive(Debug)]
pub struct AndroidDatabase {
    connection: Connection,
    device_id: String,
}

impl AndroidDatabase {
    pub fn open(paths: &PlatformPaths, app_version: &str) -> Result<Self, PlatformError> {
        paths.prepare()?;
        let path = paths.database_path();
        let existed = path.exists();
        if existed {
            validate_existing(&path)?;
        }
        let mut connection = Connection::open(&path).map_err(map_database_open_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| PlatformError::database_corrupt())?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|_| PlatformError::database_corrupt())?;
        initialize(&mut connection, app_version, false)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| PlatformError::storage_unavailable())?;
        assert_integrity(&connection)?;
        let generation = metadata(&connection, "schema_generation")?;
        if generation != SCHEMA_GENERATION {
            return Err(PlatformError::database_legacy());
        }
        let device_id = metadata(&connection, "device_id")?;
        Ok(Self {
            connection,
            device_id,
        })
    }

    pub fn status(&self) -> Result<DatabaseStatus, PlatformError> {
        let schema_version = schema_version(&self.connection)?;
        let generation = metadata(&self.connection, "schema_generation")?;
        let content_id_version = metadata(&self.connection, "content_id_version")?
            .parse::<i64>()
            .map_err(|_| PlatformError::database_corrupt())?;
        Ok(DatabaseStatus {
            schema_version,
            generation,
            content_id_version,
            integrity: "ok",
            device_id_fingerprint: device_id_fingerprint(&self.device_id),
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }

    pub(crate) fn device_id(&self) -> &str {
        &self.device_id
    }
}

fn validate_existing(path: &Path) -> Result<(), PlatformError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags).map_err(map_database_open_error)?;
    assert_integrity(&connection)?;
    let version = schema_version(&connection)?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(PlatformError::database_future());
    }
    if version == 0 {
        let objects: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        if objects > 0 {
            return Err(PlatformError::database_legacy());
        }
        return Ok(());
    }
    if metadata(&connection, "schema_generation")? != SCHEMA_GENERATION {
        return Err(PlatformError::database_legacy());
    }
    Ok(())
}

fn initialize(
    connection: &mut Connection,
    app_version: &str,
    inject_failure: bool,
) -> Result<(), PlatformError> {
    let version = schema_version(connection)?;
    if version >= LATEST_SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::migration_failed())?;
    let result = (|| {
        if version < 1 {
            migrate_formal_v1(&transaction, app_version)?;
        }
        if version < 2 {
            migrate_parsed_publication_storage_v2(&transaction, app_version)?;
        }
        if inject_failure {
            return Err(PlatformError::migration_failed());
        }
        Ok(())
    })();
    match result {
        Ok(()) => transaction
            .commit()
            .map_err(|_| PlatformError::migration_failed()),
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn migrate_formal_v1(
    transaction: &Transaction<'_>,
    app_version: &str,
) -> Result<(), PlatformError> {
    transaction
        .execute_batch(FORMAL_V1_SQL)
        .map_err(|_| PlatformError::migration_failed())?;
    let metadata_insert = "INSERT INTO app_metadata (key,value) VALUES (?1,?2)";
    transaction
        .execute(
            metadata_insert,
            params!["schema_generation", SCHEMA_GENERATION],
        )
        .map_err(|_| PlatformError::migration_failed())?;
    transaction
        .execute(
            metadata_insert,
            params!["device_id", Uuid::new_v4().to_string()],
        )
        .map_err(|_| PlatformError::migration_failed())?;
    transaction
        .execute(metadata_insert, params!["content_id_version", "2"])
        .map_err(|_| PlatformError::migration_failed())?;
    create_sync_triggers(transaction)?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO migration_history (version,name,applied_at,app_version) VALUES (1,'formal-v1',?1,?2)",
            params![now, app_version],
        )
        .map_err(|_| PlatformError::migration_failed())?;
    transaction
        .pragma_update(None, "user_version", 1)
        .map_err(|_| PlatformError::migration_failed())?;
    Ok(())
}

fn migrate_parsed_publication_storage_v2(
    transaction: &Transaction<'_>,
    app_version: &str,
) -> Result<(), PlatformError> {
    transaction
        .execute_batch(PARSED_PUBLICATION_STORAGE_V2_SQL)
        .map_err(|_| PlatformError::migration_failed())?;
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO migration_history (version,name,applied_at,app_version) VALUES (2,'parsed-publication-storage',?1,?2)",
            params![now, app_version],
        )
        .map_err(|_| PlatformError::migration_failed())?;
    transaction
        .pragma_update(None, "user_version", 2)
        .map_err(|_| PlatformError::migration_failed())?;
    Ok(())
}

fn create_sync_triggers(transaction: &Transaction<'_>) -> Result<(), PlatformError> {
    const TRACKED_SETTINGS: &str = "'reader.preferences','dictionary.preferences','study.preferences','speech.preferences','translation.preferences','library.management'";
    const SPECS: &[(&str, &str)] = &[
        ("settings", "key"),
        ("publication_lifecycle", "publication_id"),
        ("reading_positions", "publication_id"),
        ("user_lexemes", "lexeme_key"),
        ("lexeme_examples", "example_id"),
        ("vocabulary_sources", "source_id"),
        ("saved_contexts", "context_id"),
        ("study_plans", "plan_id"),
        ("study_plan_sources", "source_id"),
        ("study_plan_lexeme_origins", "origin_id"),
        ("study_plan_exclusions", "plan_id||char(31)||NEW.lexeme_key"),
        ("scheduler_profiles", "profile_id"),
        ("review_cards", "lexeme_key"),
        ("review_events", "event_id"),
        ("reinforcement_events", "event_id"),
        ("review_suspensions", "lexeme_key"),
        ("study_progress_state", "state_id"),
        ("study_lexeme_resets", "lexeme_key"),
    ];
    for (table, key_expression) in SPECS {
        for operation in ["INSERT", "UPDATE"] {
            let suffix = operation.to_ascii_lowercase();
            let when = if *table == "settings" {
                format!("WHEN NEW.key IN ({TRACKED_SETTINGS})")
            } else {
                String::new()
            };
            let sql = format!(
                "CREATE TRIGGER sync_track_{table}_{suffix}\n\
                 AFTER {operation} ON {table}\n\
                 {when}\n\
                 BEGIN\n\
                   UPDATE sync_clock SET current_revision=current_revision+1 WHERE singleton=1;\n\
                   INSERT INTO sync_entity_revisions (entity_type,entity_key,revision,changed_at)\n\
                   SELECT '{table}',NEW.{key_expression},current_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now')\n\
                   FROM sync_clock WHERE singleton=1\n\
                   ON CONFLICT(entity_type,entity_key) DO UPDATE SET\n\
                     revision=excluded.revision, changed_at=excluded.changed_at;\n\
                 END;"
            );
            transaction
                .execute_batch(&sql)
                .map_err(|_| PlatformError::migration_failed())?;
        }
    }
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<i64, PlatformError> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| PlatformError::database_corrupt())
}

fn metadata(connection: &Connection, key: &str) -> Result<String, PlatformError> {
    connection
        .query_row(
            "SELECT value FROM app_metadata WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .map_err(|_| PlatformError::database_corrupt())
}

fn assert_integrity(connection: &Connection) -> Result<(), PlatformError> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| PlatformError::database_corrupt())?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(PlatformError::database_corrupt())
    }
}

fn map_database_open_error(_: rusqlite::Error) -> PlatformError {
    PlatformError::database_corrupt()
}

pub fn stable_identity(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(parts.join("\u{001f}").as_bytes());
    hex::encode(digest.finalize())
}

pub fn compare_versioned_records(
    left_updated_at: &str,
    left_device_id: &str,
    right_updated_at: &str,
    right_device_id: &str,
) -> std::cmp::Ordering {
    left_updated_at
        .cmp(right_updated_at)
        .then_with(|| left_device_id.cmp(right_device_id))
}

pub fn schema_fingerprint(connection: &Connection) -> Result<String, PlatformError> {
    let mut statement = connection
        .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema \
             WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name",
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                normalize_sql(&row.get::<_, String>(3)?),
            ))
        })
        .map_err(|_| PlatformError::database_corrupt())?;
    let values = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let encoded = serde_json::to_vec(&values).map_err(|_| PlatformError::database_corrupt())?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

fn normalize_sql(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn device_id_fingerprint(device_id: &str) -> String {
    hex::encode(Sha256::digest(device_id.as_bytes()))[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn paths(root: &Path) -> PlatformPaths {
        PlatformPaths::new(root.join("data"), root.join("cache"), root.join("logs"))
    }

    #[test]
    fn creates_latest_schema_and_persists_across_restart() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = paths(root.path());
        let first = AndroidDatabase::open(&paths, "1.0.0-alpha.1-test").expect("open");
        let first_status = first.status().expect("status");
        assert_eq!(first_status.schema_version, 2);
        assert_eq!(first_status.generation, "formal-v1");
        assert_eq!(first_status.content_id_version, 2);
        let fingerprint = first_status.device_id_fingerprint;
        drop(first);
        let reopened = AndroidDatabase::open(&paths, "1.0.0-alpha.1-test").expect("reopen");
        assert_eq!(
            reopened.status().expect("status").device_id_fingerprint,
            fingerprint
        );
    }

    #[test]
    fn accepts_a_truly_empty_sqlite_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = paths(root.path());
        paths.prepare().expect("prepare");
        Connection::open(paths.database_path()).expect("empty sqlite");
        let database = AndroidDatabase::open(&paths, "test").expect("open");
        assert_eq!(database.status().expect("status").schema_version, 2);
    }

    #[test]
    fn rolls_back_the_complete_baseline_on_failure() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = paths(root.path());
        paths.prepare().expect("prepare");
        let mut connection = Connection::open(paths.database_path()).expect("open");
        let error = initialize(&mut connection, "test", true).expect_err("failure");
        assert_eq!(error.code, "migrationFailed");
        assert_eq!(schema_version(&connection).expect("version"), 0);
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('app_metadata','sync_clock')",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_legacy_and_future_databases_without_modifying_them() {
        for (version, generation, expected) in [
            (1, Some("v0.5.5-study-baseline"), "databaseIncompatible"),
            (3, None, "databaseTooNew"),
        ] {
            let root = tempfile::tempdir().expect("tempdir");
            let paths = paths(root.path());
            paths.prepare().expect("prepare");
            let path = paths.database_path();
            let connection = Connection::open(&path).expect("open");
            if let Some(generation) = generation {
                connection
                    .execute_batch(&format!(
                        "CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
                         INSERT INTO app_metadata VALUES('schema_generation','{generation}');\
                         CREATE TABLE legacy_marker(value TEXT NOT NULL);\
                         INSERT INTO legacy_marker VALUES('untouched');"
                    ))
                    .expect("legacy");
            } else {
                connection
                    .execute_batch(
                        "CREATE TABLE future_marker(value TEXT NOT NULL);\
                         INSERT INTO future_marker VALUES('untouched');",
                    )
                    .expect("future");
            }
            connection
                .pragma_update(None, "user_version", version)
                .expect("version");
            drop(connection);
            let before = fs::read(&path).expect("before");
            let error = AndroidDatabase::open(&paths, "test").expect_err("reject");
            assert_eq!(error.code, expected);
            assert_eq!(fs::read(&path).expect("after"), before);
        }
    }

    #[test]
    fn rejects_corrupt_database() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = paths(root.path());
        paths.prepare().expect("prepare");
        fs::write(paths.database_path(), b"not a sqlite database").expect("write corrupt");
        let error = AndroidDatabase::open(&paths, "test").expect_err("reject");
        assert_eq!(error.code, "databaseCorrupt");
    }

    #[test]
    fn stable_ids_and_version_order_match_typescript_semantics() {
        assert_eq!(
            stable_identity(&["lex_en_abc", "reader_manual", "favorite"]),
            "ef71fb1bfb407be6931c217909095f44112bde4f8791258f3ea66eaf604dfb9f"
        );
        assert_eq!(
            compare_versioned_records(
                "2026-07-12T00:00:00.000Z",
                "b",
                "2026-07-12T00:00:00.000Z",
                "a"
            ),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn matches_the_published_formal_v1_vector() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/formal-v1.json"))
                .expect("vector");
        let root = tempfile::tempdir().expect("tempdir");
        let mut connection = Connection::open(root.path().join("formal-v1.sqlite")).expect("open");
        let transaction = connection.transaction().expect("transaction");
        migrate_formal_v1(&transaction, "vector-test").expect("migrate v1");
        transaction.commit().expect("commit");
        assert_eq!(
            schema_fingerprint(&connection).expect("fingerprint"),
            vector["schemaFingerprint"]
                .as_str()
                .expect("schema fingerprint")
        );
        assert_eq!(
            metadata(&connection, "schema_generation").expect("generation"),
            vector["schemaGeneration"].as_str().expect("generation")
        );
    }

    #[test]
    fn upgrades_v1_to_v2_and_rolls_back_a_failed_upgrade() {
        for inject_failure in [false, true] {
            let root = tempfile::tempdir().expect("tempdir");
            let paths = paths(root.path());
            paths.prepare().expect("prepare");
            let mut connection = Connection::open(paths.database_path()).expect("open");
            let transaction = connection.transaction().expect("transaction");
            migrate_formal_v1(&transaction, "v1").expect("migrate v1");
            transaction.execute(
                "INSERT INTO publications(id,hash,source_key,profile_id,title,creator,language,cover_path,source_path,imported_at,article_count,section_count) \
                 VALUES('pub_aaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','source','generic','Fixture',NULL,'en',NULL,'source.epub','2026-07-15T00:00:00Z',1,0)",
                [],
            ).expect("fixture");
            transaction.commit().expect("commit v1");

            let result = initialize(&mut connection, "v2", inject_failure);
            if inject_failure {
                assert_eq!(result.expect_err("rollback").code, "migrationFailed");
                assert_eq!(schema_version(&connection).expect("version"), 1);
                assert!(connection
                    .prepare("SELECT source_storage FROM publications")
                    .is_err());
                let history: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM migration_history WHERE version=2",
                        [],
                        |row| row.get(0),
                    )
                    .expect("history");
                assert_eq!(history, 0);
            } else {
                result.expect("upgrade");
                assert_eq!(schema_version(&connection).expect("version"), 2);
                let storage: String = connection
                    .query_row("SELECT source_storage FROM publications", [], |row| {
                        row.get(0)
                    })
                    .expect("storage");
                assert_eq!(storage, "retained");
                let history: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM migration_history WHERE version=2",
                        [],
                        |row| row.get(0),
                    )
                    .expect("history");
                assert_eq!(history, 1);
            }
        }
    }
}
