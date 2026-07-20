use crate::{
    database::AndroidDatabase, platform_error::PlatformError, platform_paths::PlatformPaths,
};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_BUNDLE_BYTES: u64 = 30 * 1024 * 1024;
const RESOURCE_TABLES: &[&str] = &["publications", "sections", "articles", "blocks"];
const CACHE_TABLES: &[&str] = &["translations", "context_definitions"];
const USER_TABLES: &[&str] = &[
    "settings",
    "reading_positions",
    "publication_lifecycle",
    "user_lexemes",
    "lexeme_examples",
    "vocabulary_sources",
    "saved_contexts",
    "study_plans",
    "study_plan_sources",
    "study_plan_lexeme_origins",
    "study_plan_exclusions",
    "scheduler_profiles",
    "review_cards",
    "study_sessions",
    "study_session_batches",
    "study_session_items",
    "review_events",
    "reinforcement_events",
    "review_suspensions",
    "study_progress_state",
    "study_lexeme_resets",
    "sync_clock",
    "sync_entity_revisions",
    "sync_peer_state",
    "sync_receipts",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    clearable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategoryReport {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    clearable: bool,
    entries: Vec<StorageEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub scanned_at: String,
    pub total_bytes: u64,
    pub packaged: bool,
    pub categories: Vec<StorageCategoryReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub cleared_bytes: u64,
    pub report: StorageReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperState {
    pub enabled: bool,
    pub logging_enabled: bool,
    pub log_bytes: u64,
    pub log_file_count: usize,
    pub last_study_reset_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticMetadata<'a> {
    format: &'a str,
    app_version: &'a str,
    platform: &'a str,
    created_at: String,
    note: &'a str,
}

pub fn storage_report(
    paths: &PlatformPaths,
    database: &AndroidDatabase,
    application_bytes: u64,
    secret_bytes: u64,
) -> Result<StorageReport, PlatformError> {
    let pages = database_pages(database.connection())?;
    let data_total = directory_size(&paths.data);
    let cache_total = directory_size(&paths.cache);
    let logs = directory_size(&paths.logs);
    let database_bytes = database_files_size(&paths.database_path());
    let library = directory_size(&paths.data.join("library"));
    let dictionaries = paths.data.join("dictionaries");
    let dictionary_base = file_size(&dictionaries.join("ecdict-base.sqlite"));
    let dictionary_full = file_size(&dictionaries.join("ecdict-full.sqlite"));
    let dictionary_total = directory_size(&dictionaries);
    let speech = directory_size(&paths.cache.join("speech"));
    let dictionary_online = directory_size(&paths.cache.join("dictionary"));
    let temporary = directory_size(&paths.temporary_staging)
        .saturating_add(directory_size(&paths.cache.join("diagnostics")));
    let known_cache = speech
        .saturating_add(dictionary_online)
        .saturating_add(temporary);
    let browser = cache_total.saturating_sub(known_cache);
    let known_data = database_bytes
        .saturating_add(library)
        .saturating_add(dictionary_total);
    let runtime = database_bytes
        .saturating_sub(
            pages
                .resources
                .saturating_add(pages.user)
                .saturating_add(pages.cache),
        )
        .saturating_add(data_total.saturating_sub(known_data))
        .saturating_add(logs);
    let categories = vec![
        category(
            "necessary",
            "必要文件",
            false,
            vec![
                entry(
                    "application",
                    "应用程序与运行组件",
                    application_bytes,
                    false,
                ),
                entry("runtime", "数据库运行开销与恢复文件", runtime, false),
            ],
        ),
        category(
            "resources",
            "资源文件",
            false,
            vec![
                entry(
                    "library",
                    "已导入刊物与解压资源",
                    library.saturating_add(pages.resources),
                    false,
                ),
                entry(
                    "dictionary-base",
                    "ECDICT 标准学习包",
                    dictionary_base,
                    false,
                ),
                entry(
                    "dictionary-full",
                    "ECDICT 完整定义扩展",
                    dictionary_full,
                    false,
                ),
                entry(
                    "dictionary-other",
                    "词典安装临时文件",
                    dictionary_total
                        .saturating_sub(dictionary_base)
                        .saturating_sub(dictionary_full),
                    false,
                ),
            ],
        ),
        category(
            "user-data",
            "用户数据",
            false,
            vec![
                entry("personal", "设置、阅读、生词与学习数据", pages.user, false),
                entry("secrets", "本机加密密钥", secret_bytes, false),
            ],
        ),
        category(
            "cache",
            "缓存",
            true,
            vec![
                entry("speech", "Google / MiniMax 语音音频", speech, true),
                entry(
                    "dictionary-online",
                    "百度词典查询缓存",
                    dictionary_online,
                    true,
                ),
                entry("ai-text", "译文与 AI 文中义", pages.cache, true),
                entry("browser", "网络、代码与图形缓存", browser, true),
                entry("temporary", "临时文件", temporary, true),
            ],
        ),
    ];
    Ok(StorageReport {
        scanned_at: Utc::now().to_rfc3339(),
        total_bytes: application_bytes
            .saturating_add(data_total)
            .saturating_add(cache_total)
            .saturating_add(logs)
            .saturating_add(secret_bytes),
        packaged: true,
        categories,
    })
}

pub fn clear_safe_caches(paths: &PlatformPaths) -> Result<(), PlatformError> {
    for root in [
        paths.cache.join("speech"),
        paths.cache.join("dictionary"),
        paths.temporary_staging.clone(),
    ] {
        remove_directory(&root)?;
        fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    }
    Ok(())
}

pub fn clear_ai_text(database: &AndroidDatabase) -> Result<(), PlatformError> {
    let connection = database.connection();
    connection
        .execute_batch(
            "BEGIN IMMEDIATE; DELETE FROM translations; DELETE FROM context_definitions; COMMIT;",
        )
        .map_err(|_| {
            let _ = connection.execute_batch("ROLLBACK;");
            PlatformError::storage_unavailable()
        })?;
    let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    let _ = connection.execute_batch("VACUUM;");
    Ok(())
}

pub fn developer_state(
    database: &AndroidDatabase,
    logging_enabled: bool,
    paths: &PlatformPaths,
) -> Result<DeveloperState, PlatformError> {
    let enabled = read_boolean(database.connection(), "study.developer-mode")?;
    let (log_file_count, log_bytes) = diagnostic_log_stats(paths)?;
    let last_study_reset_at = database
        .connection()
        .query_row(
            "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .flatten();
    Ok(DeveloperState {
        enabled,
        logging_enabled,
        log_bytes,
        log_file_count,
        last_study_reset_at,
    })
}

pub fn read_boolean(connection: &Connection, key: &str) -> Result<bool, PlatformError> {
    Ok(connection
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .as_deref()
        == Some("true"))
}

pub fn write_boolean(
    database: &AndroidDatabase,
    key: &str,
    value: bool,
) -> Result<(), PlatformError> {
    database.connection().execute(
        "INSERT INTO settings(key,value,updated_at,device_id) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
        rusqlite::params![key, if value { "true" } else { "false" }, Utc::now().to_rfc3339(), database.device_id()],
    ).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}

pub fn create_diagnostic_bundle(paths: &PlatformPaths) -> Result<PathBuf, PlatformError> {
    let root = paths.cache.join("diagnostics");
    remove_directory(&root)?;
    fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    let destination = root.join(format!(
        "foreign-press-reader-diagnostics-{}.zip",
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let file = File::create(&destination).map_err(|_| PlatformError::storage_unavailable())?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive
        .start_file("metadata.json", options)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let metadata = DiagnosticMetadata {
        format: "fpr-diagnostics-v1",
        app_version: env!("CARGO_PKG_VERSION"),
        platform: "android",
        created_at: Utc::now().to_rfc3339(),
        note: "Sanitized diagnostic events only; no keys, article text, URLs, or local paths.",
    };
    archive
        .write_all(
            &serde_json::to_vec_pretty(&metadata)
                .map_err(|_| PlatformError::storage_unavailable())?,
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut written = 0_u64;
    let mut logs = fs::read_dir(&paths.logs)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("app-"))
        .collect::<Vec<_>>();
    logs.sort_by_key(|entry| entry.file_name());
    for entry in logs.into_iter().take(5) {
        let size = entry.metadata().map(|value| value.len()).unwrap_or(0);
        if written.saturating_add(size) > MAX_BUNDLE_BYTES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let mut source =
            File::open(entry.path()).map_err(|_| PlatformError::storage_unavailable())?;
        let mut bytes = Vec::with_capacity(size as usize);
        source
            .read_to_end(&mut bytes)
            .map_err(|_| PlatformError::storage_unavailable())?;
        archive
            .start_file(format!("logs/{name}"), options)
            .map_err(|_| PlatformError::storage_unavailable())?;
        archive
            .write_all(&bytes)
            .map_err(|_| PlatformError::storage_unavailable())?;
        written = written.saturating_add(size);
    }
    archive
        .finish()
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(destination)
}

#[cfg(target_os = "android")]
pub fn share_bundle(app: &AppHandle, path: &Path) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let path = path.to_string_lossy();
    app.foundation()
        .share_diagnostic_bundle(&path)
        .map_err(|_| PlatformError::new("shareUnavailable", "无法打开系统分享面板。", true))
}

#[cfg(not(target_os = "android"))]
pub fn share_bundle(_app: &AppHandle, _path: &Path) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动诊断分享。",
        false,
    ))
}

#[derive(Default)]
struct DatabasePages {
    resources: u64,
    user: u64,
    cache: u64,
}

fn database_pages(connection: &Connection) -> Result<DatabasePages, PlatformError> {
    let mut statement = connection.prepare("SELECT COALESCE(m.tbl_name,d.name),SUM(d.pgsize) FROM dbstat d LEFT JOIN sqlite_schema m ON m.name=d.name GROUP BY COALESCE(m.tbl_name,d.name)").map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut result = DatabasePages::default();
    for row in rows {
        let (table, bytes) = row.map_err(|_| PlatformError::database_corrupt())?;
        let bytes = bytes.max(0) as u64;
        if RESOURCE_TABLES.contains(&table.as_str()) {
            result.resources = result.resources.saturating_add(bytes);
        } else if CACHE_TABLES.contains(&table.as_str()) {
            result.cache = result.cache.saturating_add(bytes);
        } else if USER_TABLES.contains(&table.as_str()) {
            result.user = result.user.saturating_add(bytes);
        }
    }
    Ok(result)
}

fn diagnostic_log_stats(paths: &PlatformPaths) -> Result<(usize, u64), PlatformError> {
    let entries = match fs::read_dir(&paths.logs) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(_) => return Err(PlatformError::storage_unavailable()),
    };
    let files = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && entry.file_name().to_string_lossy().starts_with("app-")
        })
        .collect::<Vec<_>>();
    Ok((
        files.len(),
        files
            .iter()
            .map(|entry| entry.metadata().map(|value| value.len()).unwrap_or(0))
            .sum(),
    ))
}

fn entry(id: &'static str, label: &'static str, bytes: u64, clearable: bool) -> StorageEntry {
    StorageEntry {
        id,
        label,
        bytes,
        clearable,
    }
}
fn category(
    id: &'static str,
    label: &'static str,
    clearable: bool,
    entries: Vec<StorageEntry>,
) -> StorageCategoryReport {
    StorageCategoryReport {
        id,
        label,
        bytes: entries.iter().map(|entry| entry.bytes).sum(),
        clearable,
        entries,
    }
}

fn database_files_size(path: &Path) -> u64 {
    let mut total = file_size(path);
    let display = path.to_string_lossy();
    total = total.saturating_add(file_size(Path::new(&format!("{display}-wal"))));
    total.saturating_add(file_size(Path::new(&format!("{display}-shm"))))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|value| value.len()).unwrap_or(0)
}

fn directory_size(root: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let Ok(kind) = entry.file_type() else {
                return 0;
            };
            if kind.is_symlink() {
                0
            } else if kind.is_dir() {
                directory_size(&entry.path())
            } else {
                file_size(&entry.path())
            }
        })
        .sum()
}

fn remove_directory(root: &Path) -> Result<(), PlatformError> {
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(PlatformError::storage_unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_cache_clear_never_touches_persistent_data() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().expect("prepare");
        fs::create_dir_all(paths.data.join("library/book")).expect("library");
        fs::write(
            paths.data.join("library/book/article.xhtml"),
            b"user publication",
        )
        .expect("publication");
        fs::create_dir_all(paths.cache.join("speech/google")).expect("speech");
        fs::write(paths.cache.join("speech/google/test.mp3"), b"cache").expect("cache file");
        clear_safe_caches(&paths).expect("clear");
        assert!(paths.data.join("library/book/article.xhtml").is_file());
        assert_eq!(directory_size(&paths.cache.join("speech")), 0);
    }
}
