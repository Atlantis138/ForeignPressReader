use crate::{
    database::AndroidDatabase, platform_error::PlatformError, platform_paths::PlatformPaths,
};
use regex::Regex;
use rusqlite::{params, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictionaryLookupRequest {
    pub article_id: String,
    pub block_id: String,
    pub surface: String,
    pub token_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictionaryPreferences {
    pub enabled: bool,
    pub lookup_provider_id: String,
    pub fallback_to_local: bool,
    pub context_explanation_enabled: bool,
    pub translate_examples: bool,
}

#[derive(Debug, Clone)]
pub struct DictionaryLookupContext {
    pub surface: String,
    pub sentence: String,
    pub paragraph: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileDictionarySearchQuery {
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tag_match: DictionaryTagMatch,
    #[serde(default)]
    pub oxford_only: bool,
    #[serde(default)]
    pub collins_min: Option<i64>,
    #[serde(default)]
    pub bnc_max: Option<i64>,
    #[serde(default)]
    pub contemporary_max: Option<i64>,
    #[serde(default)]
    pub sort: DictionarySearchSort,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DictionaryTagMatch {
    #[default]
    Any,
    All,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DictionarySearchSort {
    #[default]
    Relevance,
    Frequency,
    Alphabetical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexemeCandidate {
    pub lexeme_key: String,
    pub lemma: String,
    pub relation: &'static str,
    pub confidence: f64,
    pub phonetic: Option<String>,
    pub brief_meanings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySenseGroup {
    pub part_of_speech: String,
    pub translations: Vec<String>,
    pub definitions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntryResult {
    pub word: String,
    pub phonetic: Option<String>,
    pub senses: Vec<DictionarySenseGroup>,
    pub position_weights: Option<String>,
    pub tags: Vec<String>,
    pub frequency: DictionaryFrequency,
    pub exchanges: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryFrequency {
    pub bnc: Option<i64>,
    pub contemporary: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCollection {
    pub id: String,
    pub tag: String,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySearchItem {
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub brief_meanings: Vec<String>,
    pub tags: Vec<String>,
    pub collins: Option<i64>,
    pub oxford: bool,
    pub frequency: DictionaryFrequency,
    pub matched_by: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySearchPage {
    pub items: Vec<DictionarySearchItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexemeDetail {
    #[serde(flatten)]
    pub summary: DictionarySearchItem,
    pub entries: Vec<DictionaryEntryResult>,
    pub forms: Vec<String>,
    pub collections: Vec<DictionaryCollection>,
    pub provider_id: &'static str,
    pub examples: Vec<serde_json::Value>,
    pub similar_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupMetadata {
    pub tags: Vec<String>,
    pub collections: Vec<DictionaryCollection>,
    pub oxford: bool,
    pub collins: Option<i64>,
    pub frequency: DictionaryFrequency,
    pub forms: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryLookupResult {
    pub surface: String,
    pub normalized: String,
    pub lemma: String,
    pub sentence: String,
    pub paragraph: String,
    pub found: bool,
    pub entries: Vec<DictionaryEntryResult>,
    pub suggestions: Vec<String>,
    pub context_definition: Option<serde_json::Value>,
    pub dictionary_version: Option<String>,
    pub lexeme_key: Option<String>,
    pub candidates: Vec<LexemeCandidate>,
    pub requires_selection: bool,
    pub requested_provider_id: &'static str,
    pub resolved_provider_id: &'static str,
    pub local_profile: &'static str,
    pub fallback_used: bool,
    pub examples: Vec<serde_json::Value>,
    pub metadata: LookupMetadata,
}

pub fn database_path(paths: &PlatformPaths) -> PathBuf {
    paths
        .data
        .join("dictionaries")
        .join("ecdict-base")
        .join("ecdict-base.sqlite")
}

pub fn get_preferences(database: &AndroidDatabase) -> Result<DictionaryPreferences, PlatformError> {
    let value = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='dictionary.preferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(value
        .and_then(|json| serde_json::from_str(&json).ok())
        .filter(valid_preferences)
        .unwrap_or_else(default_preferences))
}

pub fn save_preferences(
    database: &AndroidDatabase,
    preferences: DictionaryPreferences,
) -> Result<DictionaryPreferences, PlatformError> {
    if !valid_preferences(&preferences) {
        return Err(PlatformError::new("invalidInput", "词典设置无效。", false));
    }
    let encoded =
        serde_json::to_string(&preferences).map_err(|_| PlatformError::storage_unavailable())?;
    database
        .connection()
        .execute(
            "INSERT INTO settings(key,value,updated_at,device_id) VALUES('dictionary.preferences',?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
            params![
                encoded,
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                database.device_id()
            ],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(preferences)
}

fn default_preferences() -> DictionaryPreferences {
    DictionaryPreferences {
        enabled: true,
        lookup_provider_id: "ecdict".into(),
        fallback_to_local: true,
        context_explanation_enabled: false,
        translate_examples: false,
    }
}

fn valid_preferences(value: &DictionaryPreferences) -> bool {
    matches!(value.lookup_provider_id.as_str(), "ecdict" | "baidu")
        && (value.lookup_provider_id != "baidu" || value.fallback_to_local)
}

pub fn lookup(
    database_path: &Path,
    context: DictionaryLookupContext,
    preferred_lexeme_key: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<DictionaryLookupResult, PlatformError> {
    check_cancelled(cancelled)?;
    let connection = open(database_path)?;
    lookup_connections(&connection, None, context, preferred_lexeme_key, cancelled)
}

pub fn lookup_with_extension(
    database_path: &Path,
    full_database_path: Option<&Path>,
    context: DictionaryLookupContext,
    preferred_lexeme_key: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<DictionaryLookupResult, PlatformError> {
    check_cancelled(cancelled)?;
    let connection = open(database_path)?;
    let full = open_compatible_full(&connection, full_database_path)?;
    lookup_connections(
        &connection,
        full.as_ref(),
        context,
        preferred_lexeme_key,
        cancelled,
    )
}

fn lookup_connections(
    connection: &Connection,
    full: Option<&Connection>,
    context: DictionaryLookupContext,
    preferred_lexeme_key: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<DictionaryLookupResult, PlatformError> {
    let normalized = normalize_english_word(&context.surface);
    let candidates = resolve_with_extension(connection, full, &context.surface, cancelled)?;
    let selected = if let Some(preferred) = preferred_lexeme_key {
        Some(
            candidates
                .iter()
                .find(|candidate| candidate.lexeme_key == preferred)
                .ok_or_else(|| {
                    PlatformError::new("lexemeAmbiguous", "所选词条与当前词形不匹配。", false)
                })?,
        )
    } else {
        candidates.first()
    };
    let requires_selection = preferred_lexeme_key.is_none()
        && candidates.len() > 1
        && candidates[0].confidence - candidates[1].confidence < 0.25;
    check_cancelled(cancelled)?;
    let detail = selected
        .map(|candidate| {
            get_lexeme_from_connections(connection, full, &candidate.lexeme_key).or_else(|error| {
                if error.code == "learningEntityMissing" {
                    full.map(|full| get_extra_lexeme(full, &candidate.lexeme_key))
                        .transpose()?
                        .ok_or(error)
                } else {
                    Err(error)
                }
            })
        })
        .transpose()?;
    let version = metadata(connection, "version").ok();
    let (lemma, lexeme_key, entries, metadata) = if let Some(detail) = detail {
        let metadata = LookupMetadata {
            tags: detail.summary.tags.clone(),
            collections: detail.collections.clone(),
            oxford: detail.summary.oxford,
            collins: detail.summary.collins,
            frequency: detail.summary.frequency.clone(),
            forms: detail.forms.clone(),
        };
        (
            detail.summary.lemma,
            Some(detail.summary.lexeme_key),
            detail.entries,
            metadata,
        )
    } else {
        (
            normalized.clone(),
            None,
            Vec::new(),
            LookupMetadata {
                tags: Vec::new(),
                collections: Vec::new(),
                oxford: false,
                collins: None,
                frequency: DictionaryFrequency {
                    bnc: None,
                    contemporary: None,
                },
                forms: Vec::new(),
            },
        )
    };
    check_cancelled(cancelled)?;
    Ok(DictionaryLookupResult {
        surface: context.surface,
        normalized,
        lemma,
        sentence: context.sentence,
        paragraph: context.paragraph,
        found: !entries.is_empty(),
        entries,
        suggestions: Vec::new(),
        context_definition: None,
        dictionary_version: version,
        lexeme_key,
        candidates,
        requires_selection,
        requested_provider_id: "ecdict",
        resolved_provider_id: "ecdict",
        local_profile: if full.is_some() { "full" } else { "standard" },
        fallback_used: false,
        examples: Vec::new(),
        metadata,
    })
}

pub fn get_lexeme(database_path: &Path, lexeme_key: &str) -> Result<LexemeDetail, PlatformError> {
    if !valid_lexeme_key(lexeme_key) {
        return Err(PlatformError::new("invalidInput", "词元标识无效。", false));
    }
    get_lexeme_from_connection(&open(database_path)?, lexeme_key)
}

pub fn get_lexeme_with_extension(
    database_path: &Path,
    full_database_path: Option<&Path>,
    lexeme_key: &str,
) -> Result<LexemeDetail, PlatformError> {
    if !valid_lexeme_key(lexeme_key) {
        return Err(PlatformError::new("invalidInput", "词元标识无效。", false));
    }
    let base = open(database_path)?;
    let full = open_compatible_full(&base, full_database_path)?;
    match get_lexeme_from_connections(&base, full.as_ref(), lexeme_key) {
        Ok(detail) => Ok(detail),
        Err(error) if error.code == "learningEntityMissing" => full
            .as_ref()
            .map(|connection| get_extra_lexeme(connection, lexeme_key))
            .transpose()?
            .ok_or(error),
        Err(error) => Err(error),
    }
}

pub fn list_collections(database_path: &Path) -> Result<Vec<DictionaryCollection>, PlatformError> {
    let connection = open(database_path)?;
    connection
        .prepare(
            "SELECT c.id,c.tag,c.name,COUNT(i.lexeme_id) count FROM collections c
             JOIN collection_items i ON i.collection_id=c.id
             GROUP BY c.id HAVING count>0 ORDER BY c.name",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok(DictionaryCollection {
                        id: row.get(0)?,
                        tag: row.get(1)?,
                        name: row.get(2)?,
                        count: row.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| query_failed())
}

pub fn search(
    database_path: &Path,
    query: MobileDictionarySearchQuery,
    cancelled: &AtomicBool,
) -> Result<DictionarySearchPage, PlatformError> {
    check_cancelled(cancelled)?;
    let connection = open(database_path)?;
    search_base_connection(&connection, query, cancelled, 100)
}

pub fn search_with_extension(
    database_path: &Path,
    full_database_path: Option<&Path>,
    query: MobileDictionarySearchQuery,
    cancelled: &AtomicBool,
) -> Result<DictionarySearchPage, PlatformError> {
    check_cancelled(cancelled)?;
    let base = open(database_path)?;
    let full = open_compatible_full(&base, full_database_path)?;
    let Some(full) = full.as_ref() else {
        return search_base_connection(&base, query, cancelled, 100);
    };
    let limit = query.limit.clamp(1, 100);
    let offset = query.offset.clamp(0, 100_000);
    let fetch_limit = offset.saturating_add(limit);
    let mut fetch_query = query.clone();
    fetch_query.offset = 0;
    fetch_query.limit = fetch_limit;
    let base_page = search_base_connection(&base, fetch_query.clone(), cancelled, fetch_limit)?;
    let full_page = search_extra_connection(full, fetch_query, cancelled, fetch_limit)?;
    let normalized = normalize_english_word(&query.text);
    let chinese = query.text.chars().any(is_han);
    let mut items = base_page.items;
    items.extend(full_page.items);
    items
        .sort_by(|left, right| compare_search_items(left, right, query.sort, &normalized, chinese));
    let start = (offset as usize).min(items.len());
    let end = start.saturating_add(limit as usize).min(items.len());
    Ok(DictionarySearchPage {
        items: items[start..end].to_vec(),
        total: base_page.total.saturating_add(full_page.total),
        offset,
        limit,
    })
}

fn search_base_connection(
    connection: &Connection,
    query: MobileDictionarySearchQuery,
    cancelled: &AtomicBool,
    limit_cap: i64,
) -> Result<DictionarySearchPage, PlatformError> {
    let text = query.text.nfkc().collect::<String>().trim().to_string();
    if text.chars().count() > 80 {
        return Err(PlatformError::new(
            "invalidInput",
            "词典搜索内容过长。",
            false,
        ));
    }
    let limit = query.limit.clamp(1, limit_cap.max(1));
    let offset = query.offset.max(0);
    let chinese = text.chars().any(is_han);
    let normalized = normalize_english_word(&text);
    let mut conditions = Vec::new();
    let mut filter_values = Vec::<Value>::new();
    if text.is_empty() {
        conditions.push("1=1".to_string());
    } else if chinese {
        let fts = chinese_search_tokens(&text)
            .into_iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        conditions.push("l.lexeme_id IN (SELECT e.lexeme_id FROM entries_fts JOIN entries e ON e.entry_id=entries_fts.rowid WHERE entries_fts MATCH ?)".into());
        filter_values.push(fts.into());
    } else {
        conditions.push("l.lexeme_id IN (SELECT lexeme_id FROM lexemes WHERE normalized=? COLLATE NOCASE UNION SELECT lexeme_id FROM lexemes WHERE normalized>=? COLLATE NOCASE AND normalized<? COLLATE NOCASE UNION SELECT lexeme_id FROM forms WHERE form=? COLLATE NOCASE)".into());
        filter_values.extend([
            normalized.clone().into(),
            normalized.clone().into(),
            prefix_upper_bound(&normalized).into(),
            normalized.clone().into(),
        ]);
    }
    let mut tags = query
        .tags
        .iter()
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    if tags.len() > 16
        || tags.iter().any(|tag| {
            tag.len() > 32
                || !tag
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err(PlatformError::new(
            "invalidInput",
            "词典筛选标签无效。",
            false,
        ));
    }
    if !tags.is_empty() {
        let placeholders = std::iter::repeat("?")
            .take(tags.len())
            .collect::<Vec<_>>()
            .join(",");
        if query.tag_match == DictionaryTagMatch::All {
            conditions.push(format!("(SELECT COUNT(DISTINCT t.tag) FROM tags t WHERE t.lexeme_id=l.lexeme_id AND t.tag IN ({placeholders}))=?"));
            filter_values.extend(tags.iter().cloned().map(Value::from));
            filter_values.push((tags.len() as i64).into());
        } else {
            conditions.push(format!("EXISTS (SELECT 1 FROM tags t WHERE t.lexeme_id=l.lexeme_id AND t.tag IN ({placeholders}))"));
            filter_values.extend(tags.iter().cloned().map(Value::from));
        }
    }
    if query.oxford_only {
        conditions.push("l.oxford>0".into());
    }
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "l.collins>=?",
        query.collins_min,
    )?;
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "l.bnc>0 AND l.bnc<=?",
        query.bnc_max,
    )?;
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "l.frq>0 AND l.frq<=?",
        query.contemporary_max,
    )?;
    let condition = conditions.join(" AND ");
    let total_sql = format!("SELECT COUNT(*) FROM lexemes l WHERE {condition}");
    let total: i64 = connection
        .query_row(&total_sql, params_from_iter(filter_values.iter()), |row| {
            row.get(0)
        })
        .map_err(|_| query_failed())?;
    let relevance_order = "CASE WHEN l.normalized=? COLLATE NOCASE THEN 0 WHEN EXISTS (SELECT 1 FROM forms f WHERE f.lexeme_id=l.lexeme_id AND f.form=? COLLATE NOCASE) THEN 1 ELSE 2 END,COALESCE(NULLIF(l.frq,0),NULLIF(l.bnc,0),99999999),l.lemma COLLATE NOCASE";
    let order = match query.sort {
        DictionarySearchSort::Alphabetical => "l.lemma COLLATE NOCASE".to_string(),
        DictionarySearchSort::Frequency => {
            "COALESCE(NULLIF(l.frq,0),NULLIF(l.bnc,0),99999999),l.lemma COLLATE NOCASE".to_string()
        }
        DictionarySearchSort::Relevance if !text.is_empty() && !chinese => {
            relevance_order.to_string()
        }
        DictionarySearchSort::Relevance => {
            "COALESCE(NULLIF(l.frq,0),NULLIF(l.bnc,0),99999999),l.lemma COLLATE NOCASE".to_string()
        }
    };
    let sql = format!(
        "SELECT l.lexeme_key,l.lemma,l.phonetic,l.collins,l.oxford,l.bnc,l.frq,
         (SELECT group_concat(tag,' ') FROM tags t WHERE t.lexeme_id=l.lexeme_id),
         (SELECT translation FROM entries e WHERE e.lexeme_id=l.lexeme_id ORDER BY e.entry_id LIMIT 1),
         CASE WHEN ?<>'' AND EXISTS(SELECT 1 FROM forms f WHERE f.lexeme_id=l.lexeme_id AND f.form=? COLLATE NOCASE) THEN 'form' ELSE ? END
         FROM lexemes l WHERE {condition} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    let matched = if chinese { "translation" } else { "lemma" };
    let mut statement = connection.prepare(&sql).map_err(|_| query_failed())?;
    let matched = if text.is_empty() { "filter" } else { matched };
    let mut values = vec![
        normalized.clone().into(),
        normalized.clone().into(),
        matched.to_string().into(),
    ];
    values.extend(filter_values);
    if query.sort == DictionarySearchSort::Relevance && !text.is_empty() && !chinese {
        values.extend([normalized.clone().into(), normalized.clone().into()]);
    }
    values.extend([limit.into(), offset.into()]);
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(|_| query_failed())?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|_| query_failed())? {
        check_cancelled(cancelled)?;
        items.push(search_item_from_row(row).map_err(|_| query_failed())?);
    }
    Ok(DictionarySearchPage {
        items,
        total,
        offset,
        limit,
    })
}

fn search_extra_connection(
    connection: &Connection,
    query: MobileDictionarySearchQuery,
    cancelled: &AtomicBool,
    limit_cap: i64,
) -> Result<DictionarySearchPage, PlatformError> {
    let text = query.text.nfkc().collect::<String>().trim().to_string();
    let limit = query.limit.clamp(1, limit_cap.max(1));
    let offset = query.offset.max(0);
    let chinese = text.chars().any(is_han);
    let normalized = normalize_english_word(&text);
    let mut conditions = Vec::new();
    let mut filter_values = Vec::<Value>::new();
    if text.is_empty() {
        conditions.push("1=1".to_string());
    } else if chinese {
        let fts = chinese_search_tokens(&text)
            .into_iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        conditions.push("x.lexeme_key IN (SELECT e.lexeme_key FROM extra_entries_fts JOIN extra_entries e ON e.entry_id=extra_entries_fts.rowid WHERE extra_entries_fts MATCH ?)".into());
        filter_values.push(fts.into());
    } else {
        conditions.push("x.lexeme_key IN (SELECT lexeme_key FROM extra_lexemes WHERE normalized=? COLLATE NOCASE UNION SELECT lexeme_key FROM extra_lexemes WHERE normalized>=? COLLATE NOCASE AND normalized<? COLLATE NOCASE UNION SELECT lexeme_key FROM extra_forms WHERE form=? COLLATE NOCASE)".into());
        filter_values.extend([
            normalized.clone().into(),
            normalized.clone().into(),
            prefix_upper_bound(&normalized).into(),
            normalized.clone().into(),
        ]);
    }
    let mut tags = query
        .tags
        .iter()
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    if !tags.is_empty() {
        let placeholders = std::iter::repeat("?")
            .take(tags.len())
            .collect::<Vec<_>>()
            .join(",");
        if query.tag_match == DictionaryTagMatch::All {
            conditions.push(format!("(SELECT COUNT(DISTINCT t.tag) FROM extra_tags t WHERE t.lexeme_key=x.lexeme_key AND t.tag IN ({placeholders}))=?"));
            filter_values.extend(tags.iter().cloned().map(Value::from));
            filter_values.push((tags.len() as i64).into());
        } else {
            conditions.push(format!("EXISTS (SELECT 1 FROM extra_tags t WHERE t.lexeme_key=x.lexeme_key AND t.tag IN ({placeholders}))"));
            filter_values.extend(tags.iter().cloned().map(Value::from));
        }
    }
    if query.oxford_only {
        conditions.push("x.oxford>0".into());
    }
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "x.collins>=?",
        query.collins_min,
    )?;
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "x.bnc>0 AND x.bnc<=?",
        query.bnc_max,
    )?;
    push_positive_max_filter(
        &mut conditions,
        &mut filter_values,
        "x.frq>0 AND x.frq<=?",
        query.contemporary_max,
    )?;
    let condition = conditions.join(" AND ");
    let total: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM extra_lexemes x WHERE {condition}"),
            params_from_iter(filter_values.iter()),
            |row| row.get(0),
        )
        .map_err(|_| query_failed())?;
    let order = match query.sort {
        DictionarySearchSort::Alphabetical => "x.lemma COLLATE NOCASE",
        DictionarySearchSort::Frequency => {
            "COALESCE(NULLIF(x.frq,0),NULLIF(x.bnc,0),99999999),x.lemma COLLATE NOCASE"
        }
        DictionarySearchSort::Relevance if !text.is_empty() && !chinese => {
            "CASE WHEN x.normalized=? COLLATE NOCASE THEN 0 WHEN EXISTS (SELECT 1 FROM extra_forms f WHERE f.lexeme_key=x.lexeme_key AND f.form=? COLLATE NOCASE) THEN 1 ELSE 2 END,COALESCE(NULLIF(x.frq,0),NULLIF(x.bnc,0),99999999),x.lemma COLLATE NOCASE"
        }
        DictionarySearchSort::Relevance => {
            "COALESCE(NULLIF(x.frq,0),NULLIF(x.bnc,0),99999999),x.lemma COLLATE NOCASE"
        }
    };
    let sql = format!(
        "SELECT x.lexeme_key,x.lemma,x.phonetic,x.collins,x.oxford,x.bnc,x.frq,
         (SELECT group_concat(tag,' ') FROM extra_tags t WHERE t.lexeme_key=x.lexeme_key),
         (SELECT translation FROM extra_entries e WHERE e.lexeme_key=x.lexeme_key ORDER BY e.entry_id LIMIT 1),
         CASE WHEN ?<>'' AND EXISTS(SELECT 1 FROM extra_forms f WHERE f.lexeme_key=x.lexeme_key AND f.form=? COLLATE NOCASE) THEN 'form' ELSE ? END
         FROM extra_lexemes x WHERE {condition} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    let matched = if text.is_empty() {
        "filter"
    } else if chinese {
        "translation"
    } else {
        "lemma"
    };
    let mut values = vec![
        normalized.clone().into(),
        normalized.clone().into(),
        matched.to_string().into(),
    ];
    values.extend(filter_values);
    if query.sort == DictionarySearchSort::Relevance && !text.is_empty() && !chinese {
        values.extend([normalized.clone().into(), normalized.into()]);
    }
    values.extend([limit.into(), offset.into()]);
    let mut statement = connection.prepare(&sql).map_err(|_| query_failed())?;
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(|_| query_failed())?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|_| query_failed())? {
        check_cancelled(cancelled)?;
        items.push(search_item_from_row(row).map_err(|_| query_failed())?);
    }
    Ok(DictionarySearchPage {
        items,
        total,
        offset,
        limit,
    })
}

fn compare_search_items(
    left: &DictionarySearchItem,
    right: &DictionarySearchItem,
    sort: DictionarySearchSort,
    normalized: &str,
    chinese: bool,
) -> std::cmp::Ordering {
    let lemma_order = || {
        left.lemma
            .to_lowercase()
            .cmp(&right.lemma.to_lowercase())
            .then_with(|| left.lexeme_key.cmp(&right.lexeme_key))
    };
    let frequency = |item: &DictionarySearchItem| {
        item.frequency
            .contemporary
            .or(item.frequency.bnc)
            .unwrap_or(i64::MAX)
    };
    let frequency_order = || {
        frequency(left)
            .cmp(&frequency(right))
            .then_with(lemma_order)
    };
    match sort {
        DictionarySearchSort::Alphabetical => lemma_order(),
        DictionarySearchSort::Frequency => frequency_order(),
        DictionarySearchSort::Relevance if !normalized.is_empty() && !chinese => {
            let rank = |item: &DictionarySearchItem| {
                if normalize_english_word(&item.lemma) == normalized {
                    0
                } else if item.matched_by == "form" {
                    1
                } else {
                    2
                }
            };
            rank(left).cmp(&rank(right)).then_with(frequency_order)
        }
        DictionarySearchSort::Relevance => frequency_order(),
    }
}

pub fn resolve_context(
    text: &str,
    requested_surface: &str,
    token_index: i64,
) -> Result<DictionaryLookupContext, PlatformError> {
    if token_index < 0 || requested_surface.chars().count() > 120 {
        return Err(invalid_context());
    }
    let tokens = tokenize_english(text);
    let token = tokens
        .get(token_index as usize)
        .ok_or_else(invalid_context)?;
    if normalize_english_word(&token.surface) != normalize_english_word(requested_surface) {
        return Err(invalid_context());
    }
    Ok(DictionaryLookupContext {
        surface: token.surface.clone(),
        sentence: sentence_around(text, token.start, token.end),
        paragraph: text.to_string(),
    })
}

fn resolve(
    connection: &Connection,
    surface: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<LexemeCandidate>, PlatformError> {
    let normalized = normalize_english_word(surface);
    let mut candidates: HashMap<String, (&'static str, f64)> = HashMap::new();
    if let Some(key) = connection
        .query_row(
            "SELECT lexeme_key FROM lexemes WHERE normalized=?1 COLLATE NOCASE",
            [&normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| query_failed())?
    {
        candidates.insert(key, ("exact", 1.0));
    }
    let mut form_statement = connection
        .prepare(
            "SELECT l.lexeme_key FROM forms f JOIN lexemes l ON l.lexeme_id=f.lexeme_id WHERE f.form=?1 COLLATE NOCASE LIMIT 12",
        )
        .map_err(|_| query_failed())?;
    let form_keys = form_statement
        .query_map([&normalized], |row| row.get::<_, String>(0))
        .map_err(|_| query_failed())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| query_failed())?;
    for key in form_keys {
        candidates.entry(key).or_insert(("inflection", 0.82));
    }
    for lemma in conservative_lemma_candidates(&normalized) {
        if let Some(key) = connection
            .query_row(
                "SELECT lexeme_key FROM lexemes WHERE normalized=?1 COLLATE NOCASE",
                [&lemma],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| query_failed())?
        {
            candidates.entry(key).or_insert(("heuristic", 0.55));
        }
    }
    let mut result = Vec::new();
    for (key, (relation, confidence)) in candidates {
        check_cancelled(cancelled)?;
        let detail = get_lexeme_from_connection(connection, &key)?;
        result.push(LexemeCandidate {
            lexeme_key: key,
            lemma: detail.summary.lemma,
            relation,
            confidence,
            phonetic: detail.summary.phonetic,
            brief_meanings: detail.summary.brief_meanings,
        });
    }
    result.sort_by(|left, right| {
        right
            .confidence
            .total_cmp(&left.confidence)
            .then_with(|| left.lemma.cmp(&right.lemma))
    });
    Ok(result)
}

fn resolve_with_extension(
    connection: &Connection,
    full: Option<&Connection>,
    surface: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<LexemeCandidate>, PlatformError> {
    let mut result = resolve(connection, surface, cancelled)?;
    let Some(full) = full else {
        return Ok(result);
    };
    let normalized = normalize_english_word(surface);
    let mut extra = HashMap::<String, (&'static str, f64)>::new();
    if let Some(key) = full
        .query_row(
            "SELECT lexeme_key FROM extra_lexemes WHERE normalized=?1 COLLATE NOCASE",
            [&normalized],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| query_failed())?
    {
        extra.insert(key, ("exact", 1.0));
    }
    let mut statement = full
        .prepare("SELECT lexeme_key FROM extra_forms WHERE form=?1 COLLATE NOCASE LIMIT 12")
        .map_err(|_| query_failed())?;
    for key in statement
        .query_map([&normalized], |row| row.get::<_, String>(0))
        .map_err(|_| query_failed())?
    {
        extra
            .entry(key.map_err(|_| query_failed())?)
            .or_insert(("inflection", 0.82));
    }
    for (key, (relation, confidence)) in extra {
        if result.iter().any(|candidate| candidate.lexeme_key == key) {
            continue;
        }
        check_cancelled(cancelled)?;
        let detail = get_extra_lexeme(full, &key)?;
        result.push(LexemeCandidate {
            lexeme_key: key,
            lemma: detail.summary.lemma,
            relation,
            confidence,
            phonetic: detail.summary.phonetic,
            brief_meanings: detail.summary.brief_meanings,
        });
    }
    result.sort_by(|left, right| {
        right
            .confidence
            .total_cmp(&left.confidence)
            .then_with(|| left.lemma.cmp(&right.lemma))
    });
    Ok(result)
}

fn get_lexeme_from_connection(
    connection: &Connection,
    lexeme_key: &str,
) -> Result<LexemeDetail, PlatformError> {
    get_lexeme_from_connections(connection, None, lexeme_key)
}

fn get_lexeme_from_connections(
    connection: &Connection,
    full: Option<&Connection>,
    lexeme_key: &str,
) -> Result<LexemeDetail, PlatformError> {
    let summary = connection
        .query_row(
            "SELECT l.lexeme_key,l.lemma,l.phonetic,l.collins,l.oxford,l.bnc,l.frq,
             (SELECT group_concat(tag,' ') FROM tags t WHERE t.lexeme_id=l.lexeme_id),
             (SELECT translation FROM entries e WHERE e.lexeme_id=l.lexeme_id ORDER BY e.entry_id LIMIT 1),'lemma',l.lexeme_id
             FROM lexemes l WHERE l.lexeme_key=?1",
            [lexeme_key],
            |row| Ok((search_item_from_row(row)?, row.get::<_, i64>(10)?)),
        )
        .optional()
        .map_err(|_| query_failed())?
        .ok_or_else(|| PlatformError::new("learningEntityMissing", "未找到该词条。", false))?;
    let (summary, lexeme_id) = summary;
    let mut entry_statement = connection
        .prepare(
            "SELECT entry_id,word,phonetic,translation,pos,tag,bnc,frq FROM entries WHERE lexeme_id=?1 ORDER BY entry_id",
        )
        .map_err(|_| query_failed())?;
    let entries = entry_statement
        .query_map([lexeme_id], |row| {
            let entry_id: i64 = row.get(0)?;
            let translation: Option<String> = row.get(3)?;
            let definition = full.and_then(|full| {
                full.query_row(
                    "SELECT definition FROM full_entries WHERE entry_id=?1 AND lexeme_key=?2",
                    params![entry_id, lexeme_key],
                    |definition_row| definition_row.get::<_, Option<String>>(0),
                )
                .optional()
                .ok()
                .flatten()
                .flatten()
            });
            Ok(DictionaryEntryResult {
                word: row.get(1)?,
                phonetic: row.get(2)?,
                senses: group_senses_with_definition(
                    translation.as_deref().unwrap_or(""),
                    definition.as_deref().unwrap_or(""),
                ),
                position_weights: row.get(4)?,
                tags: split_words(row.get::<_, Option<String>>(5)?.as_deref().unwrap_or("")),
                frequency: DictionaryFrequency {
                    bnc: positive(row.get(6)?),
                    contemporary: positive(row.get(7)?),
                },
                exchanges: Vec::new(),
            })
        })
        .map_err(|_| query_failed())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| query_failed())?;
    let forms = connection
        .prepare("SELECT form FROM forms WHERE lexeme_id=?1 ORDER BY form")
        .and_then(|mut statement| {
            statement
                .query_map([lexeme_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| query_failed())?;
    let collections = connection
        .prepare(
            "SELECT c.id,c.tag,c.name,(SELECT COUNT(*) FROM collection_items x WHERE x.collection_id=c.id)
             FROM collections c JOIN collection_items i ON i.collection_id=c.id WHERE i.lexeme_id=?1 ORDER BY c.name",
        )
        .and_then(|mut statement| {
            statement
                .query_map([lexeme_id], |row| {
                    Ok(DictionaryCollection {
                        id: row.get(0)?,
                        tag: row.get(1)?,
                        name: row.get(2)?,
                        count: row.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| query_failed())?;
    Ok(LexemeDetail {
        summary,
        entries,
        forms,
        collections,
        provider_id: "ecdict",
        examples: Vec::new(),
        similar_words: Vec::new(),
    })
}

fn search_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictionarySearchItem> {
    let translation: Option<String> = row.get(8)?;
    let matched: String = row.get(9)?;
    Ok(DictionarySearchItem {
        lexeme_key: row.get(0)?,
        lemma: row.get(1)?,
        phonetic: row.get(2)?,
        brief_meanings: split_lines(translation.as_deref().unwrap_or(""))
            .into_iter()
            .take(3)
            .collect(),
        tags: split_words(row.get::<_, Option<String>>(7)?.as_deref().unwrap_or("")),
        collins: positive(row.get(3)?),
        oxford: row.get::<_, i64>(4)? > 0,
        frequency: DictionaryFrequency {
            bnc: positive(row.get(5)?),
            contemporary: positive(row.get(6)?),
        },
        matched_by: match matched.as_str() {
            "form" => "form",
            "translation" => "translation",
            "filter" => "filter",
            _ => "lemma",
        },
    })
}

fn open(path: &Path) -> Result<Connection, PlatformError> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| PlatformError::new("dictionaryNotInstalled", "尚未安装本地词典。", false))
}

fn open_compatible_full(
    base: &Connection,
    path: Option<&Path>,
) -> Result<Option<Connection>, PlatformError> {
    let Some(path) = path.filter(|path| path.is_file()) else {
        return Ok(None);
    };
    let full = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| query_failed())?;
    let compatible = metadata(&full, "schemaVersion").ok().as_deref() == Some("1")
        && metadata(&full, "datasetRevision").ok() == metadata(base, "datasetRevision").ok()
        && metadata(&full, "lexemeMapHash").ok() == metadata(base, "lexemeMapHash").ok();
    Ok(compatible.then_some(full))
}

fn get_extra_lexeme(full: &Connection, lexeme_key: &str) -> Result<LexemeDetail, PlatformError> {
    let row = full
        .query_row(
            "SELECT x.lexeme_key,x.lemma,x.phonetic,x.collins,x.oxford,x.bnc,x.frq,
             (SELECT tag FROM extra_entries e WHERE e.lexeme_key=x.lexeme_key ORDER BY entry_id LIMIT 1),
             (SELECT translation FROM extra_entries e WHERE e.lexeme_key=x.lexeme_key ORDER BY entry_id LIMIT 1),
             'lemma'
             FROM extra_lexemes x WHERE x.lexeme_key=?1",
            [lexeme_key],
            search_item_from_row,
        )
        .optional()
        .map_err(|_| query_failed())?
        .ok_or_else(|| PlatformError::new("learningEntityMissing", "未找到该词条。", false))?;
    let mut statement = full
        .prepare(
            "SELECT word,phonetic,translation,pos,tag,bnc,frq,definition
             FROM extra_entries WHERE lexeme_key=?1 ORDER BY entry_id",
        )
        .map_err(|_| query_failed())?;
    let entries = statement
        .query_map([lexeme_key], |row| {
            let translation: Option<String> = row.get(2)?;
            let definition: Option<String> = row.get(7)?;
            Ok(DictionaryEntryResult {
                word: row.get(0)?,
                phonetic: row.get(1)?,
                senses: group_senses_with_definition(
                    translation.as_deref().unwrap_or(""),
                    definition.as_deref().unwrap_or(""),
                ),
                position_weights: row.get(3)?,
                tags: split_words(row.get::<_, Option<String>>(4)?.as_deref().unwrap_or("")),
                frequency: DictionaryFrequency {
                    bnc: positive(row.get(5)?),
                    contemporary: positive(row.get(6)?),
                },
                exchanges: Vec::new(),
            })
        })
        .map_err(|_| query_failed())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| query_failed())?;
    let forms = full
        .prepare("SELECT form FROM extra_forms WHERE lexeme_key=?1 ORDER BY form")
        .and_then(|mut statement| {
            statement
                .query_map([lexeme_key], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| query_failed())?;
    Ok(LexemeDetail {
        summary: row,
        entries,
        forms,
        collections: Vec::new(),
        provider_id: "ecdict",
        examples: Vec::new(),
        similar_words: Vec::new(),
    })
}

fn metadata(connection: &Connection, key: &str) -> Result<String, PlatformError> {
    connection
        .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .map_err(|_| query_failed())
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), PlatformError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(PlatformError::new(
            "dictionaryQueryCancelled",
            "词典查询已取消。",
            false,
        ))
    } else {
        Ok(())
    }
}

fn query_failed() -> PlatformError {
    PlatformError::new("learningDatabaseUnavailable", "本地词典暂时不可用。", true)
}

fn invalid_context() -> PlatformError {
    PlatformError::new("invalidInput", "阅读器查词上下文无效。", false)
}

fn valid_lexeme_key(value: &str) -> bool {
    value.starts_with("lex_")
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn positive(value: Option<i64>) -> Option<i64> {
    value.filter(|number| *number > 0)
}

fn push_positive_max_filter(
    conditions: &mut Vec<String>,
    values: &mut Vec<Value>,
    condition: &str,
    value: Option<i64>,
) -> Result<(), PlatformError> {
    if let Some(value) = value {
        if !(1..=100_000).contains(&value) {
            return Err(PlatformError::new(
                "invalidInput",
                "词典数值筛选无效。",
                false,
            ));
        }
        conditions.push(format!("({condition})"));
        values.push(value.into());
    }
    Ok(())
}

fn prefix_upper_bound(value: &str) -> String {
    format!("{value}\u{10ffff}")
}

fn split_words(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_string).collect()
}

fn split_lines(value: &str) -> Vec<String> {
    value
        .replace("\\n", "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn group_senses_with_definition(translation: &str, definition: &str) -> Vec<DictionarySenseGroup> {
    let mut groups: Vec<DictionarySenseGroup> = Vec::new();
    let mut previous: Option<String> = None;
    for line in split_lines(translation) {
        let (candidate, text) = parse_pos_line(&line);
        let label = candidate
            .or_else(|| previous.clone())
            .unwrap_or_else(|| "其他".into());
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.part_of_speech == label)
        {
            if !group.translations.contains(&text) {
                group.translations.push(text);
            }
        } else {
            groups.push(DictionarySenseGroup {
                part_of_speech: label.clone(),
                translations: vec![text],
                definitions: Vec::new(),
            });
        }
        previous = Some(label);
    }
    previous = None;
    for line in split_lines(definition) {
        let (candidate, text) = parse_pos_line(&line);
        let label = candidate
            .or_else(|| previous.clone())
            .or_else(|| (groups.len() == 1).then(|| groups[0].part_of_speech.clone()))
            .unwrap_or_else(|| "其他".into());
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.part_of_speech == label)
        {
            if !group.definitions.contains(&text) {
                group.definitions.push(text);
            }
        } else {
            groups.push(DictionarySenseGroup {
                part_of_speech: label.clone(),
                translations: Vec::new(),
                definitions: vec![text],
            });
        }
        previous = Some(label);
    }
    groups
}

fn parse_pos_line(line: &str) -> (Option<String>, String) {
    let trimmed = line.trim();
    let split = trimmed.find(|character: char| character.is_whitespace());
    let Some(index) = split else {
        return (None, trimmed.into());
    };
    let code = trimmed[..index].trim_end_matches('.').to_ascii_lowercase();
    if code.is_empty()
        || code.len() > 11
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        return (None, trimmed.into());
    }
    let label = match code.as_str() {
        "n" | "noun" => "名词 · n.",
        "v" | "verb" => "动词 · v.",
        "vt" => "及物动词 · vt.",
        "vi" => "不及物动词 · vi.",
        "a" | "s" | "j" | "adj" => "形容词 · adj.",
        "r" | "d" | "adv" => "副词 · adv.",
        "p" | "prep" => "介词 · prep.",
        "c" | "conj" => "连词 · conj.",
        "pron" => "代词 · pron.",
        "num" => "数词 · num.",
        "art" => "冠词 · art.",
        "aux" => "助动词 · aux.",
        _ => {
            return (
                Some(format!("其他 · {code}")),
                trimmed[index..].trim().into(),
            )
        }
    };
    (Some(label.into()), trimmed[index..].trim().into())
}

#[derive(Debug)]
struct Token {
    surface: String,
    start: usize,
    end: usize,
}

fn tokenize_english(value: &str) -> Vec<Token> {
    Regex::new(r"(?:[A-Za-z]\.){2,}|[A-Za-z]+(?:[’'][A-Za-z]+)*(?:-[A-Za-z]+(?:[’'][A-Za-z]+)*)*")
        .expect("fixed token regex")
        .find_iter(value)
        .map(|matched| Token {
            surface: matched.as_str().to_string(),
            start: matched.start(),
            end: matched.end(),
        })
        .collect()
}

pub fn normalize_english_word(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .replace(['’', '‘'], "'")
        .trim_end_matches('.')
        .to_lowercase()
        .trim()
        .into()
}

fn sentence_around(value: &str, token_start: usize, token_end: usize) -> String {
    let bytes = value.as_bytes();
    let mut start = 0;
    for index in (0..token_start).rev() {
        if matches!(bytes[index], b'.' | b'!' | b'?' | b'\n') {
            start = index + 1;
            break;
        }
    }
    let mut end = value.len();
    for (index, byte) in bytes.iter().enumerate().skip(token_end) {
        if matches!(byte, b'.' | b'!' | b'?' | b'\n') {
            end = index + 1;
            break;
        }
    }
    value[start..end].trim().to_string()
}

fn conservative_lemma_candidates(word: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut add = |value: String| {
        if value.len() >= 2 && value != word && !candidates.contains(&value) {
            candidates.push(value);
        }
    };
    if let Some(stem) = word.strip_suffix("'s") {
        add(stem.into());
    }
    if word.len() > 4 {
        if let Some(stem) = word.strip_suffix("ies") {
            add(format!("{stem}y"));
        }
        if let Some(stem) = word.strip_suffix("ves") {
            add(format!("{stem}f"));
            add(format!("{stem}fe"));
        }
        if let Some(stem) = word.strip_suffix("ied") {
            add(format!("{stem}y"));
        }
    }
    if word.len() > 3 {
        if let Some(stem) = word.strip_suffix("es") {
            add(stem.into());
        }
        if word.ends_with('s') && !word.ends_with("ss") {
            add(word[..word.len() - 1].into());
        }
        if let Some(stem) = word.strip_suffix("ed") {
            add(stem.into());
            add(format!("{stem}e"));
        }
    }
    if word.len() > 5 {
        if let Some(stem) = word.strip_suffix("ing") {
            add(stem.into());
            add(format!("{stem}e"));
            let bytes = stem.as_bytes();
            if bytes.len() > 2 && bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
                add(stem[..stem.len() - 1].into());
            }
        }
    }
    candidates
}

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

fn chinese_search_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let compact = value.nfkc().collect::<String>().to_lowercase();
    let mut han = Vec::new();
    let mut ascii_word = String::new();
    let flush_han = |characters: &mut Vec<char>, tokens: &mut Vec<String>| {
        for character in characters.iter() {
            let token = character.to_string();
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
        for pair in characters.windows(2) {
            let token = pair.iter().collect::<String>();
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
        characters.clear();
    };
    let flush_ascii = |word: &mut String, tokens: &mut Vec<String>| {
        if !word.is_empty() && !tokens.contains(word) {
            tokens.push(word.clone());
        }
        word.clear();
    };
    for character in compact.chars() {
        if is_han(character) {
            flush_ascii(&mut ascii_word, &mut tokens);
            han.push(character);
        } else {
            flush_han(&mut han, &mut tokens);
            if character.is_ascii_alphanumeric() {
                ascii_word.push(character);
            } else {
                flush_ascii(&mut ascii_word, &mut tokens);
            }
        }
    }
    flush_han(&mut han, &mut tokens);
    flush_ascii(&mut ascii_word, &mut tokens);
    tokens
}

pub fn chinese_search_index_tokens(value: &str) -> String {
    chinese_search_tokens(value).join(" ")
}

use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning_contract::create_lexeme_key;
    use rusqlite::Connection;

    fn fixture(root: &Path) -> PathBuf {
        let path = root.join("ecdict.sqlite");
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 CREATE TABLE lexemes(lexeme_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL UNIQUE,language TEXT NOT NULL,lemma TEXT NOT NULL,normalized TEXT NOT NULL UNIQUE,phonetic TEXT,collins INTEGER,oxford INTEGER NOT NULL,bnc INTEGER,frq INTEGER);
                 CREATE TABLE entries(entry_id INTEGER PRIMARY KEY,lexeme_id INTEGER NOT NULL,word TEXT NOT NULL,phonetic TEXT,translation TEXT,pos TEXT,tag TEXT,bnc INTEGER,frq INTEGER);
                 CREATE TABLE forms(form TEXT NOT NULL,lexeme_id INTEGER NOT NULL,lemma TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(form,lexeme_id));
                 CREATE TABLE tags(lexeme_id INTEGER NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(lexeme_id,tag));
                 CREATE TABLE collections(id TEXT PRIMARY KEY,tag TEXT NOT NULL,name TEXT NOT NULL);
                 CREATE TABLE collection_items(collection_id TEXT NOT NULL,lexeme_id INTEGER NOT NULL,PRIMARY KEY(collection_id,lexeme_id));
                 CREATE VIRTUAL TABLE entries_fts USING fts5(cjk_tokens,content='',columnsize=0,tokenize='unicode61 remove_diacritics 2');",
            )
            .expect("schema");
        for (id, lemma, translation, forms) in [
            (1, "run", "v. 跑；运行", vec!["running", "ran"]),
            (2, "see", "v. 看见；理解", vec!["saw", "seen"]),
            (3, "saw", "n. 锯；v. 锯", vec![]),
        ] {
            let key = create_lexeme_key("en", lemma);
            connection
                .execute(
                    "INSERT INTO lexemes VALUES(?1,?2,'en',?3,?3,NULL,3,1,100,100)",
                    params![id, key, lemma],
                )
                .expect("lexeme");
            connection.execute("INSERT INTO entries(entry_id,lexeme_id,word,translation,tag,bnc,frq) VALUES(?1,?1,?2,?3,'cet4',100,100)",params![id,lemma,translation]).expect("entry");
            connection
                .execute(
                    "INSERT INTO entries_fts(rowid,cjk_tokens) VALUES(?1,?2)",
                    params![id, chinese_search_index_tokens(translation)],
                )
                .expect("fts");
            connection
                .execute("INSERT INTO tags VALUES(?1,'cet4')", [id])
                .expect("tag");
            for form in forms {
                connection
                    .execute(
                        "INSERT INTO forms VALUES(?1,?2,?3,'fixture')",
                        params![form, id, lemma],
                    )
                    .expect("form");
            }
        }
        connection
            .execute("INSERT INTO metadata VALUES('version','fixture')", [])
            .expect("metadata");
        connection
            .execute(
                "INSERT INTO collections VALUES('ecdict:cet4','cet4','大学英语四级')",
                [],
            )
            .expect("collection");
        connection
            .execute("INSERT INTO collection_items VALUES('ecdict:cet4',1)", [])
            .expect("collection item");
        path
    }

    #[test]
    fn resolves_exact_inflection_ambiguity_and_missing() {
        let root = tempfile::tempdir().expect("root");
        let path = fixture(root.path());
        let active = AtomicBool::new(false);
        let result = lookup(
            &path,
            DictionaryLookupContext {
                surface: "running".into(),
                sentence: "Running is useful.".into(),
                paragraph: "Running is useful.".into(),
            },
            None,
            &active,
        )
        .expect("lookup");
        assert_eq!(result.lemma, "run");
        assert_eq!(result.candidates[0].relation, "inflection");
        let ambiguous = lookup(
            &path,
            DictionaryLookupContext {
                surface: "saw".into(),
                sentence: "I saw it.".into(),
                paragraph: "I saw it.".into(),
            },
            None,
            &active,
        )
        .expect("ambiguous");
        assert!(ambiguous.requires_selection);
        assert_eq!(ambiguous.candidates.len(), 2);
        let missing = lookup(
            &path,
            DictionaryLookupContext {
                surface: "unlisted".into(),
                sentence: "Unlisted word.".into(),
                paragraph: "Unlisted word.".into(),
            },
            None,
            &active,
        )
        .expect("missing");
        assert!(!missing.found);
    }

    #[test]
    fn validates_reader_token_context_and_searches() {
        let context =
            resolve_context("The reader saw several meanings.", "saw", 2).expect("context");
        assert_eq!(context.sentence, "The reader saw several meanings.");
        assert!(resolve_context("The reader saw several meanings.", "see", 2).is_err());
        let root = tempfile::tempdir().expect("root");
        let path = fixture(root.path());
        let page = search(
            &path,
            MobileDictionarySearchQuery {
                text: "run".into(),
                offset: 0,
                limit: 20,
                ..Default::default()
            },
            &AtomicBool::new(false),
        )
        .expect("search");
        assert_eq!(page.items[0].lemma, "run");
        let chinese_page = search(
            &path,
            MobileDictionarySearchQuery {
                text: "跑".into(),
                offset: 0,
                limit: 20,
                ..Default::default()
            },
            &AtomicBool::new(false),
        )
        .expect("Chinese search");
        assert_eq!(chinese_page.items[0].lemma, "run");
        assert_eq!(chinese_page.items[0].matched_by, "translation");
    }

    #[test]
    fn searches_with_shared_filters_sorting_and_collections() {
        let root = tempfile::tempdir().expect("root");
        let path = fixture(root.path());
        let collections = list_collections(&path).expect("collections");
        assert_eq!(collections[0].tag, "cet4");
        assert_eq!(collections[0].count, 1);
        let page = search(
            &path,
            MobileDictionarySearchQuery {
                text: String::new(),
                tags: vec!["CET4".into()],
                tag_match: DictionaryTagMatch::All,
                oxford_only: true,
                collins_min: Some(3),
                bnc_max: Some(100),
                contemporary_max: Some(100),
                sort: DictionarySearchSort::Alphabetical,
                offset: 0,
                limit: 20,
            },
            &AtomicBool::new(false),
        )
        .expect("filtered search");
        assert_eq!(page.total, 3);
        assert_eq!(page.items[0].lemma, "run");
        assert_eq!(page.items[1].lemma, "saw");
        assert_eq!(page.items[2].lemma, "see");
    }

    #[test]
    fn persists_the_e4_dictionary_preferences_without_a_schema_change() {
        let root = tempfile::tempdir().expect("root");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        let database = AndroidDatabase::open(&paths, "test").expect("database");
        let defaults = get_preferences(&database).expect("defaults");
        assert!(defaults.enabled);
        assert_eq!(defaults.lookup_provider_id, "ecdict");
        assert!(!defaults.context_explanation_enabled);
        let saved = save_preferences(
            &database,
            DictionaryPreferences {
                enabled: false,
                ..defaults
            },
        )
        .expect("save local preferences");
        assert_eq!(get_preferences(&database).expect("reload"), saved);
        let mut online = saved;
        online.lookup_provider_id = "baidu".into();
        online.context_explanation_enabled = true;
        online.translate_examples = true;
        assert_eq!(
            save_preferences(&database, online.clone()).expect("save E4 preferences"),
            online
        );
    }

    #[test]
    fn preserves_d0_resolution_vector_order() {
        let root = tempfile::tempdir().expect("root");
        let path = fixture(root.path());
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/d0-learning.json"))
                .expect("D0 vector");
        for case in vector["dictionary"]["resolutionCases"]
            .as_array()
            .expect("resolution cases")
        {
            let surface = case["surface"].as_str().expect("surface");
            let expected = case["candidateKeys"]
                .as_array()
                .expect("candidate keys")
                .iter()
                .map(|value| value.as_str().expect("candidate key"))
                .collect::<Vec<_>>();
            let result = lookup(
                &path,
                DictionaryLookupContext {
                    surface: surface.into(),
                    sentence: surface.into(),
                    paragraph: surface.into(),
                },
                None,
                &AtomicBool::new(false),
            )
            .expect("lookup");
            let actual = result
                .candidates
                .iter()
                .map(|candidate| candidate.lexeme_key.as_str())
                .collect::<Vec<_>>();
            assert_eq!(actual, expected, "surface: {surface}");
        }
    }
}
