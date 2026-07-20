use crate::{
    dictionary_pack,
    dictionary_query::{chinese_search_index_tokens, normalize_english_word},
    learning_contract::create_lexeme_key,
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
use csv::StringRecord;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub const ECDICT_COMMIT: &str = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b";
pub const ECDICT_CSV_SIZE: u64 = 65_933_428;
pub const ECDICT_CSV_BLOB_SHA: &str = "c4ade63ea08cf39d9c3475e96929036d64d94c94";
pub const ECDICT_LEMMA_SIZE: u64 = 2_318_694;
pub const ECDICT_LEMMA_BLOB_SHA: &str = "34eabb9f48c5867a91c01c33b206120e275f0418";
pub const ECDICT_SOURCE_BASES: [&str; 3] = [
    "https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
    "https://ghproxy.net/https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
    "https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
];

const COLLECTIONS: [(&str, &str); 8] = [
    ("zk", "中考"),
    ("gk", "高考"),
    ("cet4", "大学英语四级"),
    ("cet6", "大学英语六级"),
    ("ky", "考研英语"),
    ("toefl", "托福"),
    ("ielts", "雅思"),
    ("gre", "GRE"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildResult {
    pub entry_count: u64,
    pub form_count: u64,
    pub lexeme_map_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullBuildResult {
    pub entry_count: u64,
    pub form_count: u64,
    pub lexeme_map_hash: String,
}

pub fn build_and_publish(
    paths: &PlatformPaths,
    request_id: &str,
    csv_path: &Path,
    lemma_path: &Path,
    cancelled: &AtomicBool,
) -> Result<dictionary_pack::DictionaryPackStatus, PlatformError> {
    dictionary_pack::ensure_online_build_space(paths)?;
    let database_path = dictionary_pack::built_database_path(paths, request_id)?;
    let result = build_standard_database(&database_path, csv_path, Some(lemma_path), cancelled)?;
    dictionary_pack::publish_built_database(
        paths,
        request_id,
        ECDICT_COMMIT,
        result.entry_count,
        result.form_count,
        result.lexeme_map_hash,
    )
}

pub fn build_full_and_publish(
    paths: &PlatformPaths,
    request_id: &str,
    csv_path: &Path,
    lemma_path: &Path,
    cancelled: &AtomicBool,
) -> Result<dictionary_pack::DictionaryPackStatus, PlatformError> {
    dictionary_pack::ensure_online_build_space(paths)?;
    let compatible_base = dictionary_pack::fast_status(paths).is_ok_and(|status| {
        status.installed && status.dataset_revision.as_deref() == Some(ECDICT_COMMIT)
    });
    if !compatible_base {
        let bootstrap_request = uuid::Uuid::new_v4().to_string();
        build_and_publish(paths, &bootstrap_request, csv_path, lemma_path, cancelled)?;
    }
    check_cancelled(cancelled)?;
    let base = dictionary_pack::installed_database_path(paths);
    let destination = dictionary_pack::built_full_database_path(paths, request_id)?;
    let result =
        build_full_extension_database(&destination, &base, csv_path, Some(lemma_path), cancelled)?;
    let status = dictionary_pack::publish_built_full_database(
        paths,
        request_id,
        ECDICT_COMMIT,
        result.entry_count,
        result.form_count,
        result.lexeme_map_hash,
    )?;
    dictionary_pack::cleanup_request(paths, request_id);
    Ok(status)
}

pub fn build_full_extension_database(
    destination: &Path,
    base_path: &Path,
    csv_path: &Path,
    lemma_path: Option<&Path>,
    cancelled: &AtomicBool,
) -> Result<FullBuildResult, PlatformError> {
    check_cancelled(cancelled)?;
    let base = Connection::open_with_flags(
        base_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| build_failed())?;
    let base_revision = base
        .query_row(
            "SELECT value FROM metadata WHERE key='datasetRevision'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| build_failed())?;
    let map_hash = base
        .query_row(
            "SELECT value FROM metadata WHERE key='lexemeMapHash'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| build_failed())?;
    if base_revision != ECDICT_COMMIT || map_hash.len() != 64 {
        return Err(PlatformError::new(
            "dictionaryPackIncompatible",
            "完整词典扩展与基础词典版本不兼容。",
            false,
        ));
    }
    let base_form_count = base
        .query_row(
            "SELECT value FROM metadata WHERE key='formCount'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(build_failed)?;
    if destination.exists() {
        fs::remove_file(destination).map_err(|_| PlatformError::storage_unavailable())?;
    }
    let mut full = Connection::open(destination).map_err(|_| build_failed())?;
    full.execute_batch(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;
         CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE full_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL,definition TEXT,detail TEXT);
         CREATE TABLE extra_lexemes(lexeme_key TEXT PRIMARY KEY,lemma TEXT NOT NULL COLLATE NOCASE,
           normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,phonetic TEXT,collins INTEGER,oxford INTEGER,bnc INTEGER,frq INTEGER);
         CREATE TABLE extra_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL,word TEXT NOT NULL,
           phonetic TEXT,translation TEXT,pos TEXT,tag TEXT,bnc INTEGER,frq INTEGER,definition TEXT,detail TEXT);
         CREATE TABLE extra_tags(lexeme_key TEXT NOT NULL,tag TEXT NOT NULL,
           PRIMARY KEY(lexeme_key,tag)) WITHOUT ROWID;
         CREATE TABLE extra_forms(form TEXT NOT NULL COLLATE NOCASE,lexeme_key TEXT NOT NULL,lemma TEXT NOT NULL,
           relation TEXT NOT NULL,PRIMARY KEY(form,lexeme_key)) WITHOUT ROWID;
         CREATE VIRTUAL TABLE extra_entries_fts USING fts5(cjk_tokens,content='',columnsize=0,
           tokenize='unicode61 remove_diacritics 2');",
    )
    .map_err(|_| build_failed())?;
    let transaction = full.transaction().map_err(|_| build_failed())?;
    let mut insert_full = transaction
        .prepare(
            "INSERT INTO full_entries(entry_id,lexeme_key,definition,detail) VALUES(?1,?2,?3,?4)",
        )
        .map_err(|_| build_failed())?;
    let mut insert_extra_lexeme = transaction
        .prepare(
            "INSERT INTO extra_lexemes(lexeme_key,lemma,normalized,phonetic,collins,oxford,bnc,frq)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(lexeme_key) DO UPDATE SET
          phonetic=COALESCE(extra_lexemes.phonetic,excluded.phonetic)",
        )
        .map_err(|_| build_failed())?;
    let mut insert_extra_entry = transaction
        .prepare("INSERT INTO extra_entries(lexeme_key,word,phonetic,translation,pos,tag,bnc,frq,definition,detail)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
        .map_err(|_| build_failed())?;
    let mut insert_extra_form = transaction
        .prepare(
            "INSERT OR IGNORE INTO extra_forms(form,lexeme_key,lemma,relation) VALUES(?1,?2,?3,?4)",
        )
        .map_err(|_| build_failed())?;
    let mut insert_extra_tag = transaction
        .prepare("INSERT OR IGNORE INTO extra_tags(lexeme_key,tag) VALUES(?1,?2)")
        .map_err(|_| build_failed())?;
    let mut insert_extra_fts = transaction
        .prepare("INSERT INTO extra_entries_fts(rowid,cjk_tokens) VALUES(?1,?2)")
        .map_err(|_| build_failed())?;
    let mut find_lexeme = base
        .prepare("SELECT lexeme_id FROM lexemes WHERE lexeme_key=?1")
        .map_err(|_| build_failed())?;
    let mut find_entries = base
        .prepare("SELECT entry_id FROM entries WHERE lexeme_id=?1 ORDER BY entry_id")
        .map_err(|_| build_failed())?;
    let mut entry_ids = HashMap::<i64, Vec<i64>>::new();
    let mut entry_offsets = HashMap::<i64, usize>::new();
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_path(csv_path)
        .map_err(|_| source_invalid())?;
    let headers = reader.headers().map_err(|_| source_invalid())?.clone();
    let columns = header_map(&headers);
    for required in ["word", "translation", "exchange", "tag", "bnc", "frq"] {
        if !columns.contains_key(required) {
            return Err(source_invalid());
        }
    }
    let mut total_entries = 0_u64;
    for (processed, record) in reader.records().enumerate() {
        if processed % 2_000 == 0 {
            check_cancelled(cancelled)?;
        }
        let record = record.map_err(|_| source_invalid())?;
        let word = field(&record, &columns, "word").trim();
        let normalized = normalize_english_word(word);
        if normalized.is_empty() {
            continue;
        }
        total_entries += 1;
        let collins = integer(field(&record, &columns, "collins"));
        let oxford = integer(field(&record, &columns, "oxford"));
        let bnc = integer(field(&record, &columns, "bnc"));
        let frq = integer(field(&record, &columns, "frq"));
        let tags = field(&record, &columns, "tag");
        let key = create_lexeme_key("en", &normalized);
        if is_standard(tags, collins, oxford, bnc, frq) {
            let lexeme_id = find_lexeme
                .query_row([&key], |row| row.get::<_, i64>(0))
                .map_err(|_| build_failed())?;
            if let std::collections::hash_map::Entry::Vacant(entry) = entry_ids.entry(lexeme_id) {
                let ids = find_entries
                    .query_map([lexeme_id], |row| row.get::<_, i64>(0))
                    .map_err(|_| build_failed())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| build_failed())?;
                entry.insert(ids);
            }
            let offset = entry_offsets.entry(lexeme_id).or_insert(0);
            let entry_id = entry_ids
                .get(&lexeme_id)
                .and_then(|ids| ids.get(*offset))
                .copied()
                .ok_or_else(build_failed)?;
            *offset += 1;
            insert_full
                .execute(params![
                    entry_id,
                    key,
                    nullable(field(&record, &columns, "definition")),
                    nullable(field(&record, &columns, "detail"))
                ])
                .map_err(|_| build_failed())?;
        } else {
            insert_extra_lexeme
                .execute(params![
                    key,
                    word,
                    normalized,
                    nullable(field(&record, &columns, "phonetic")),
                    collins,
                    oxford.unwrap_or(0),
                    bnc,
                    frq
                ])
                .map_err(|_| build_failed())?;
            insert_extra_entry
                .execute(params![
                    key,
                    word,
                    nullable(field(&record, &columns, "phonetic")),
                    nullable(field(&record, &columns, "translation")),
                    nullable(field(&record, &columns, "pos")),
                    nullable(tags),
                    bnc,
                    frq,
                    nullable(field(&record, &columns, "definition")),
                    nullable(field(&record, &columns, "detail"))
                ])
                .map_err(|_| build_failed())?;
            let entry_id = transaction.last_insert_rowid();
            insert_extra_fts
                .execute(params![
                    entry_id,
                    chinese_search_index_tokens(field(&record, &columns, "translation"))
                ])
                .map_err(|_| build_failed())?;
            for tag in tags.split_whitespace().map(str::to_ascii_lowercase) {
                insert_extra_tag
                    .execute(params![key, tag])
                    .map_err(|_| build_failed())?;
            }
            for form in exchange_forms(field(&record, &columns, "exchange")) {
                let form = normalize_english_word(&form);
                if !form.is_empty() {
                    insert_extra_form
                        .execute(params![form, key, normalized, "exchange"])
                        .map_err(|_| build_failed())?;
                }
            }
        }
    }
    drop(find_entries);
    drop(find_lexeme);
    drop(insert_extra_fts);
    drop(insert_extra_tag);
    drop(insert_extra_form);
    drop(insert_extra_entry);
    drop(insert_extra_lexeme);
    drop(insert_full);
    transaction.commit().map_err(|_| build_failed())?;
    if let Some(lemma_path) = lemma_path.filter(|path| path.exists()) {
        add_extra_lemma_forms(&mut full, lemma_path, cancelled)?;
    }
    full.execute_batch(
        "CREATE INDEX idx_full_entries_lexeme ON full_entries(lexeme_key);
         CREATE INDEX idx_extra_entries_lexeme ON extra_entries(lexeme_key);
         CREATE INDEX idx_extra_tags_tag ON extra_tags(tag,lexeme_key);
         CREATE INDEX idx_extra_forms_form ON extra_forms(form);
         CREATE INDEX idx_extra_lexemes_frequency ON extra_lexemes(frq,bnc,lemma);
         ANALYZE;",
    )
    .map_err(|_| build_failed())?;
    let extra_forms = full
        .query_row("SELECT COUNT(*) FROM extra_forms", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| build_failed())? as u64;
    let form_count = base_form_count.saturating_add(extra_forms);
    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (key, value) in [
        ("provider", "ecdict".to_string()),
        ("schemaVersion", "1".to_string()),
        ("indexProfile", "full-extension-v1".to_string()),
        ("datasetRevision", ECDICT_COMMIT.to_string()),
        ("lexemeMapHash", map_hash.clone()),
        ("version", ECDICT_COMMIT[..12].to_string()),
        ("commit", ECDICT_COMMIT.to_string()),
        ("entryCount", total_entries.to_string()),
        ("formCount", form_count.to_string()),
        ("installedAt", installed_at),
    ] {
        full.execute(
            "INSERT INTO metadata(key,value) VALUES(?1,?2)",
            params![key, value],
        )
        .map_err(|_| build_failed())?;
    }
    full.execute_batch("PRAGMA optimize; PRAGMA synchronous=FULL;")
        .map_err(|_| build_failed())?;
    let quick: String = full
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| build_failed())?;
    if quick != "ok" {
        return Err(build_failed());
    }
    drop(full);
    File::options()
        .read(true)
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(FullBuildResult {
        entry_count: total_entries,
        form_count,
        lexeme_map_hash: map_hash,
    })
}

pub fn build_standard_database(
    destination: &Path,
    csv_path: &Path,
    lemma_path: Option<&Path>,
    cancelled: &AtomicBool,
) -> Result<BuildResult, PlatformError> {
    check_cancelled(cancelled)?;
    if destination.exists() {
        fs::remove_file(destination).map_err(|_| PlatformError::storage_unavailable())?;
    }
    let mut connection = Connection::open(destination).map_err(|_| build_failed())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;
             CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             CREATE TABLE lexemes(lexeme_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL UNIQUE,language TEXT NOT NULL,
               lemma TEXT NOT NULL COLLATE NOCASE,normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,phonetic TEXT,collins INTEGER,
               oxford INTEGER NOT NULL DEFAULT 0,bnc INTEGER,frq INTEGER);
             CREATE TABLE entries(entry_id INTEGER PRIMARY KEY,lexeme_id INTEGER NOT NULL,word TEXT NOT NULL COLLATE NOCASE,
               phonetic TEXT,translation TEXT,pos TEXT,tag TEXT,bnc INTEGER,frq INTEGER);
             CREATE TABLE forms(form TEXT NOT NULL COLLATE NOCASE,lexeme_id INTEGER NOT NULL,lemma TEXT NOT NULL COLLATE NOCASE,
               relation TEXT NOT NULL,PRIMARY KEY(form,lexeme_id)) WITHOUT ROWID;
             CREATE TABLE tags(lexeme_id INTEGER NOT NULL,tag TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(lexeme_id,tag)) WITHOUT ROWID;
             CREATE TABLE collections(id TEXT PRIMARY KEY,tag TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL);
             CREATE TABLE collection_items(collection_id TEXT NOT NULL,lexeme_id INTEGER NOT NULL,
               PRIMARY KEY(collection_id,lexeme_id)) WITHOUT ROWID;
             CREATE VIRTUAL TABLE entries_fts USING fts5(cjk_tokens,content='',columnsize=0,tokenize='unicode61 remove_diacritics 2');",
        )
        .map_err(|_| build_failed())?;
    for (tag, name) in COLLECTIONS {
        connection
            .execute(
                "INSERT INTO collections(id,tag,name) VALUES(?1,?2,?3)",
                params![format!("ecdict:{tag}"), tag, name],
            )
            .map_err(|_| build_failed())?;
    }
    let transaction = connection.transaction().map_err(|_| build_failed())?;
    let mut insert_lexeme = transaction
        .prepare(
            "INSERT INTO lexemes(lexeme_key,language,lemma,normalized,phonetic,collins,oxford,bnc,frq)
             VALUES(?1,'en',?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(lexeme_key) DO UPDATE SET
             phonetic=COALESCE(lexemes.phonetic,excluded.phonetic),collins=max(COALESCE(lexemes.collins,0),COALESCE(excluded.collins,0)),
             oxford=max(lexemes.oxford,excluded.oxford),bnc=min(COALESCE(lexemes.bnc,excluded.bnc),COALESCE(excluded.bnc,lexemes.bnc)),
             frq=min(COALESCE(lexemes.frq,excluded.frq),COALESCE(excluded.frq,lexemes.frq))",
        )
        .map_err(|_| build_failed())?;
    let mut select_lexeme = transaction
        .prepare("SELECT lexeme_id FROM lexemes WHERE lexeme_key=?1")
        .map_err(|_| build_failed())?;
    let mut insert_entry = transaction
        .prepare("INSERT INTO entries(lexeme_id,word,phonetic,translation,pos,tag,bnc,frq) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
        .map_err(|_| build_failed())?;
    let mut insert_form = transaction
        .prepare("INSERT OR IGNORE INTO forms(form,lexeme_id,lemma,relation) VALUES(?1,?2,?3,?4)")
        .map_err(|_| build_failed())?;
    let mut insert_tag = transaction
        .prepare("INSERT OR IGNORE INTO tags(lexeme_id,tag) VALUES(?1,?2)")
        .map_err(|_| build_failed())?;
    let mut insert_collection = transaction
        .prepare("INSERT OR IGNORE INTO collection_items(collection_id,lexeme_id) VALUES(?1,?2)")
        .map_err(|_| build_failed())?;
    let mut insert_fts = transaction
        .prepare("INSERT INTO entries_fts(rowid,cjk_tokens) VALUES(?1,?2)")
        .map_err(|_| build_failed())?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_path(csv_path)
        .map_err(|_| source_invalid())?;
    let headers = reader.headers().map_err(|_| source_invalid())?.clone();
    let columns = header_map(&headers);
    for required in ["word", "translation", "exchange", "tag", "bnc", "frq"] {
        if !columns.contains_key(required) {
            return Err(source_invalid());
        }
    }
    let collection_tags = COLLECTIONS
        .iter()
        .map(|(tag, _)| *tag)
        .collect::<HashSet<_>>();
    for (processed, record) in reader.records().enumerate() {
        if processed % 2_000 == 0 {
            check_cancelled(cancelled)?;
        }
        let record = record.map_err(|_| source_invalid())?;
        let word = field(&record, &columns, "word").trim();
        let normalized = normalize_english_word(word);
        if normalized.is_empty() {
            continue;
        }
        let collins = integer(field(&record, &columns, "collins"));
        let oxford = integer(field(&record, &columns, "oxford"));
        let bnc = integer(field(&record, &columns, "bnc"));
        let frq = integer(field(&record, &columns, "frq"));
        let tags = field(&record, &columns, "tag");
        if !is_standard(tags, collins, oxford, bnc, frq) {
            continue;
        }
        let key = create_lexeme_key("en", &normalized);
        insert_lexeme
            .execute(params![
                key,
                word,
                normalized,
                nullable(field(&record, &columns, "phonetic")),
                collins,
                oxford.unwrap_or(0),
                bnc,
                frq
            ])
            .map_err(|_| build_failed())?;
        let lexeme_id: i64 = select_lexeme
            .query_row([&key], |row| row.get(0))
            .map_err(|_| build_failed())?;
        let translation = nullable(field(&record, &columns, "translation"));
        insert_entry
            .execute(params![
                lexeme_id,
                word,
                nullable(field(&record, &columns, "phonetic")),
                translation,
                nullable(field(&record, &columns, "pos")),
                nullable(tags),
                bnc,
                frq
            ])
            .map_err(|_| build_failed())?;
        let entry_id = transaction.last_insert_rowid();
        insert_fts
            .execute(params![
                entry_id,
                chinese_search_index_tokens(field(&record, &columns, "translation"))
            ])
            .map_err(|_| build_failed())?;
        for tag in tags.split_whitespace().map(str::to_ascii_lowercase) {
            insert_tag
                .execute(params![lexeme_id, tag])
                .map_err(|_| build_failed())?;
            if collection_tags.contains(tag.as_str()) {
                insert_collection
                    .execute(params![format!("ecdict:{tag}"), lexeme_id])
                    .map_err(|_| build_failed())?;
            }
        }
        for form in exchange_forms(field(&record, &columns, "exchange")) {
            let normalized_form = normalize_english_word(&form);
            if !normalized_form.is_empty() {
                insert_form
                    .execute(params![normalized_form, lexeme_id, normalized, "exchange"])
                    .map_err(|_| build_failed())?;
            }
        }
    }
    drop(insert_fts);
    drop(insert_collection);
    drop(insert_tag);
    drop(insert_form);
    drop(insert_entry);
    drop(select_lexeme);
    drop(insert_lexeme);
    transaction.commit().map_err(|_| build_failed())?;

    if let Some(lemma_path) = lemma_path.filter(|path| path.exists()) {
        add_lemma_forms(&mut connection, lemma_path, cancelled)?;
    }
    check_cancelled(cancelled)?;
    connection
        .execute_batch(
            "CREATE INDEX idx_entries_lexeme ON entries(lexeme_id);
             CREATE INDEX idx_lexemes_frequency ON lexemes(frq,bnc,lemma);
             CREATE INDEX idx_tags_tag ON tags(tag,lexeme_id);
             CREATE INDEX idx_collection_items_lexeme ON collection_items(lexeme_id);
             ANALYZE;",
        )
        .map_err(|_| build_failed())?;
    let entry_count = connection
        .query_row("SELECT COUNT(*) FROM lexemes", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| build_failed())? as u64;
    let form_count = connection
        .query_row("SELECT COUNT(*) FROM forms", [], |row| row.get::<_, i64>(0))
        .map_err(|_| build_failed())? as u64;
    let lexeme_map_hash = lexeme_map_hash(&connection)?;
    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (key, value) in [
        ("provider", "ecdict".to_string()),
        ("schemaVersion", "4".to_string()),
        ("indexProfile", "standard-v1".to_string()),
        ("datasetRevision", ECDICT_COMMIT.to_string()),
        ("lexemeMapHash", lexeme_map_hash.clone()),
        ("version", ECDICT_COMMIT[..12].to_string()),
        ("commit", ECDICT_COMMIT.to_string()),
        ("entryCount", entry_count.to_string()),
        ("formCount", form_count.to_string()),
        ("installedAt", installed_at),
        (
            "source",
            "https://github.com/skywind3000/ECDICT".to_string(),
        ),
        ("license", "MIT".to_string()),
    ] {
        connection
            .execute(
                "INSERT INTO metadata(key,value) VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(|_| build_failed())?;
    }
    connection
        .execute_batch("PRAGMA optimize; PRAGMA synchronous=FULL;")
        .map_err(|_| build_failed())?;
    let quick: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| build_failed())?;
    if quick != "ok" {
        return Err(build_failed());
    }
    drop(connection);
    File::options()
        .read(true)
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(BuildResult {
        entry_count,
        form_count,
        lexeme_map_hash,
    })
}

fn add_lemma_forms(
    connection: &mut Connection,
    lemma_path: &Path,
    cancelled: &AtomicBool,
) -> Result<(), PlatformError> {
    let transaction = connection.transaction().map_err(|_| build_failed())?;
    let mut find = transaction
        .prepare("SELECT lexeme_id FROM lexemes WHERE lexeme_key=?1")
        .map_err(|_| build_failed())?;
    let mut insert = transaction
        .prepare("INSERT OR IGNORE INTO forms(form,lexeme_id,lemma,relation) VALUES(?1,?2,?3,'lemma-db')")
        .map_err(|_| build_failed())?;
    for (index, line) in BufReader::new(File::open(lemma_path).map_err(|_| source_invalid())?)
        .lines()
        .enumerate()
    {
        if index % 2_000 == 0 {
            check_cancelled(cancelled)?;
        }
        let line = line.map_err(|_| source_invalid())?;
        let Some((left, right)) = line.split_once("->") else {
            continue;
        };
        let left = left.trim();
        let Some((lemma, frequency)) = left.rsplit_once('/') else {
            continue;
        };
        if frequency.is_empty()
            || !frequency
                .chars()
                .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let normalized = normalize_english_word(lemma);
        let key = create_lexeme_key("en", &normalized);
        let lexeme_id = find.query_row([&key], |row| row.get::<_, i64>(0)).ok();
        let Some(lexeme_id) = lexeme_id else {
            continue;
        };
        for form in right.split(',') {
            let form = normalize_english_word(form);
            if !form.is_empty() && form != normalized {
                insert
                    .execute(params![form, lexeme_id, normalized])
                    .map_err(|_| build_failed())?;
            }
        }
    }
    drop(insert);
    drop(find);
    transaction.commit().map_err(|_| build_failed())
}

fn add_extra_lemma_forms(
    connection: &mut Connection,
    lemma_path: &Path,
    cancelled: &AtomicBool,
) -> Result<(), PlatformError> {
    let transaction = connection.transaction().map_err(|_| build_failed())?;
    let mut find = transaction
        .prepare("SELECT lexeme_key FROM extra_lexemes WHERE lexeme_key=?1")
        .map_err(|_| build_failed())?;
    let mut insert = transaction
        .prepare("INSERT OR IGNORE INTO extra_forms(form,lexeme_key,lemma,relation) VALUES(?1,?2,?3,'lemma-db')")
        .map_err(|_| build_failed())?;
    for (index, line) in BufReader::new(File::open(lemma_path).map_err(|_| source_invalid())?)
        .lines()
        .enumerate()
    {
        if index % 2_000 == 0 {
            check_cancelled(cancelled)?;
        }
        let line = line.map_err(|_| source_invalid())?;
        let Some((left, right)) = line.split_once("->") else {
            continue;
        };
        let left = left.trim();
        let Some((lemma, frequency)) = left.rsplit_once('/') else {
            continue;
        };
        if frequency.is_empty()
            || !frequency
                .chars()
                .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let normalized = normalize_english_word(lemma);
        let key = create_lexeme_key("en", &normalized);
        let exists = find
            .query_row([&key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|_| build_failed())?
            .is_some();
        if !exists {
            continue;
        }
        for form in right.split(',') {
            let form = normalize_english_word(form);
            if !form.is_empty() && form != normalized {
                insert
                    .execute(params![form, key, normalized])
                    .map_err(|_| build_failed())?;
            }
        }
    }
    drop(insert);
    drop(find);
    transaction.commit().map_err(|_| build_failed())
}

fn header_map(headers: &StringRecord) -> HashMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(index, value)| (value.trim_start_matches('\u{feff}').to_string(), index))
        .collect()
}

fn field<'a>(record: &'a StringRecord, columns: &HashMap<String, usize>, name: &str) -> &'a str {
    columns
        .get(name)
        .and_then(|index| record.get(*index))
        .unwrap_or("")
}

fn nullable(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn integer(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        value.parse().ok()
    }
}

fn is_standard(
    tag: &str,
    collins: Option<i64>,
    oxford: Option<i64>,
    bnc: Option<i64>,
    frq: Option<i64>,
) -> bool {
    !tag.trim().is_empty()
        || oxford.is_some_and(|value| value != 0)
        || collins.is_some_and(|value| value != 0)
        || bnc.is_some_and(|value| value > 0 && value <= 100_000)
        || frq.is_some_and(|value| value > 0 && value <= 100_000)
}

fn exchange_forms(value: &str) -> Vec<String> {
    value
        .split('/')
        .filter_map(|part| part.split_once(':').map(|(_, values)| values))
        .flat_map(|values| values.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn lexeme_map_hash(connection: &Connection) -> Result<String, PlatformError> {
    let mut statement = connection
        .prepare("SELECT lexeme_id,normalized FROM lexemes ORDER BY lexeme_id")
        .map_err(|_| build_failed())?;
    let mut rows = statement.query([]).map_err(|_| build_failed())?;
    let mut digest = Sha256::new();
    while let Some(row) = rows.next().map_err(|_| build_failed())? {
        let id: i64 = row.get(0).map_err(|_| build_failed())?;
        let normalized: String = row.get(1).map_err(|_| build_failed())?;
        digest.update(format!("{id}\u{1f}{normalized}\n").as_bytes());
    }
    Ok(hex::encode(digest.finalize()))
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), PlatformError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(PlatformError::new(
            "dictionaryInstallCancelled",
            "词典预载已取消。",
            false,
        ))
    } else {
        Ok(())
    }
}

fn source_invalid() -> PlatformError {
    PlatformError::new(
        "dictionaryPackInvalid",
        "ECDICT 固定数据源校验失败。",
        false,
    )
}

fn build_failed() -> PlatformError {
    PlatformError::new(
        "learningDatabaseUnavailable",
        "无法建立本地词典索引。",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary_query::{lookup, DictionaryLookupContext};
    use std::io::Write;

    #[test]
    fn builds_the_standard_profile_from_streamed_sources() {
        let root = tempfile::tempdir().expect("root");
        let csv = root.path().join("ecdict.csv");
        let lemma = root.path().join("lemma.en.txt");
        let database = root.path().join("ecdict.sqlite");
        let mut file = File::create(&csv).expect("csv");
        writeln!(file, "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio").expect("header");
        writeln!(
            file,
            "run,rʌn,,v. 跑；运行,v,3,1,cet4,100,100,p:ran/d:ran/i:running,,"
        )
        .expect("run");
        writeln!(file, "obscure,,,a. 晦涩的,a,0,0,,,,,,").expect("obscure");
        fs::write(&lemma, "run/1 -> runs,running\n").expect("lemma");
        let result =
            build_standard_database(&database, &csv, Some(&lemma), &AtomicBool::new(false))
                .expect("build");
        assert_eq!(result.entry_count, 1);
        assert!(result.form_count >= 2);
        let looked_up = lookup(
            &database,
            DictionaryLookupContext {
                surface: "running".into(),
                sentence: "Running works.".into(),
                paragraph: "Running works.".into(),
            },
            None,
            &AtomicBool::new(false),
        )
        .expect("lookup");
        assert_eq!(looked_up.lemma, "run");
    }

    #[test]
    fn builds_a_compatible_full_extension_without_replacing_the_base() {
        let root = tempfile::tempdir().expect("root");
        let csv = root.path().join("ecdict.csv");
        let lemma = root.path().join("lemma.en.txt");
        let base = root.path().join("ecdict-base.sqlite");
        let full = root.path().join("ecdict-full.sqlite");
        let mut file = File::create(&csv).expect("csv");
        writeln!(file, "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio").expect("header");
        writeln!(
            file,
            "run,rʌn,v. move quickly,v. 跑；运行,v,3,1,cet4,100,100,p:ran/d:ran/i:running,,"
        )
        .expect("run");
        writeln!(
            file,
            "obscure,,a. not well known,a. 晦涩的,a,0,0,mystery,,,,,"
        )
        .expect("obscure");
        fs::write(&lemma, "run/1 -> runs,running\nobscure/1 -> obscures\n").expect("lemma");
        build_standard_database(&base, &csv, Some(&lemma), &AtomicBool::new(false)).expect("base");
        let result = build_full_extension_database(
            &full,
            &base,
            &csv,
            Some(&lemma),
            &AtomicBool::new(false),
        )
        .expect("full");
        assert_eq!(result.entry_count, 2);
        let run = crate::dictionary_query::get_lexeme_with_extension(
            &base,
            Some(&full),
            &create_lexeme_key("en", "run"),
        )
        .expect("run detail");
        assert!(run.entries[0].senses.iter().any(|sense| {
            sense
                .definitions
                .iter()
                .any(|definition| definition == "move quickly")
        }));
        let obscure = crate::dictionary_query::get_lexeme_with_extension(
            &base,
            Some(&full),
            &create_lexeme_key("en", "obscure"),
        )
        .expect("extra detail");
        assert_eq!(obscure.summary.lemma, "obscure");
        let page = crate::dictionary_query::search_with_extension(
            &base,
            Some(&full),
            crate::dictionary_query::MobileDictionarySearchQuery {
                text: "obsc".into(),
                tags: vec!["mystery".into()],
                offset: 0,
                limit: 20,
                ..Default::default()
            },
            &AtomicBool::new(false),
        )
        .expect("full search");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].lemma, "obscure");
    }

    #[test]
    fn full_online_build_bootstraps_a_missing_standard_pack() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().expect("paths");
        dictionary_pack::prepare(&paths).expect("dictionary paths");
        let csv = root.path().join("ecdict.csv");
        let lemma = root.path().join("lemma.en.txt");
        let mut file = File::create(&csv).expect("csv");
        writeln!(file, "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio").expect("header");
        writeln!(
            file,
            "run,rʌn,v. move quickly,v. 跑；运行,v,3,1,cet4,100,100,p:ran/d:ran/i:running,,"
        )
        .expect("run");
        writeln!(
            file,
            "obscure,,a. not well known,a. 晦涩的,a,0,0,mystery,,,,,"
        )
        .expect("obscure");
        fs::write(&lemma, "run/1 -> runs,running\nobscure/1 -> obscures\n").expect("lemma");
        let request = uuid::Uuid::new_v4().to_string();
        build_full_and_publish(&paths, &request, &csv, &lemma, &AtomicBool::new(false))
            .expect("full install");
        let status = dictionary_pack::fast_resource_status(&paths, false).expect("status");
        assert!(status.base_installed);
        assert!(status.full_extension_installed);
        assert!(status.extension_compatible);
        assert_eq!(status.effective_profile, "full");
    }

    #[test]
    #[ignore = "requires the pinned ECDICT source files outside the repository"]
    fn matches_the_pinned_windows_standard_profile() {
        let csv = std::env::var("FPR_ECDICT_CSV").expect("FPR_ECDICT_CSV");
        let lemma = std::env::var("FPR_ECDICT_LEMMA").expect("FPR_ECDICT_LEMMA");
        let root = tempfile::tempdir().expect("root");
        let database = root.path().join("ecdict-base.sqlite");
        let result = build_standard_database(
            &database,
            Path::new(&csv),
            Some(Path::new(&lemma)),
            &AtomicBool::new(false),
        )
        .expect("build pinned ECDICT");
        let connection = Connection::open(&database).expect("open result");
        let entries: i64 = connection
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .expect("entry count");
        assert_eq!(result.entry_count, 59_119);
        assert_eq!(entries, 59_137);
        assert_eq!(result.form_count, 67_810);
        assert_eq!(
            result.lexeme_map_hash,
            "b6e911b3adf4bc06f7cc7645868dad846a5eefd560f4e455d0245640d2590a8f"
        );
    }
}
