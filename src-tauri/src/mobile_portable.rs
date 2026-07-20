use crate::{
    database::{AndroidDatabase, LATEST_SCHEMA_VERSION},
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
    publication_package,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{
    params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const FORMAT: &str = "foreign-press-reader-portable";
pub const FORMAT_VERSION: i64 = 2;
const CONTENT_ID_VERSION: i64 = 2;
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
const MAX_EXPANSION_RATIO: u64 = 2_000;
const SETTINGS: &[&str] = &[
    "reader.preferences",
    "dictionary.preferences",
    "study.preferences",
    "speech.preferences",
    "translation.preferences",
    "library.management",
];

#[derive(Clone, Copy)]
struct Column {
    json: &'static str,
    sql: &'static str,
    boolean: bool,
}

macro_rules! c {
    ($json:literal, $sql:literal) => {
        Column {
            json: $json,
            sql: $sql,
            boolean: false,
        }
    };
}
macro_rules! b {
    ($json:literal, $sql:literal) => {
        Column {
            json: $json,
            sql: $sql,
            boolean: true,
        }
    };
}

#[derive(Clone, Copy)]
struct Dataset {
    path: &'static str,
    kind: &'static str,
    table: &'static str,
    columns: &'static [Column],
    keys: &'static [&'static str],
    version: Option<(&'static str, &'static str)>,
    immutable: bool,
    settings_json: bool,
    update_columns: Option<&'static [&'static str]>,
    custom_update: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub(crate) struct SyncRawRecord {
    pub table: String,
    pub record: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergePolicy {
    NewerWins,
    IncomingWins,
}

#[derive(Debug, Clone)]
pub(crate) struct SyncIncomingMergeResult {
    pub duplicate: bool,
    pub applied_records: usize,
    pub unchanged_records: usize,
    pub local_revision: i64,
}

const LIFECYCLE: &[Column] = &[
    c!("publicationId", "publication_id"),
    c!("contentHash", "content_hash"),
    c!("formatId", "format_id"),
    c!("titleSnapshot", "title_snapshot"),
    c!("state", "state"),
    c!("changedAt", "changed_at"),
    c!("deviceId", "device_id"),
];
const SETTING: &[Column] = &[
    c!("key", "key"),
    c!("value", "value"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const POSITION: &[Column] = &[
    c!("publicationId", "publication_id"),
    c!("articleId", "article_id"),
    c!("scrollTop", "scroll_top"),
    c!("anchorBlockId", "anchor_block_id"),
    c!("anchorTokenIndex", "anchor_token_index"),
    c!("anchorFraction", "anchor_fraction"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const LEXEME: &[Column] = &[
    c!("lexemeKey", "lexeme_key"),
    c!("lemmaSnapshot", "lemma_snapshot"),
    c!("phoneticSnapshot", "phonetic_snapshot"),
    c!("briefMeaningsJson", "brief_meanings_json"),
    c!("senseGroupsJson", "sense_groups_json"),
    c!("bncRank", "bnc_rank"),
    c!("frequencyRank", "frequency_rank"),
    c!("manualState", "manual_state"),
    c!("manualFamiliarity", "manual_familiarity"),
    c!("createdAt", "created_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
    c!("snapshotProvider", "snapshot_provider"),
    c!("snapshotQuality", "snapshot_quality"),
];
const EXAMPLE: &[Column] = &[
    c!("exampleId", "example_id"),
    c!("lexemeKey", "lexeme_key"),
    c!("text", "text"),
    c!("translationZh", "translation_zh"),
    c!("partOfSpeech", "part_of_speech"),
    c!("definition", "definition"),
    c!("providerId", "provider_id"),
    c!("position", "position"),
    c!("createdAt", "created_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const VOCAB_SOURCE: &[Column] = &[
    c!("sourceId", "source_id"),
    c!("lexemeKey", "lexeme_key"),
    c!("sourceType", "source_type"),
    c!("sourceRef", "source_ref"),
    b!("active", "active"),
    c!("addedAt", "added_at"),
    c!("removedAt", "removed_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const CONTEXT: &[Column] = &[
    c!("contextId", "context_id"),
    c!("lexemeKey", "lexeme_key"),
    c!("surface", "surface"),
    c!("publicationId", "publication_id"),
    c!("publicationTitle", "publication_title_snapshot"),
    c!("articleId", "article_id"),
    c!("articleTitle", "article_title_snapshot"),
    c!("blockId", "block_id"),
    c!("tokenIndex", "token_index"),
    c!("sentence", "sentence_snapshot"),
    c!("paragraph", "paragraph_snapshot"),
    c!("sentenceHash", "sentence_hash"),
    b!("active", "active"),
    c!("savedAt", "saved_at"),
    c!("removedAt", "removed_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const PLAN: &[Column] = &[
    c!("planId", "plan_id"),
    c!("name", "name"),
    c!("status", "status"),
    c!("dailyNewLimit", "daily_new_limit"),
    c!("dailyReviewLimit", "daily_review_limit"),
    c!("newOrder", "new_order"),
    c!("createdAt", "created_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
    c!("deletedAt", "deleted_at"),
];
const PLAN_SOURCE: &[Column] = &[
    c!("sourceId", "source_id"),
    c!("planId", "plan_id"),
    c!("sourceType", "source_type"),
    c!("sourceRef", "source_ref"),
    b!("active", "active"),
    c!("addedAt", "added_at"),
    c!("removedAt", "removed_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const ORIGIN: &[Column] = &[
    c!("originId", "origin_id"),
    c!("planId", "plan_id"),
    c!("planSourceId", "plan_source_id"),
    c!("lexemeKey", "lexeme_key"),
    b!("active", "active"),
    c!("discoveredAt", "discovered_at"),
    c!("removedAt", "removed_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const EXCLUSION: &[Column] = &[
    c!("planId", "plan_id"),
    c!("lexemeKey", "lexeme_key"),
    b!("excluded", "excluded"),
    c!("excludedAt", "excluded_at"),
    c!("restoredAt", "restored_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const PROFILE: &[Column] = &[
    c!("profileId", "profile_id"),
    c!("fsrsVersion", "fsrs_version"),
    c!("parametersJson", "parameters_json"),
    c!("parametersHash", "parameters_hash"),
    c!("createdAt", "created_at"),
];
const CARD: &[Column] = &[
    c!("lexemeKey", "lexeme_key"),
    c!("dueAt", "due_at"),
    c!("stability", "stability"),
    c!("difficulty", "difficulty"),
    c!("elapsedDays", "elapsed_days"),
    c!("scheduledDays", "scheduled_days"),
    c!("learningSteps", "learning_steps"),
    c!("reps", "reps"),
    c!("lapses", "lapses"),
    c!("state", "state"),
    c!("lastReviewAt", "last_review_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const REVIEW: &[Column] = &[
    c!("eventId", "event_id"),
    c!("commandId", "command_id"),
    c!("lexemeKey", "lexeme_key"),
    c!("planId", "plan_id"),
    c!("answer", "answer"),
    c!("rating", "rating"),
    c!("profileId", "profile_id"),
    c!("preCardJson", "pre_card_json"),
    c!("postCardJson", "post_card_json"),
    c!("logJson", "log_json"),
    c!("reviewedAt", "reviewed_at"),
    c!("deviceId", "device_id"),
];
const REINFORCEMENT: &[Column] = &[
    c!("eventId", "event_id"),
    c!("commandId", "command_id"),
    c!("lexemeKey", "lexeme_key"),
    c!("planId", "plan_id"),
    c!("answer", "answer"),
    c!("consecutiveBefore", "consecutive_before"),
    c!("consecutiveAfter", "consecutive_after"),
    c!("createdAt", "created_at"),
    c!("deviceId", "device_id"),
];
const SUSPENSION: &[Column] = &[
    c!("lexemeKey", "lexeme_key"),
    b!("active", "active"),
    c!("reason", "reason"),
    c!("suspendedAt", "suspended_at"),
    c!("restoredAt", "restored_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const PROGRESS: &[Column] = &[
    c!("stateId", "state_id"),
    c!("resetAt", "reset_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];
const RESET: &[Column] = &[
    c!("lexemeKey", "lexeme_key"),
    c!("resetAt", "reset_at"),
    c!("updatedAt", "updated_at"),
    c!("deviceId", "device_id"),
];

const DATASETS: &[Dataset] = &[
    Dataset { path: "data/publication-lifecycle.ndjson", kind: "publication-lifecycle", table: "publication_lifecycle", columns: LIFECYCLE, keys: &["publication_id"], version: Some(("changed_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/settings.json", kind: "settings", table: "settings", columns: SETTING, keys: &["key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: true, update_columns: None, custom_update: None },
    Dataset { path: "data/reading-positions.ndjson", kind: "reading-positions", table: "reading_positions", columns: POSITION, keys: &["publication_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/user-lexemes.ndjson", kind: "user-lexemes", table: "user_lexemes", columns: LEXEME, keys: &["lexeme_key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: Some("lemma_snapshot=excluded.lemma_snapshot,phonetic_snapshot=excluded.phonetic_snapshot,brief_meanings_json=excluded.brief_meanings_json,sense_groups_json=excluded.sense_groups_json,bnc_rank=excluded.bnc_rank,frequency_rank=excluded.frequency_rank,manual_state=excluded.manual_state,manual_familiarity=excluded.manual_familiarity,created_at=min(user_lexemes.created_at,excluded.created_at),updated_at=excluded.updated_at,device_id=excluded.device_id,snapshot_provider=CASE WHEN excluded.snapshot_quality>=user_lexemes.snapshot_quality THEN excluded.snapshot_provider ELSE user_lexemes.snapshot_provider END,snapshot_quality=max(user_lexemes.snapshot_quality,excluded.snapshot_quality)") },
    Dataset { path: "data/lexeme-examples.ndjson", kind: "lexeme-examples", table: "lexeme_examples", columns: EXAMPLE, keys: &["example_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/vocabulary-sources.ndjson", kind: "vocabulary-sources", table: "vocabulary_sources", columns: VOCAB_SOURCE, keys: &["source_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: Some(&["active", "removed_at", "updated_at", "device_id"]), custom_update: None },
    Dataset { path: "data/saved-contexts.ndjson", kind: "saved-contexts", table: "saved_contexts", columns: CONTEXT, keys: &["context_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: Some(&["surface", "publication_id", "publication_title_snapshot", "article_id", "article_title_snapshot", "block_id", "token_index", "sentence_snapshot", "paragraph_snapshot", "sentence_hash", "active", "removed_at", "updated_at", "device_id"]), custom_update: None },
    Dataset { path: "data/study-plans.ndjson", kind: "study-plans", table: "study_plans", columns: PLAN, keys: &["plan_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/study-plan-sources.ndjson", kind: "study-plan-sources", table: "study_plan_sources", columns: PLAN_SOURCE, keys: &["source_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/study-plan-origins.ndjson", kind: "study-plan-origins", table: "study_plan_lexeme_origins", columns: ORIGIN, keys: &["origin_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/study-plan-exclusions.ndjson", kind: "study-plan-exclusions", table: "study_plan_exclusions", columns: EXCLUSION, keys: &["plan_id", "lexeme_key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/scheduler-profiles.ndjson", kind: "scheduler-profiles", table: "scheduler_profiles", columns: PROFILE, keys: &["profile_id"], version: None, immutable: true, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/study-progress-state.ndjson", kind: "study-progress-state", table: "study_progress_state", columns: PROGRESS, keys: &["state_id"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/study-lexeme-resets.ndjson", kind: "study-lexeme-resets", table: "study_lexeme_resets", columns: RESET, keys: &["lexeme_key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/review-cards.ndjson", kind: "review-cards", table: "review_cards", columns: CARD, keys: &["lexeme_key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/review-events.ndjson", kind: "review-events", table: "review_events", columns: REVIEW, keys: &["event_id"], version: None, immutable: true, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/reinforcement-events.ndjson", kind: "reinforcement-events", table: "reinforcement_events", columns: REINFORCEMENT, keys: &["event_id"], version: None, immutable: true, settings_json: false, update_columns: None, custom_update: None },
    Dataset { path: "data/review-suspensions.ndjson", kind: "review-suspensions", table: "review_suspensions", columns: SUSPENSION, keys: &["lexeme_key"], version: Some(("updated_at", "device_id")), immutable: false, settings_json: false, update_columns: None, custom_update: None },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestFile {
    path: String,
    size: u64,
    sha256: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestCounts {
    publications: usize,
    settings: usize,
    reading_positions: usize,
    vocabulary: usize,
    vocabulary_sources: usize,
    saved_contexts: usize,
    study_plans: usize,
    review_cards: usize,
    review_events: usize,
    reinforcement_events: usize,
    review_suspensions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableManifest {
    format: String,
    format_version: i64,
    app_version: String,
    database_schema_version: i64,
    content_id_version: i64,
    created_at: String,
    policy: String,
    files: Vec<ManifestFile>,
    counts: ManifestCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    pub schema_version: i64,
    pub format_version: i64,
    pub publication_count: i64,
    pub vocabulary_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableImportPreview {
    pub token: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub publication_count: usize,
    pub new_publication_count: usize,
    pub duplicate_publication_count: usize,
    pub setting_count: usize,
    pub reading_position_count: usize,
    pub vocabulary_count: usize,
    pub vocabulary_source_count: usize,
    pub saved_context_count: usize,
    pub study_plan_count: usize,
    pub review_card_count: usize,
    pub review_event_count: usize,
    pub reinforcement_event_count: usize,
    pub suspended_word_count: usize,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub preview: PortableImportPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTransferResult {
    pub file_name: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_publications: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_publications: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_settings: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_reading_positions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_vocabulary: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_vocabulary_sources: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_saved_contexts: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_study_plans: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_review_cards: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_review_events: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_reinforcement_events: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_review_suspensions: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedMetadata {
    pub token: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub packages: Vec<StagedPackage>,
    pub duplicate_publications: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedPackage {
    pub publication_id: String,
    pub content_hash: String,
    pub format_id: String,
}

#[derive(Debug, Default)]
pub struct MergeResult {
    pub settings: usize,
    pub reading_positions: usize,
    pub vocabulary: usize,
    pub vocabulary_sources: usize,
    pub saved_contexts: usize,
    pub study_plans: usize,
    pub review_cards: usize,
    pub review_events: usize,
    pub reinforcement_events: usize,
    pub review_suspensions: usize,
}

#[derive(Debug, Default)]
struct ArchiveScan {
    counts: HashMap<&'static str, usize>,
    lifecycle_by_hash: HashMap<String, Map<String, Value>>,
    lifecycle_publication_ids: HashSet<String>,
    present_hashes: HashSet<String>,
    present_count: usize,
    active_vocabulary: HashSet<String>,
    active_counts: HashMap<&'static str, usize>,
}

pub fn prepare(paths: &PlatformPaths) -> Result<(), PlatformError> {
    let root = paths.persistent_staging.join("portable");
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    }
    fs::create_dir_all(root).map_err(|_| PlatformError::storage_unavailable())
}

pub fn data_status(database: &AndroidDatabase) -> Result<DataStatus, PlatformError> {
    let connection = database.connection();
    Ok(DataStatus {
        schema_version: LATEST_SCHEMA_VERSION,
        format_version: FORMAT_VERSION,
        publication_count: connection
            .query_row("SELECT count(*) FROM publications", [], |row| row.get(0))
            .map_err(|_| PlatformError::database_corrupt())?,
        vocabulary_count: connection
            .query_row("SELECT count(*) FROM user_lexemes", [], |row| row.get(0))
            .map_err(|_| PlatformError::database_corrupt())?,
    })
}

pub fn export_archive(
    database: &AndroidDatabase,
    paths: &PlatformPaths,
    destination: &Path,
    app_version: &str,
) -> Result<PortableTransferResult, PlatformError> {
    let work = paths
        .temporary_staging
        .join(format!("portable-export-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&work).map_err(|_| PlatformError::storage_unavailable())?;
    let result = (|| {
        let mut logical = Vec::<(ManifestFile, PathBuf, bool)>::new();
        let mut counts = ManifestCounts::default();
        for dataset in DATASETS {
            let file_path = dataset
                .path
                .split('/')
                .fold(work.clone(), |path, part| path.join(part));
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
            }
            let record_count = write_dataset_records(database.connection(), dataset, &file_path)?;
            set_manifest_count(&mut counts, dataset.table, record_count);
            let (size, sha256) = hash_file(&file_path)?;
            logical.push((
                ManifestFile {
                    path: dataset.path.into(),
                    size,
                    sha256,
                    kind: dataset.kind.into(),
                },
                file_path,
                false,
            ));
        }
        let mut statement = database
            .connection()
            .prepare("SELECT p.id,p.hash FROM publications p JOIN publication_lifecycle l ON l.publication_id=p.id WHERE l.state='present' ORDER BY p.imported_at")
            .map_err(|_| PlatformError::database_corrupt())?;
        let books = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| PlatformError::database_corrupt())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlatformError::database_corrupt())?;
        drop(statement);
        let publication_count: i64 = database
            .connection()
            .query_row("SELECT COUNT(*) FROM publications", [], |row| row.get(0))
            .map_err(|_| PlatformError::database_corrupt())?;
        let active_lifecycle_count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM publication_lifecycle WHERE state='present'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        if books.len() as i64 != publication_count || books.len() as i64 != active_lifecycle_count {
            return Err(invalid_backup(
                "活动刊物与生命周期记录不一致，无法生成完整备份。",
            ));
        }
        for (publication_id, hash) in books {
            let source = work.join("publications").join(format!("{hash}.fprpub"));
            let package = publication_package::create(
                database,
                &paths.data.join("library"),
                &publication_id,
                &source,
            )?;
            logical.push((
                ManifestFile {
                    path: format!("publications/{hash}.fprpub"),
                    size: package.byte_length,
                    sha256: package.payload_sha256,
                    kind: "publication-package".into(),
                },
                source,
                true,
            ));
        }
        counts.publications = logical
            .iter()
            .filter(|(file, _, _)| file.kind == "publication-package")
            .count();
        let total = logical.iter().try_fold(0_u64, |sum, (file, _, _)| {
            sum.checked_add(file.size)
                .filter(|value| *value <= MAX_ARCHIVE_BYTES)
                .ok_or_else(|| invalid_backup("便携备份超过 20 GB 限制。"))
        })?;
        let manifest = PortableManifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            app_version: app_version.into(),
            database_schema_version: LATEST_SCHEMA_VERSION,
            content_id_version: CONTENT_ID_VERSION,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            policy: "essential-user-data".into(),
            files: logical.iter().map(|(file, _, _)| file.clone()).collect(),
            counts,
        };
        let output = File::create(destination).map_err(|_| PlatformError::storage_unavailable())?;
        let mut zip = ZipWriter::new(output);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("manifest.json", deflated)
            .map_err(|_| PlatformError::storage_unavailable())?;
        zip.write_all(
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|_| invalid_backup("无法生成便携备份清单。"))?,
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
        for (entry, source, book) in &logical {
            zip.start_file(&entry.path, if *book { stored } else { deflated })
                .map_err(|_| PlatformError::storage_unavailable())?;
            let mut input = File::open(source).map_err(|_| PlatformError::storage_unavailable())?;
            std::io::copy(&mut input, &mut zip)
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
        zip.finish()
            .map_err(|_| PlatformError::storage_unavailable())?;
        let bytes = fs::metadata(destination)
            .map_err(|_| PlatformError::storage_unavailable())?
            .len();
        let _ = total;
        Ok(PortableTransferResult {
            file_name: destination
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("外刊阅读器.fprbackup")
                .into(),
            bytes,
            imported_publications: None,
            duplicate_publications: None,
            merged_settings: None,
            merged_reading_positions: None,
            merged_vocabulary: None,
            merged_vocabulary_sources: None,
            merged_saved_contexts: None,
            merged_study_plans: None,
            merged_review_cards: None,
            merged_review_events: None,
            merged_reinforcement_events: None,
            merged_review_suspensions: None,
        })
    })();
    let _ = fs::remove_dir_all(work);
    result
}

pub fn inspect_archive(
    database: &AndroidDatabase,
    archive_path: &Path,
    token_root: &Path,
    token: &str,
    file_name: &str,
) -> Result<InspectResult, PlatformError> {
    let manifest = validate_archive(archive_path)?;
    let scan = scan_archive_records(archive_path, &manifest)?;
    let total_bytes = manifest.files.iter().map(|file| file.size).sum();
    let package_hashes = manifest
        .files
        .iter()
        .filter(|file| file.kind == "publication-package")
        .filter_map(|file| {
            file.path
                .strip_prefix("publications/")
                .and_then(|value| value.strip_suffix(".fprpub"))
                .map(str::to_owned)
        })
        .collect::<HashSet<_>>();
    let lifecycle_count = scan
        .counts
        .get("publication_lifecycle")
        .copied()
        .unwrap_or(0);
    if scan.lifecycle_by_hash.len() != lifecycle_count
        || scan.lifecycle_publication_ids.len() != lifecycle_count
        || manifest.counts.publications != package_hashes.len()
        || scan.present_hashes.len() != scan.present_count
        || package_hashes != scan.present_hashes
    {
        return Err(invalid_backup("备份中的活动刊物与解析内容包不一致。"));
    }
    let mut packages = Vec::new();
    let mut included = 0_usize;
    let mut duplicates = 0_usize;
    for file in manifest
        .files
        .iter()
        .filter(|file| file.kind == "publication-package")
    {
        let hash = file
            .path
            .strip_prefix("publications/")
            .and_then(|value| value.strip_suffix(".fprpub"))
            .ok_or_else(|| invalid_backup("备份中的刊物包路径无效。"))?;
        let incoming = scan.lifecycle_by_hash.get(hash);
        if incoming
            .and_then(|row| row.get("state"))
            .and_then(Value::as_str)
            != Some("present")
        {
            return Err(invalid_backup("刊物包缺少活动生命周期记录。"));
        }
        let current = database.connection().query_row("SELECT state,changed_at,device_id FROM publication_lifecycle WHERE content_hash=?1", [hash], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional().map_err(|_| PlatformError::database_corrupt())?;
        if let (Some(row), Some((state, changed_at, device_id))) = (incoming, current.as_ref()) {
            if state == "deleted" && compare_version(row, "changedAt", changed_at, device_id) <= 0 {
                continue;
            }
        }
        included += 1;
        let exists: bool = database
            .connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM publications WHERE hash=?1)",
                [hash],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        if exists {
            duplicates += 1;
            continue;
        }
        let package_path = token_root
            .join("package-files")
            .join(format!("{hash}.fprpub"));
        extract_entry(
            archive_path,
            &file.path,
            &package_path,
            file.size,
            &file.sha256,
        )?;
        let extracted_root = token_root.join("publications").join(hash);
        let inspected = publication_package::inspect_and_extract(&package_path, &extracted_root)?;
        if inspected.manifest.source_content_sha256 != hash {
            return Err(invalid_backup("刊物包文件名与内容身份不一致。"));
        }
        let incoming = incoming.ok_or_else(|| invalid_backup("刊物包缺少活动生命周期记录。"))?;
        if incoming.get("publicationId").and_then(Value::as_str) != Some(inspected.plan.id.as_str())
            || incoming.get("formatId").and_then(Value::as_str)
                != Some(inspected.manifest.source_format.as_str())
        {
            return Err(invalid_backup("刊物包与生命周期记录身份不一致。"));
        }
        packages.push(StagedPackage {
            publication_id: inspected.plan.id,
            content_hash: inspected.plan.hash,
            format_id: inspected.manifest.source_format,
        });
    }
    let count = |table: &'static str| scan.counts.get(table).copied().unwrap_or(0);
    let count_active = |table: &'static str| scan.active_counts.get(table).copied().unwrap_or(0);
    let metadata = StagedMetadata {
        token: token.into(),
        file_name: file_name.chars().take(240).collect(),
        total_bytes,
        packages,
        duplicate_publications: duplicates,
    };
    write_staged_metadata(token_root, &metadata)?;
    let preview = PortableImportPreview {
        token: token.into(),
        file_name: metadata.file_name.clone(),
        total_bytes,
        publication_count: included,
        new_publication_count: metadata.packages.len(),
        duplicate_publication_count: duplicates,
        setting_count: count("settings"),
        reading_position_count: count("reading_positions"),
        vocabulary_count: scan.active_vocabulary.len(),
        vocabulary_source_count: count_active("vocabulary_sources"),
        saved_context_count: count_active("saved_contexts"),
        study_plan_count: count("study_plans"),
        review_card_count: count("review_cards"),
        review_event_count: count("review_events"),
        reinforcement_event_count: count("reinforcement_events"),
        suspended_word_count: count_active("review_suspensions"),
        created_at: manifest.created_at,
    };
    Ok(InspectResult { preview })
}

fn write_staged_metadata(
    token_root: &Path,
    metadata: &StagedMetadata,
) -> Result<(), PlatformError> {
    fs::write(
        token_root.join("staged.json"),
        serde_json::to_vec(metadata).map_err(|_| invalid_backup("无法暂存便携备份。"))?,
    )
    .map_err(|_| PlatformError::storage_unavailable())
}

pub fn staged_metadata(root: &Path, token: &str) -> Result<StagedMetadata, PlatformError> {
    require_token(token)?;
    let bytes = fs::read(root.join(token).join("staged.json"))
        .map_err(|_| invalid_backup("导入预览已失效，请重新选择备份包。"))?;
    let metadata: StagedMetadata = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_backup("导入预览已失效，请重新选择备份包。"))?;
    if metadata.token != token {
        return Err(invalid_backup("导入预览已失效，请重新选择备份包。"));
    }
    Ok(metadata)
}

pub fn restore_staged_package(
    database: &mut AndroidDatabase,
    paths: &PlatformPaths,
    token_root: &Path,
    package: &StagedPackage,
) -> Result<crate::mobile_reading::ImportResult, PlatformError> {
    if !is_sha256(&package.content_hash) || package.publication_id.is_empty() {
        return Err(invalid_backup("暂存刊物包身份无效。"));
    }
    let package_path = token_root
        .join("package-files")
        .join(format!("{}.fprpub", package.content_hash));
    let extracted_root = token_root.join("restore").join(&package.content_hash);
    let _ = fs::remove_dir_all(&extracted_root);
    let inspected = publication_package::inspect_and_extract(&package_path, &extracted_root)?;
    if inspected.plan.id != package.publication_id
        || inspected.plan.hash != package.content_hash
        || inspected.manifest.source_format != package.format_id
    {
        return Err(invalid_backup("暂存刊物包与预览不一致。"));
    }
    publication_package::restore(database, &paths.data.join("library"), &inspected)
}

pub fn discard(root: &Path, token: &str) -> Result<(), PlatformError> {
    require_token(token)?;
    let target = root.join(token);
    if target.starts_with(root) {
        let _ = fs::remove_dir_all(target);
    }
    Ok(())
}

pub fn create_safety_backup(
    database: &AndroidDatabase,
    paths: &PlatformPaths,
) -> Result<PathBuf, PlatformError> {
    let root = paths.data.join("backups").join("migrations");
    fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    let destination = root.join(format!(
        "{}-before-portable-import.sqlite",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    let mut output =
        Connection::open(&destination).map_err(|_| PlatformError::storage_unavailable())?;
    let backup = rusqlite::backup::Backup::new(database.connection(), &mut output)
        .map_err(|_| PlatformError::storage_unavailable())?;
    backup
        .run_to_completion(32, Duration::from_millis(5), None)
        .map_err(|_| PlatformError::storage_unavailable())?;
    drop(backup);
    let check: String = output
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| PlatformError::storage_unavailable())?;
    if check != "ok" {
        let _ = fs::remove_file(&destination);
        return Err(PlatformError::storage_unavailable());
    }
    drop(output);
    let mut backups = fs::read_dir(&root)
        .map_err(|_| PlatformError::storage_unavailable())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with("-before-portable-import.sqlite")
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|entry| entry.file_name());
    let excess = backups.len().saturating_sub(5);
    for old in backups.into_iter().take(excess) {
        let _ = fs::remove_file(old.path());
    }
    Ok(destination)
}

pub fn merge_archive(
    database: &mut AndroidDatabase,
    archive_path: &Path,
) -> Result<MergeResult, PlatformError> {
    let manifest = validate_archive(archive_path)?;
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut result = MergeResult::default();
    for dataset in DATASETS {
        visit_dataset_records(archive_path, &manifest, dataset, |mut record| {
            if !normalize_record(&transaction, dataset, &mut record)? {
                return Ok(());
            }
            if matches!(
                dataset.table,
                "review_cards" | "review_events" | "reinforcement_events" | "review_suspensions"
            ) && reset_blocks(&transaction, dataset.table, &record)?
            {
                return Ok(());
            }
            if merge_record(&transaction, dataset, &record, MergePolicy::NewerWins)? {
                increment_merge(&mut result, dataset.table);
            }
            Ok(())
        })?;
        if dataset.table == "study_lexeme_resets" {
            apply_resets(&transaction)?;
        }
    }
    let reset: Option<String> = transaction
        .query_row(
            "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .flatten();
    if reset.is_some() {
        transaction.execute("DELETE FROM scheduler_profiles WHERE NOT EXISTS(SELECT 1 FROM review_events WHERE review_events.profile_id=scheduler_profiles.profile_id)", []).map_err(|_| PlatformError::storage_unavailable())?;
    }
    transaction
        .commit()
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(result)
}

pub(crate) fn sync_export_raw_records(
    connection: &Connection,
) -> Result<Vec<SyncRawRecord>, PlatformError> {
    let mut result = Vec::new();
    for dataset in DATASETS {
        for value in export_records(connection, dataset)? {
            let Value::Object(record) = value else {
                return Err(PlatformError::database_corrupt());
            };
            result.push(SyncRawRecord {
                table: dataset.table.to_owned(),
                record,
            });
        }
    }
    Ok(result)
}

pub(crate) fn sync_apply_incoming_records(
    database: &mut AndroidDatabase,
    records: &[SyncRawRecord],
    sender_device_id: &str,
    batch_id: &str,
    payload_sha256: &str,
    sender_revision: i64,
) -> Result<SyncIncomingMergeResult, PlatformError> {
    sync_apply_incoming_records_inner(
        database,
        records,
        sender_device_id,
        batch_id,
        payload_sha256,
        sender_revision,
    )
    .map_err(|error| {
        if error.code == "storageUnavailable" {
            PlatformError::new(
                "syncCommitFailed",
                "同步记录写入失败，已安全回滚；本地数据未改变。",
                true,
            )
        } else {
            error
        }
    })
}

fn sync_apply_incoming_records_inner(
    database: &mut AndroidDatabase,
    records: &[SyncRawRecord],
    sender_device_id: &str,
    batch_id: &str,
    payload_sha256: &str,
    sender_revision: i64,
) -> Result<SyncIncomingMergeResult, PlatformError> {
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT payload_sha256 FROM sync_receipts WHERE sender_device_id=?1 AND batch_id=?2",
            [sender_device_id, batch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    if let Some(existing) = existing {
        if existing != payload_sha256 {
            return Err(PlatformError::new(
                "syncReceiptCollision",
                "重复同步批次的内容不一致。",
                false,
            ));
        }
        let local_revision = transaction
            .query_row(
                "SELECT current_revision FROM sync_clock WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        transaction
            .commit()
            .map_err(|_| PlatformError::storage_unavailable())?;
        return Ok(SyncIncomingMergeResult {
            duplicate: true,
            applied_records: 0,
            unchanged_records: records.len(),
            local_revision,
        });
    }

    let mut applied = 0_usize;
    for raw in records {
        let dataset = DATASETS
            .iter()
            .find(|dataset| dataset.table == raw.table)
            .ok_or_else(|| PlatformError::new("syncInvalid", "同步记录类型无效。", false))?;
        let mut record = raw.record.clone();
        validate_record(dataset, &record)?;
        if !normalize_record(&transaction, dataset, &mut record)? {
            continue;
        }
        if matches!(
            dataset.table,
            "review_cards" | "review_events" | "reinforcement_events" | "review_suspensions"
        ) && reset_blocks(&transaction, dataset.table, &record)?
        {
            continue;
        }
        if merge_record(&transaction, dataset, &record, MergePolicy::IncomingWins)? {
            applied += 1;
        }
        if dataset.table == "study_lexeme_resets" {
            apply_resets(&transaction)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO sync_receipts(sender_device_id,batch_id,payload_sha256,sender_through_revision,applied_at) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![
                sender_device_id,
                batch_id,
                payload_sha256,
                sender_revision,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    transaction
        .execute(
            "INSERT INTO sync_peer_state(peer_device_id,outbound_acked_revision,inbound_applied_revision,peer_inspected_revision,last_sync_at) VALUES(?1,0,?2,0,?3) \
             ON CONFLICT(peer_device_id) DO UPDATE SET inbound_applied_revision=max(sync_peer_state.inbound_applied_revision,excluded.inbound_applied_revision),last_sync_at=excluded.last_sync_at",
            rusqlite::params![
                sender_device_id,
                sender_revision,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    let local_revision = transaction
        .query_row(
            "SELECT current_revision FROM sync_clock WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    transaction
        .commit()
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(SyncIncomingMergeResult {
        duplicate: false,
        applied_records: applied,
        unchanged_records: records.len().saturating_sub(applied),
        local_revision,
    })
}

pub fn transfer_result(
    metadata: &StagedMetadata,
    imported: usize,
    merged: MergeResult,
) -> PortableTransferResult {
    PortableTransferResult {
        file_name: metadata.file_name.clone(),
        bytes: metadata.total_bytes,
        imported_publications: Some(imported),
        duplicate_publications: Some(metadata.duplicate_publications),
        merged_settings: Some(merged.settings),
        merged_reading_positions: Some(merged.reading_positions),
        merged_vocabulary: Some(merged.vocabulary),
        merged_vocabulary_sources: Some(merged.vocabulary_sources),
        merged_saved_contexts: Some(merged.saved_contexts),
        merged_study_plans: Some(merged.study_plans),
        merged_review_cards: Some(merged.review_cards),
        merged_review_events: Some(merged.review_events),
        merged_reinforcement_events: Some(merged.reinforcement_events),
        merged_review_suspensions: Some(merged.review_suspensions),
    }
}

fn export_records(connection: &Connection, dataset: &Dataset) -> Result<Vec<Value>, PlatformError> {
    let query = dataset_query(dataset);
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([], |row| row_to_json(row, dataset))
        .map_err(|_| PlatformError::database_corrupt())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())
}

fn dataset_query(dataset: &Dataset) -> String {
    let where_clause = if dataset.table == "settings" {
        " WHERE key IN ('reader.preferences','dictionary.preferences','study.preferences','speech.preferences','translation.preferences','library.management')"
    } else {
        ""
    };
    format!(
        "SELECT {} FROM {}{} ORDER BY {}",
        dataset
            .columns
            .iter()
            .map(|column| column.sql)
            .collect::<Vec<_>>()
            .join(","),
        dataset.table,
        where_clause,
        dataset.keys.join(",")
    )
}

fn row_to_json(row: &rusqlite::Row<'_>, dataset: &Dataset) -> rusqlite::Result<Value> {
    let mut object = Map::new();
    for (index, column) in dataset.columns.iter().enumerate() {
        object.insert(
            column.json.into(),
            sql_ref_to_json(row.get_ref(index)?, column.boolean),
        );
    }
    Ok(Value::Object(object))
}

fn sql_ref_to_json(value: rusqlite::types::ValueRef<'_>, boolean: bool) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) if boolean => Value::Bool(value != 0),
        ValueRef::Integer(value) => Value::Number(Number::from(value)),
        ValueRef::Real(value) => Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn write_dataset_records(
    connection: &Connection,
    dataset: &Dataset,
    path: &Path,
) -> Result<usize, PlatformError> {
    let mut output =
        BufWriter::new(File::create(path).map_err(|_| PlatformError::storage_unavailable())?);
    if dataset.settings_json {
        output
            .write_all(b"[")
            .map_err(|_| PlatformError::storage_unavailable())?;
    }

    let query = dataset_query(dataset);
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut rows = statement
        .query([])
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut count = 0_usize;
    while let Some(row) = rows.next().map_err(|_| PlatformError::database_corrupt())? {
        let value = row_to_json(row, dataset).map_err(|_| PlatformError::database_corrupt())?;
        let encoded =
            serde_json::to_vec(&value).map_err(|_| PlatformError::storage_unavailable())?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(invalid_backup("单条便携备份记录超过 1 MiB 限制。"));
        }
        if dataset.settings_json && count > 0 {
            output
                .write_all(b",")
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
        output
            .write_all(&encoded)
            .map_err(|_| PlatformError::storage_unavailable())?;
        if !dataset.settings_json {
            output
                .write_all(b"\n")
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
        count += 1;
    }
    drop(rows);
    drop(statement);

    if dataset.settings_json {
        output
            .write_all(b"]")
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    output
        .flush()
        .map_err(|_| PlatformError::storage_unavailable())?;
    let file = output
        .into_inner()
        .map_err(|_| PlatformError::storage_unavailable())?;
    file.sync_all()
        .map_err(|_| PlatformError::storage_unavailable())?;
    if dataset.settings_json
        && file
            .metadata()
            .map_err(|_| PlatformError::storage_unavailable())?
            .len()
            > MAX_SETTINGS_BYTES
    {
        return Err(invalid_backup("便携备份设置文件超过 1 MiB 限制。"));
    }
    Ok(count)
}

fn validate_archive(path: &Path) -> Result<PortableManifest, PlatformError> {
    let size = fs::metadata(path)
        .map_err(|_| invalid_backup("无法读取便携备份。"))?
        .len();
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err(invalid_backup("便携备份超过 20 GB 限制。"));
    }
    let mut archive =
        ZipArchive::new(File::open(path).map_err(|_| invalid_backup("无法读取便携备份。"))?)
            .map_err(|_| invalid_backup("文件不是有效的便携备份。"))?;
    if archive.is_empty() || archive.len() > MAX_ENTRIES {
        return Err(invalid_backup("便携备份文件数量无效。"));
    }
    let mut names = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| invalid_backup("便携备份目录损坏。"))?;
        let name = file.name().to_owned();
        if file.is_dir()
            || file.enclosed_name().is_none()
            || name.contains('\\')
            || !names.insert(name)
        {
            return Err(invalid_backup("便携备份包含不安全路径。"));
        }
        expanded = expanded
            .checked_add(file.size())
            .filter(|value| *value <= MAX_ARCHIVE_BYTES)
            .ok_or_else(|| invalid_backup("便携备份解压后过大。"))?;
        if file.size() > 1024 * 1024
            && file.compressed_size() > 0
            && file.size() > file.compressed_size().saturating_mul(MAX_EXPANSION_RATIO)
        {
            return Err(invalid_backup("便携备份压缩比异常。"));
        }
    }
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| invalid_backup("便携备份缺少 manifest.json。"))?;
    if manifest_file.size() == 0 || manifest_file.size() > MAX_MANIFEST_BYTES {
        return Err(invalid_backup("便携备份清单大小无效。"));
    }
    let mut bytes = Vec::with_capacity(manifest_file.size() as usize);
    manifest_file
        .read_to_end(&mut bytes)
        .map_err(|_| invalid_backup("无法读取便携备份清单。"))?;
    drop(manifest_file);
    let manifest: PortableManifest =
        serde_json::from_slice(&bytes).map_err(|_| invalid_backup("便携备份清单无效。"))?;
    if manifest.format != FORMAT
        || manifest.format_version != FORMAT_VERSION
        || manifest.database_schema_version != LATEST_SCHEMA_VERSION
        || manifest.content_id_version != CONTENT_ID_VERSION
        || manifest.policy != "essential-user-data"
    {
        return Err(invalid_backup("不支持此备份格式或版本。"));
    }
    if manifest.app_version.is_empty()
        || manifest.app_version.len() > 128
        || DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
    {
        return Err(invalid_backup("便携备份清单元数据无效。"));
    }
    if manifest.files.len() + 1 != archive.len() {
        return Err(invalid_backup("便携备份文件清单不一致。"));
    }
    let expected = DATASETS
        .iter()
        .map(|item| (item.path, item.kind))
        .collect::<HashMap<_, _>>();
    let mut logical_seen = HashSet::new();
    for entry in &manifest.files {
        if entry.size > MAX_ARCHIVE_BYTES
            || !is_sha256(&entry.sha256)
            || !logical_seen.insert(entry.path.as_str())
        {
            return Err(invalid_backup("便携备份文件清单无效。"));
        }
        if entry.kind == "publication-package" {
            let hash = entry
                .path
                .strip_prefix("publications/")
                .and_then(|value| value.strip_suffix(".fprpub"))
                .ok_or_else(|| invalid_backup("备份中的刊物包路径无效。"))?;
            if !is_sha256(hash) {
                return Err(invalid_backup("备份中的刊物包身份无效。"));
            }
        } else if expected.get(entry.path.as_str()).copied() != Some(entry.kind.as_str()) {
            return Err(invalid_backup("便携备份包含未知的数据文件。"));
        }
        if entry.path == "data/settings.json" && entry.size > MAX_SETTINGS_BYTES {
            return Err(invalid_backup("便携备份设置文件超过 1 MiB 限制。"));
        }
        let mut source = archive
            .by_name(&entry.path)
            .map_err(|_| invalid_backup("便携备份缺少清单文件。"))?;
        if source.size() != entry.size {
            return Err(invalid_backup("便携备份文件大小校验失败。"));
        }
        let actual = hash_reader(&mut source)?;
        if actual != entry.sha256 {
            return Err(invalid_backup("便携备份完整性校验失败。"));
        }
    }
    for dataset in DATASETS {
        if !logical_seen.contains(dataset.path) {
            return Err(invalid_backup("便携备份缺少必要数据文件。"));
        }
    }
    Ok(manifest)
}

fn visit_dataset_records<F>(
    path: &Path,
    manifest: &PortableManifest,
    dataset: &Dataset,
    mut visitor: F,
) -> Result<usize, PlatformError>
where
    F: FnMut(Map<String, Value>) -> Result<(), PlatformError>,
{
    let mut archive =
        ZipArchive::new(File::open(path).map_err(|_| invalid_backup("无法读取便携备份。"))?)
            .map_err(|_| invalid_backup("文件不是有效的便携备份。"))?;
    let listed = manifest
        .files
        .iter()
        .find(|file| file.path == dataset.path)
        .ok_or_else(|| invalid_backup("便携备份缺少必要数据文件。"))?;
    let file = archive
        .by_name(&listed.path)
        .map_err(|_| invalid_backup("便携备份缺少必要数据文件。"))?;
    let mut count = 0_usize;
    if dataset.settings_json {
        if file.size() > MAX_SETTINGS_BYTES {
            return Err(invalid_backup("便携备份设置文件超过 1 MiB 限制。"));
        }
        let values: Vec<Value> =
            serde_json::from_reader(file).map_err(|_| invalid_backup("便携备份数据无效。"))?;
        for value in values {
            if serde_json::to_vec(&value)
                .map_err(|_| invalid_backup("便携备份记录无效。"))?
                .len()
                > MAX_RECORD_BYTES
            {
                return Err(invalid_backup("单条便携备份记录超过 1 MiB 限制。"));
            }
            let record = value
                .as_object()
                .cloned()
                .ok_or_else(|| invalid_backup("便携备份记录无效。"))?;
            validate_record(dataset, &record)?;
            visitor(record)?;
            count += 1;
        }
    } else {
        let mut reader = BufReader::new(file);
        while let Some(line) = read_bounded_json_line(&mut reader)? {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| invalid_backup("便携备份记录无效。"))?;
            let record = value
                .as_object()
                .cloned()
                .ok_or_else(|| invalid_backup("便携备份记录无效。"))?;
            validate_record(dataset, &record)?;
            visitor(record)?;
            count += 1;
        }
    }
    Ok(count)
}

fn read_bounded_json_line<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, PlatformError> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| invalid_backup("无法读取便携备份数据。"))?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Ok(Some(line));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload_length = newline.unwrap_or(available.len());
        if line.len().saturating_add(payload_length) > MAX_RECORD_BYTES {
            return Err(invalid_backup("单条便携备份记录超过 1 MiB 限制。"));
        }
        line.extend_from_slice(&available[..payload_length]);
        let consumed = newline
            .map(|position| position + 1)
            .unwrap_or(payload_length);
        reader.consume(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn scan_archive_records(
    path: &Path,
    manifest: &PortableManifest,
) -> Result<ArchiveScan, PlatformError> {
    let mut scan = ArchiveScan::default();
    for dataset in DATASETS {
        let count = visit_dataset_records(path, manifest, dataset, |record| {
            if dataset.table == "publication_lifecycle" {
                let hash = record
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_backup("刊物生命周期记录无效。"))?
                    .to_owned();
                let publication_id = record
                    .get("publicationId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid_backup("刊物生命周期记录无效。"))?
                    .to_owned();
                if record.get("state").and_then(Value::as_str) == Some("present") {
                    scan.present_count += 1;
                    scan.present_hashes.insert(hash.clone());
                }
                scan.lifecycle_publication_ids.insert(publication_id);
                scan.lifecycle_by_hash.insert(hash, record);
            } else {
                if dataset.table == "vocabulary_sources"
                    && record.get("active").and_then(Value::as_bool) == Some(true)
                    && record.get("sourceType").and_then(Value::as_str) == Some("reader_manual")
                {
                    let lexeme_key = record
                        .get("lexemeKey")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid_backup("词汇来源记录无效。"))?;
                    scan.active_vocabulary.insert(lexeme_key.to_owned());
                }
                if matches!(
                    dataset.table,
                    "vocabulary_sources" | "saved_contexts" | "review_suspensions"
                ) && record.get("active").and_then(Value::as_bool) == Some(true)
                {
                    *scan.active_counts.entry(dataset.table).or_default() += 1;
                }
            }
            Ok(())
        })?;
        if let Some(expected) = manifest_count_for(&manifest.counts, dataset.table) {
            if expected != count {
                return Err(invalid_backup("便携备份记录数校验失败。"));
            }
        }
        scan.counts.insert(dataset.table, count);
    }
    Ok(scan)
}

fn validate_record(dataset: &Dataset, record: &Map<String, Value>) -> Result<(), PlatformError> {
    if record.len() != dataset.columns.len()
        || dataset
            .columns
            .iter()
            .any(|column| !record.contains_key(column.json))
    {
        return Err(invalid_backup("便携备份记录字段无效。"));
    }
    if dataset.table == "settings" {
        let key = record
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_backup("设置记录无效。"))?;
        if !SETTINGS.contains(&key) {
            return Err(invalid_backup("便携备份包含不允许的设置。"));
        }
        let encoded = record
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_backup("设置记录无效。"))?;
        serde_json::from_str::<Value>(encoded).map_err(|_| invalid_backup("设置记录无效。"))?;
    }
    for column in dataset.columns {
        let value = record.get(column.json).expect("validated key");
        if value.is_null() {
            if !is_nullable_field(dataset.table, column.json) {
                return Err(invalid_backup("便携备份记录字段不能为空。"));
            }
            continue;
        }
        if column.boolean && !value.is_boolean() {
            return Err(invalid_backup("便携备份布尔字段无效。"));
        }
        let numeric = is_number_field(column.json)
            || (dataset.table == "review_cards" && column.json == "state");
        if !column.boolean && numeric && !value.is_number() {
            return Err(invalid_backup("便携备份数值字段无效。"));
        }
        if !(column.boolean || numeric || value.is_string()) {
            return Err(invalid_backup("便携备份文本字段无效。"));
        }
        let valid_timestamp = value
            .as_str()
            .map(|text| DateTime::parse_from_rfc3339(text).is_ok())
            .unwrap_or(false);
        if column.json.ends_with("At") && !valid_timestamp {
            return Err(invalid_backup("便携备份时间字段无效。"));
        }
    }
    if dataset.table == "publication_lifecycle"
        && (!record
            .get("contentHash")
            .and_then(Value::as_str)
            .is_some_and(is_sha256)
            || !matches!(
                record.get("state").and_then(Value::as_str),
                Some("present" | "deleted")
            ))
    {
        return Err(invalid_backup("刊物生命周期记录无效。"));
    }
    Ok(())
}

fn is_number_field(field: &str) -> bool {
    matches!(
        field,
        "scrollTop"
            | "anchorTokenIndex"
            | "anchorFraction"
            | "bncRank"
            | "frequencyRank"
            | "manualFamiliarity"
            | "snapshotQuality"
            | "position"
            | "tokenIndex"
            | "dailyNewLimit"
            | "dailyReviewLimit"
            | "stability"
            | "difficulty"
            | "elapsedDays"
            | "scheduledDays"
            | "learningSteps"
            | "reps"
            | "lapses"
            | "rating"
            | "consecutiveBefore"
            | "consecutiveAfter"
    )
}

fn is_nullable_field(table: &str, field: &str) -> bool {
    matches!(
        (table, field),
        (
            "reading_positions",
            "anchorBlockId" | "anchorTokenIndex" | "anchorFraction"
        ) | (
            "user_lexemes",
            "phoneticSnapshot" | "bncRank" | "frequencyRank" | "manualFamiliarity"
        ) | (
            "lexeme_examples",
            "translationZh" | "partOfSpeech" | "definition"
        ) | ("vocabulary_sources", "removedAt")
            | (
                "saved_contexts",
                "publicationId" | "articleId" | "blockId" | "removedAt"
            )
            | ("study_plans", "deletedAt")
            | ("study_plan_sources", "removedAt")
            | ("study_plan_lexeme_origins", "removedAt")
            | ("study_plan_exclusions", "excludedAt" | "restoredAt")
            | ("review_cards", "lastReviewAt")
            | ("review_events" | "reinforcement_events", "planId")
            | ("review_suspensions", "restoredAt")
            | ("study_progress_state", "resetAt")
    )
}

fn merge_record(
    transaction: &rusqlite::Transaction<'_>,
    dataset: &Dataset,
    record: &Map<String, Value>,
    policy: MergePolicy,
) -> Result<bool, PlatformError> {
    let db = record_to_db(dataset, record)?;
    let where_clause = dataset
        .keys
        .iter()
        .map(|key| format!("{key}=?"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let key_values = dataset
        .keys
        .iter()
        .map(|key| db.get(*key).cloned().unwrap_or(SqlValue::Null))
        .collect::<Vec<_>>();
    let current = load_current(transaction, dataset, &where_clause, &key_values)?;
    if let Some(current) = current {
        if current == *record {
            return Ok(false);
        }
        if dataset.immutable {
            return Err(invalid_backup("便携备份中的不可变学习记录发生冲突。"));
        }
        if policy == MergePolicy::NewerWins {
            if let Some((time, device)) = dataset.version {
                let incoming_time = db_text(&db, time);
                let incoming_device = db_text(&db, device);
                let current_time = current
                    .get(json_name(dataset, time))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let current_device = current
                    .get(json_name(dataset, device))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if (incoming_time.as_str(), incoming_device.as_str())
                    <= (current_time, current_device)
                {
                    return Ok(false);
                }
            }
        }
    }
    if dataset.table == "publication_lifecycle"
        && record.get("state").and_then(Value::as_str) == Some("present")
    {
        let publication = record
            .get("publicationId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let hash = record
            .get("contentHash")
            .and_then(Value::as_str)
            .unwrap_or("");
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM publications WHERE id=?1 AND hash=?2)",
                [publication, hash],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        if !exists {
            return Err(invalid_backup("备份刊物缺少对应的解析内容包。"));
        }
    }
    let columns = dataset
        .columns
        .iter()
        .map(|column| column.sql)
        .collect::<Vec<_>>();
    let values = columns
        .iter()
        .map(|name| db.get(*name).cloned().unwrap_or(SqlValue::Null))
        .collect::<Vec<_>>();
    let update = if let Some(custom) = dataset.custom_update {
        custom.to_owned()
    } else {
        let selected = dataset
            .update_columns
            .map(|items| items.to_vec())
            .unwrap_or_else(|| {
                columns
                    .iter()
                    .copied()
                    .filter(|name| !dataset.keys.contains(name))
                    .collect()
            });
        selected
            .iter()
            .map(|name| format!("{name}=excluded.{name}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let sql = format!(
        "INSERT INTO {}({}) VALUES({}) ON CONFLICT({}) DO {}",
        dataset.table,
        columns.join(","),
        vec!["?"; columns.len()].join(","),
        dataset.keys.join(","),
        if update.is_empty() {
            "NOTHING".into()
        } else {
            format!("UPDATE SET {update}")
        }
    );
    transaction
        .execute(&sql, params_from_iter(values))
        .map_err(|_| invalid_backup("便携备份数据无法合并。"))?;
    if dataset.table == "publication_lifecycle"
        && record.get("state").and_then(Value::as_str) == Some("present")
    {
        transaction
            .execute(
                "UPDATE publications SET imported_at=min(imported_at,?1) WHERE id=?2 AND hash=?3",
                rusqlite::params![
                    record
                        .get("changedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    record
                        .get("publicationId")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    record
                        .get("contentHash")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ],
            )
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    if dataset.table == "publication_lifecycle"
        && record.get("state").and_then(Value::as_str) == Some("deleted")
    {
        transaction
            .execute(
                "DELETE FROM publications WHERE id=?1",
                [record
                    .get("publicationId")
                    .and_then(Value::as_str)
                    .unwrap_or("")],
            )
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    Ok(true)
}

fn load_current(
    transaction: &rusqlite::Transaction<'_>,
    dataset: &Dataset,
    where_clause: &str,
    keys: &[SqlValue],
) -> Result<Option<Map<String, Value>>, PlatformError> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        dataset
            .columns
            .iter()
            .map(|column| column.sql)
            .collect::<Vec<_>>()
            .join(","),
        dataset.table,
        where_clause
    );
    transaction
        .query_row(&sql, params_from_iter(keys.iter()), |row| {
            let mut result = Map::new();
            for (index, column) in dataset.columns.iter().enumerate() {
                result.insert(
                    column.json.into(),
                    sql_ref_to_json(row.get_ref(index)?, column.boolean),
                );
            }
            Ok(result)
        })
        .optional()
        .map_err(|_| PlatformError::database_corrupt())
}

fn record_to_db(
    dataset: &Dataset,
    record: &Map<String, Value>,
) -> Result<HashMap<&'static str, SqlValue>, PlatformError> {
    dataset
        .columns
        .iter()
        .map(|column| {
            Ok((
                column.sql,
                json_to_sql(record.get(column.json).expect("validated"), column.boolean)?,
            ))
        })
        .collect()
}

fn json_to_sql(value: &Value, boolean: bool) -> Result<SqlValue, PlatformError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) if boolean => SqlValue::Integer(if *value { 1 } else { 0 }),
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Number(value) if value.is_i64() => SqlValue::Integer(value.as_i64().unwrap()),
        Value::Number(value) if value.is_u64() && value.as_u64().unwrap() <= i64::MAX as u64 => {
            SqlValue::Integer(value.as_u64().unwrap() as i64)
        }
        Value::Number(value) => SqlValue::Real(
            value
                .as_f64()
                .ok_or_else(|| invalid_backup("便携备份数字字段无效。"))?,
        ),
        _ => return Err(invalid_backup("便携备份记录值无效。")),
    })
}

fn normalize_record(
    transaction: &rusqlite::Transaction<'_>,
    dataset: &Dataset,
    record: &mut Map<String, Value>,
) -> Result<bool, PlatformError> {
    let exists = |table: &str, column: &str, value: &str| -> Result<bool, PlatformError> {
        transaction
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1)"),
                [value],
                |row| row.get(0),
            )
            .map_err(|_| PlatformError::database_corrupt())
    };
    match dataset.table {
        "reading_positions" => {
            let publication = record
                .get("publicationId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let article = record
                .get("articleId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let valid: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM articles WHERE id=?1 AND publication_id=?2)",
                    [article, publication],
                    |row| row.get(0),
                )
                .map_err(|_| PlatformError::database_corrupt())?;
            if !valid {
                return Ok(false);
            }
            if let Some(value) = record.get_mut("scrollTop") {
                if value.as_f64().unwrap_or(0.0) < 0.0 {
                    *value = Value::Number(Number::from(0));
                }
            }
            if let Some(value) = record.get_mut("anchorFraction") {
                let fraction = value.as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
                *value = Number::from_f64(fraction)
                    .map(Value::Number)
                    .unwrap_or(Value::Number(Number::from(0)));
            }
        }
        "vocabulary_sources" | "saved_contexts" => {
            let lexeme = record
                .get("lexemeKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !exists("user_lexemes", "lexeme_key", lexeme)? {
                return Ok(false);
            }
            if dataset.table == "saved_contexts" {
                for (json, table, column) in [
                    ("publicationId", "publications", "id"),
                    ("articleId", "articles", "id"),
                    ("blockId", "blocks", "id"),
                ] {
                    let valid = match record.get(json).and_then(Value::as_str) {
                        Some(value) => exists(table, column, value)?,
                        None => true,
                    };
                    if !valid {
                        record.insert(json.into(), Value::Null);
                    }
                }
            }
        }
        "study_progress_state"
            if record.get("stateId").and_then(Value::as_str) != Some("global") =>
        {
            return Err(invalid_backup("学习重置记录无效。"))
        }
        _ => {}
    }
    Ok(true)
}

fn apply_resets(transaction: &rusqlite::Transaction<'_>) -> Result<(), PlatformError> {
    let global: Option<String> = transaction
        .query_row(
            "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .flatten();
    if let Some(reset) = global {
        for (table, time) in [
            ("review_events", "reviewed_at"),
            ("reinforcement_events", "created_at"),
            ("review_cards", "updated_at"),
        ] {
            transaction
                .execute(&format!("DELETE FROM {table} WHERE {time}<=?1"), [&reset])
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
    }
    let mut statement = transaction
        .prepare("SELECT lexeme_key,reset_at FROM study_lexeme_resets")
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    drop(statement);
    for (lexeme, reset) in rows {
        for (table, time) in [
            ("review_events", "reviewed_at"),
            ("reinforcement_events", "created_at"),
            ("review_cards", "updated_at"),
            ("review_suspensions", "updated_at"),
        ] {
            transaction
                .execute(
                    &format!("DELETE FROM {table} WHERE lexeme_key=?1 AND {time}<=?2"),
                    [&lexeme, &reset],
                )
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
    }
    Ok(())
}

fn reset_blocks(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    record: &Map<String, Value>,
) -> Result<bool, PlatformError> {
    let lexeme = record
        .get("lexemeKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let time_key = match table {
        "review_events" => "reviewedAt",
        "reinforcement_events" => "createdAt",
        _ => "updatedAt",
    };
    let incoming = record.get(time_key).and_then(Value::as_str).unwrap_or("");
    let global: Option<String> = transaction
        .query_row(
            "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .flatten();
    let selective: Option<String> = transaction
        .query_row(
            "SELECT reset_at FROM study_lexeme_resets WHERE lexeme_key=?1",
            [lexeme],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    let cutoff = std::cmp::max(
        global.as_deref().unwrap_or(""),
        selective.as_deref().unwrap_or(""),
    );
    Ok(incoming <= cutoff)
}

fn extract_entry(
    archive_path: &Path,
    entry_path: &str,
    destination: &Path,
    size: u64,
    sha256: &str,
) -> Result<(), PlatformError> {
    let mut archive = ZipArchive::new(
        File::open(archive_path).map_err(|_| invalid_backup("无法读取便携备份。"))?,
    )
    .map_err(|_| invalid_backup("文件不是有效的便携备份。"))?;
    let mut source = archive
        .by_name(entry_path)
        .map_err(|_| invalid_backup("备份中的刊物内容包已损坏。"))?;
    if source.size() != size {
        return Err(invalid_backup("备份中的刊物内容包大小校验失败。"));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
    }
    let mut output = File::create(destination).map_err(|_| PlatformError::storage_unavailable())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| invalid_backup("无法读取备份中的刊物内容包。"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    output
        .sync_all()
        .map_err(|_| PlatformError::storage_unavailable())?;
    if hex::encode(digest.finalize()) != sha256 {
        let _ = fs::remove_file(destination);
        return Err(invalid_backup("备份中的刊物内容包完整性校验失败。"));
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(u64, String), PlatformError> {
    let mut file = File::open(path).map_err(|_| PlatformError::storage_unavailable())?;
    let size = file
        .metadata()
        .map_err(|_| PlatformError::storage_unavailable())?
        .len();
    Ok((size, hash_reader(&mut file)?))
}
fn hash_reader(reader: &mut impl Read) -> Result<String, PlatformError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| invalid_backup("无法校验便携备份。"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn invalid_backup(message: &'static str) -> PlatformError {
    PlatformError::new("portableBackupInvalid", message, false)
}
fn require_token(token: &str) -> Result<(), PlatformError> {
    uuid::Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| invalid_backup("导入预览令牌无效。"))
}
fn compare_version(
    record: &Map<String, Value>,
    time_key: &str,
    current_time: &str,
    current_device: &str,
) -> i32 {
    let incoming_time = record.get(time_key).and_then(Value::as_str).unwrap_or("");
    let incoming_device = record.get("deviceId").and_then(Value::as_str).unwrap_or("");
    let time_order = match (
        DateTime::parse_from_rfc3339(incoming_time),
        DateTime::parse_from_rfc3339(current_time),
    ) {
        (Ok(incoming), Ok(current)) => incoming.cmp(&current),
        _ => incoming_time.cmp(current_time),
    };
    let order = if time_order == std::cmp::Ordering::Equal {
        incoming_device.cmp(current_device)
    } else {
        time_order
    };
    match order {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}
fn db_text(values: &HashMap<&str, SqlValue>, key: &str) -> String {
    match values.get(key) {
        Some(SqlValue::Text(value)) => value.clone(),
        _ => String::new(),
    }
}
fn json_name<'a>(dataset: &'a Dataset, sql: &str) -> &'a str {
    dataset
        .columns
        .iter()
        .find(|column| column.sql == sql)
        .map(|column| column.json)
        .unwrap_or("")
}
fn set_manifest_count(counts: &mut ManifestCounts, table: &str, count: usize) {
    match table {
        "settings" => counts.settings = count,
        "reading_positions" => counts.reading_positions = count,
        "user_lexemes" => counts.vocabulary = count,
        "vocabulary_sources" => counts.vocabulary_sources = count,
        "saved_contexts" => counts.saved_contexts = count,
        "study_plans" => counts.study_plans = count,
        "review_cards" => counts.review_cards = count,
        "review_events" => counts.review_events = count,
        "reinforcement_events" => counts.reinforcement_events = count,
        "review_suspensions" => counts.review_suspensions = count,
        _ => {}
    }
}
fn manifest_count_for(counts: &ManifestCounts, table: &str) -> Option<usize> {
    match table {
        "settings" => Some(counts.settings),
        "reading_positions" => Some(counts.reading_positions),
        "user_lexemes" => Some(counts.vocabulary),
        "vocabulary_sources" => Some(counts.vocabulary_sources),
        "saved_contexts" => Some(counts.saved_contexts),
        "study_plans" => Some(counts.study_plans),
        "review_cards" => Some(counts.review_cards),
        "review_events" => Some(counts.review_events),
        "reinforcement_events" => Some(counts.reinforcement_events),
        "review_suspensions" => Some(counts.review_suspensions),
        _ => None,
    }
}
fn increment_merge(result: &mut MergeResult, table: &str) {
    match table {
        "settings" => result.settings += 1,
        "reading_positions" => result.reading_positions += 1,
        "user_lexemes" => result.vocabulary += 1,
        "vocabulary_sources" => result.vocabulary_sources += 1,
        "saved_contexts" => result.saved_contexts += 1,
        "study_plans" => result.study_plans += 1,
        "review_cards" => result.review_cards += 1,
        "review_events" => result.review_events += 1,
        "reinforcement_events" => result.reinforcement_events += 1,
        "review_suspensions" => result.review_suspensions += 1,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_reading::{self, ParsedPublicationPlan};

    #[test]
    fn format_v2_dataset_paths_are_unique_and_complete() {
        let paths = DATASETS
            .iter()
            .map(|item| item.path)
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), 18);
        assert!(paths.contains("data/publication-lifecycle.ndjson"));
        assert!(paths.contains("data/study-lexeme-resets.ndjson"));
        assert_eq!(FORMAT_VERSION, 2);
        assert_eq!(CONTENT_ID_VERSION, 2);
    }

    #[test]
    fn rejects_demo_and_future_manifests() {
        let mut manifest = PortableManifest {
            format: "foreign-press-reader-demo".into(),
            format_version: 7,
            app_version: "demo".into(),
            database_schema_version: 1,
            content_id_version: 2,
            created_at: Utc::now().to_rfc3339(),
            policy: "essential-user-data".into(),
            files: Vec::new(),
            counts: ManifestCounts::default(),
        };
        assert_ne!(manifest.format, FORMAT);
        assert_ne!(manifest.format_version, FORMAT_VERSION);
        manifest.format = FORMAT.into();
        manifest.format_version = 3;
        assert_ne!(manifest.format_version, FORMAT_VERSION);
    }

    #[test]
    fn sync_commit_updates_the_formal_peer_state_and_is_idempotent() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().expect("paths");
        let mut database = AndroidDatabase::open(&paths, "receiver").expect("database");
        let sender = "11111111-1111-4111-8111-111111111111";
        let batch_id = "22222222-2222-4222-8222-222222222222";
        let payload_sha256 = "a".repeat(64);

        let applied =
            sync_apply_incoming_records(&mut database, &[], sender, batch_id, &payload_sha256, 42)
                .expect("first sync commit");
        assert!(!applied.duplicate);

        let peer_state = database
            .connection()
            .query_row(
                "SELECT inbound_applied_revision,last_sync_at FROM sync_peer_state WHERE peer_device_id=?1",
                [sender],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .expect("peer state");
        assert_eq!(peer_state.0, 42);
        assert!(peer_state.1.is_some_and(|value| !value.is_empty()));

        let duplicate =
            sync_apply_incoming_records(&mut database, &[], sender, batch_id, &payload_sha256, 42)
                .expect("duplicate sync commit");
        assert!(duplicate.duplicate);
    }

    #[test]
    fn round_trips_normalized_publications_without_source_epubs() {
        let root = tempfile::tempdir().expect("root");
        let source_paths = PlatformPaths::new(
            root.path().join("source/data"),
            root.path().join("source/cache"),
            root.path().join("source/logs"),
        );
        source_paths.prepare().expect("source paths");
        let mut source_database =
            AndroidDatabase::open(&source_paths, "source").expect("source database");
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-content-v2.json"))
                .expect("vector");
        let plan: ParsedPublicationPlan =
            serde_json::from_value(vector["expectedPlan"].clone()).expect("plan");
        for asset in &plan.asset_paths {
            let destination = asset.split('/').fold(
                source_paths
                    .data
                    .join("library")
                    .join(&plan.id)
                    .join("assets"),
                |path, part| path.join(part),
            );
            fs::create_dir_all(destination.parent().unwrap()).expect("asset root");
            fs::write(destination, [0xff, 0xd8, 0xff, 0xd9]).expect("asset");
        }
        mobile_reading::commit_publication(&mut source_database, &plan, "epub", || Ok(()))
            .expect("publication");
        let backup = root.path().join("portable.fprbackup");
        export_archive(&source_database, &source_paths, &backup, "test").expect("export");
        let mut outer = ZipArchive::new(File::open(&backup).expect("backup")).expect("zip");
        let names = (0..outer.len())
            .map(|index| outer.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name.ends_with(".fprpub")));
        assert!(names.iter().all(|name| !name.ends_with(".epub")));
        drop(outer);

        let target_paths = PlatformPaths::new(
            root.path().join("target/data"),
            root.path().join("target/cache"),
            root.path().join("target/logs"),
        );
        target_paths.prepare().expect("target paths");
        let mut target_database =
            AndroidDatabase::open(&target_paths, "target").expect("target database");
        let token = uuid::Uuid::new_v4().to_string();
        let portable_root = target_paths.persistent_staging.join("portable");
        let token_root = portable_root.join(&token);
        fs::create_dir_all(&token_root).expect("token root");
        let inspected = inspect_archive(
            &target_database,
            &backup,
            &token_root,
            &token,
            "portable.fprbackup",
        )
        .expect("inspect");
        assert_eq!(inspected.preview.new_publication_count, 1);
        let metadata = staged_metadata(&portable_root, &token).expect("metadata");
        for package in &metadata.packages {
            restore_staged_package(&mut target_database, &target_paths, &token_root, package)
                .expect("restore package");
        }
        merge_archive(&mut target_database, &backup).expect("merge data");
        assert_eq!(
            mobile_reading::list_publications(&target_database)
                .unwrap()
                .len(),
            1
        );
        assert!(!target_paths
            .data
            .join("library")
            .join(&plan.id)
            .join("source.epub")
            .exists());
        assert!(target_paths
            .data
            .join("library")
            .join(&plan.id)
            .join("assets/EPUB/images/photo.jpg")
            .is_file());
        discard(&portable_root, &token).expect("discard");
    }
}
