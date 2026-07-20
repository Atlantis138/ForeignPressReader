use crate::{
    database::{stable_identity, AndroidDatabase},
    dictionary_query::{DictionaryLookupRequest, LexemeDetail},
    mobile_reading,
    platform_error::PlatformError,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct VerifiedVocabularyContext {
    pub publication_id: String,
    pub publication_title: String,
    pub article_id: String,
    pub article_title: String,
    pub block_id: String,
    pub token_index: i64,
    pub surface: String,
    pub sentence: String,
    pub paragraph: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderVocabularyState {
    pub lexeme_key: String,
    pub favorite: bool,
    pub context_saved: bool,
    pub manual_state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyListQuery {
    pub text: String,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyListItem {
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub brief_meanings: Vec<String>,
    pub manual_state: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyListPage {
    pub items: Vec<VocabularyListItem>,
    pub offset: i64,
    pub limit: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedContextItem {
    pub context_id: String,
    pub publication_id: Option<String>,
    pub publication_title: String,
    pub article_id: Option<String>,
    pub article_title: String,
    pub sentence: String,
    pub surface: String,
    pub paragraph: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedContextPage {
    pub items: Vec<SavedContextItem>,
    pub offset: i64,
    pub limit: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLexemeSnapshot {
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub brief_meanings: Vec<String>,
    pub sense_groups: Vec<serde_json::Value>,
    pub frequency: MobileLexemeSnapshotFrequency,
    pub provider_id: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLexemeSnapshotFrequency {
    pub bnc: Option<i64>,
    pub contemporary: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileLexemeUserSnapshot {
    pub snapshot: MobileLexemeSnapshot,
    pub favorite: bool,
    pub manual_state: String,
}

pub fn get_lexeme_snapshot(
    database: &AndroidDatabase,
    lexeme_key: &str,
) -> Result<Option<MobileLexemeUserSnapshot>, PlatformError> {
    database.connection().query_row(
        "SELECT u.lemma_snapshot,u.phonetic_snapshot,u.brief_meanings_json,u.sense_groups_json,u.bnc_rank,u.frequency_rank,u.manual_state,EXISTS(SELECT 1 FROM vocabulary_sources s WHERE s.lexeme_key=u.lexeme_key AND s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1) FROM user_lexemes u WHERE u.lexeme_key=?1",
        [lexeme_key],
        |row| {
            let brief_raw: String = row.get(2)?;
            let senses_raw: String = row.get(3)?;
            Ok(MobileLexemeUserSnapshot {
                snapshot: MobileLexemeSnapshot {
                    lexeme_key: lexeme_key.to_owned(),
                    lemma: row.get(0)?,
                    phonetic: row.get(1)?,
                    brief_meanings: serde_json::from_str(&brief_raw).unwrap_or_default(),
                    sense_groups: serde_json::from_str(&senses_raw).unwrap_or_default(),
                    frequency: MobileLexemeSnapshotFrequency { bnc: row.get(4)?, contemporary: row.get(5)? },
                    provider_id: "ecdict",
                },
                manual_state: row.get(6)?,
                favorite: row.get(7)?,
            })
        },
    ).optional().map_err(|_| PlatformError::new("learningDatabaseUnavailable", "生词快照暂时不可用。", true))
}

pub fn verify_context(
    database: &AndroidDatabase,
    request: &DictionaryLookupRequest,
) -> Result<VerifiedVocabularyContext, PlatformError> {
    let context = mobile_reading::dictionary_lookup_context(database, request)?;
    database
        .connection()
        .query_row(
            "SELECT a.publication_id,p.title,a.title FROM articles a JOIN publications p ON p.id=a.publication_id WHERE a.id=?1",
            [&request.article_id],
            |row| {
                Ok(VerifiedVocabularyContext {
                    publication_id: row.get(0)?,
                    publication_title: row.get(1)?,
                    article_id: request.article_id.clone(),
                    article_title: row.get(2)?,
                    block_id: request.block_id.clone(),
                    token_index: request.token_index,
                    surface: context.surface.clone(),
                    sentence: context.sentence.clone(),
                    paragraph: context.paragraph.clone(),
                })
            },
        )
        .map_err(|_| PlatformError::new("invalidInput", "阅读器查词内容不存在。", false))
}

pub fn get_reader_state(
    database: &AndroidDatabase,
    context: &VerifiedVocabularyContext,
    lexeme_key: &str,
) -> Result<ReaderVocabularyState, PlatformError> {
    state(database, context, lexeme_key)
}

pub fn set_favorite(
    database: &mut AndroidDatabase,
    context: &VerifiedVocabularyContext,
    detail: &LexemeDetail,
    favorite: bool,
) -> Result<ReaderVocabularyState, PlatformError> {
    let device_id = database.device_id().to_owned();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    ensure_lexeme(&transaction, detail, &device_id)?;
    set_manual_source(
        &transaction,
        &detail.summary.lexeme_key,
        favorite,
        &device_id,
    )?;
    if favorite {
        set_saved_context(
            &transaction,
            context,
            &detail.summary.lexeme_key,
            true,
            &device_id,
        )?;
    }
    transaction.commit().map_err(database_error)?;
    state(database, context, &detail.summary.lexeme_key)
}

pub fn set_context_saved(
    database: &mut AndroidDatabase,
    context: &VerifiedVocabularyContext,
    detail: &LexemeDetail,
    saved: bool,
) -> Result<ReaderVocabularyState, PlatformError> {
    let device_id = database.device_id().to_owned();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    ensure_lexeme(&transaction, detail, &device_id)?;
    set_saved_context(
        &transaction,
        context,
        &detail.summary.lexeme_key,
        saved,
        &device_id,
    )?;
    transaction.commit().map_err(database_error)?;
    state(database, context, &detail.summary.lexeme_key)
}

pub fn remove_favorite(
    database: &mut AndroidDatabase,
    lexeme_key: &str,
) -> Result<(), PlatformError> {
    let device_id = database.device_id().to_owned();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM user_lexemes WHERE lexeme_key=?1",
            [lexeme_key],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error)?
        .is_some();
    if exists {
        set_manual_source(&transaction, lexeme_key, false, &device_id)?;
    }
    transaction.commit().map_err(database_error)
}

pub fn list_favorites(
    database: &AndroidDatabase,
    query: VocabularyListQuery,
) -> Result<VocabularyListPage, PlatformError> {
    let limit = query.limit.clamp(1, 50);
    let offset = query.offset.max(0);
    let text = query.text.nfkc().collect::<String>().trim().to_lowercase();
    let pattern = format!("%{}%", escape_like(&text));
    let meaning_pattern = format!("%{text}%");
    let connection = database.connection();
    let (total, rows) = if text.is_empty() {
        let total = connection.query_row(
            "SELECT COUNT(DISTINCT u.lexeme_key) FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1",
            [], |row| row.get(0),
        ).map_err(database_error)?;
        let mut statement = connection.prepare(
            "SELECT u.lexeme_key,u.lemma_snapshot,u.phonetic_snapshot,u.brief_meanings_json,u.manual_state,s.added_at FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1 ORDER BY s.added_at DESC LIMIT ?1 OFFSET ?2",
        ).map_err(database_error)?;
        let rows = statement
            .query_map(params![limit, offset], map_vocabulary_item)
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        (total, rows)
    } else {
        let total = connection.query_row(
            "SELECT COUNT(DISTINCT u.lexeme_key) FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1 AND (lower(u.lemma_snapshot) LIKE ?1 ESCAPE '\\' OR u.brief_meanings_json LIKE ?2)",
            params![pattern, meaning_pattern], |row| row.get(0),
        ).map_err(database_error)?;
        let mut statement = connection.prepare(
            "SELECT u.lexeme_key,u.lemma_snapshot,u.phonetic_snapshot,u.brief_meanings_json,u.manual_state,s.added_at FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1 AND (lower(u.lemma_snapshot) LIKE ?1 ESCAPE '\\' OR u.brief_meanings_json LIKE ?2) ORDER BY s.added_at DESC LIMIT ?3 OFFSET ?4",
        ).map_err(database_error)?;
        let rows = statement
            .query_map(
                params![pattern, meaning_pattern, limit, offset],
                map_vocabulary_item,
            )
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        (total, rows)
    };
    Ok(VocabularyListPage {
        items: rows,
        offset,
        limit,
        total,
    })
}

pub fn list_contexts(
    database: &AndroidDatabase,
    lexeme_key: &str,
    offset: i64,
) -> Result<SavedContextPage, PlatformError> {
    let offset = offset.max(0);
    let limit = 50;
    let connection = database.connection();
    let total = connection
        .query_row(
            "SELECT COUNT(*) FROM saved_contexts WHERE lexeme_key=?1 AND active=1",
            [lexeme_key],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    let mut statement = connection.prepare(
        "SELECT context_id,publication_id,publication_title_snapshot,article_id,article_title_snapshot,sentence_snapshot,surface,paragraph_snapshot,saved_at FROM saved_contexts WHERE lexeme_key=?1 AND active=1 ORDER BY saved_at DESC LIMIT ?2 OFFSET ?3",
    ).map_err(database_error)?;
    let items = statement
        .query_map(params![lexeme_key, limit, offset], |row| {
            Ok(SavedContextItem {
                context_id: row.get(0)?,
                publication_id: row.get(1)?,
                publication_title: row.get(2)?,
                article_id: row.get(3)?,
                article_title: row.get(4)?,
                sentence: row.get(5)?,
                surface: row.get(6)?,
                paragraph: row.get(7)?,
                saved_at: row.get(8)?,
            })
        })
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?;
    Ok(SavedContextPage {
        items,
        offset,
        limit,
        total,
    })
}

fn state(
    database: &AndroidDatabase,
    context: &VerifiedVocabularyContext,
    lexeme_key: &str,
) -> Result<ReaderVocabularyState, PlatformError> {
    let connection = database.connection();
    let manual_state = connection
        .query_row(
            "SELECT manual_state FROM user_lexemes WHERE lexeme_key=?1",
            [lexeme_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?
        .unwrap_or_else(|| "unrated".into());
    let favorite = connection.query_row(
        "SELECT 1 FROM vocabulary_sources WHERE lexeme_key=?1 AND source_type='reader_manual' AND source_ref='favorite' AND active=1", [lexeme_key], |_| Ok(()),
    ).optional().map_err(database_error)?.is_some();
    let id = context_identity(context, lexeme_key);
    let context_saved = connection
        .query_row(
            "SELECT 1 FROM saved_contexts WHERE context_id=?1 AND active=1",
            [id],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error)?
        .is_some();
    Ok(ReaderVocabularyState {
        lexeme_key: lexeme_key.into(),
        favorite,
        context_saved,
        manual_state,
    })
}

fn ensure_lexeme(
    transaction: &rusqlite::Transaction<'_>,
    detail: &LexemeDetail,
    device_id: &str,
) -> Result<(), PlatformError> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let meanings = serde_json::to_string(&detail.summary.brief_meanings)
        .map_err(|_| database_error(rusqlite::Error::InvalidQuery))?;
    let senses = detail
        .entries
        .iter()
        .flat_map(|entry| entry.senses.iter())
        .collect::<Vec<_>>();
    let senses = serde_json::to_string(&senses)
        .map_err(|_| database_error(rusqlite::Error::InvalidQuery))?;
    transaction.execute(
        "INSERT INTO user_lexemes(lexeme_key,lemma_snapshot,phonetic_snapshot,brief_meanings_json,sense_groups_json,bnc_rank,frequency_rank,manual_state,manual_familiarity,created_at,updated_at,device_id,snapshot_provider,snapshot_quality) VALUES(?1,?2,?3,?4,?5,?6,?7,'unrated',NULL,?8,?8,?9,'ecdict',10) ON CONFLICT(lexeme_key) DO UPDATE SET lemma_snapshot=excluded.lemma_snapshot,phonetic_snapshot=COALESCE(excluded.phonetic_snapshot,user_lexemes.phonetic_snapshot),brief_meanings_json=CASE WHEN excluded.brief_meanings_json!='[]' THEN excluded.brief_meanings_json ELSE user_lexemes.brief_meanings_json END,sense_groups_json=CASE WHEN excluded.sense_groups_json!='[]' THEN excluded.sense_groups_json ELSE user_lexemes.sense_groups_json END,bnc_rank=COALESCE(user_lexemes.bnc_rank,excluded.bnc_rank),frequency_rank=COALESCE(user_lexemes.frequency_rank,excluded.frequency_rank),updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![detail.summary.lexeme_key, detail.summary.lemma, detail.summary.phonetic, meanings, senses, detail.summary.frequency.bnc, detail.summary.frequency.contemporary, now, device_id],
    ).map_err(database_error)?;
    Ok(())
}

fn set_manual_source(
    transaction: &rusqlite::Transaction<'_>,
    lexeme_key: &str,
    active: bool,
    device_id: &str,
) -> Result<(), PlatformError> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let source_id = stable_identity(&[lexeme_key, "reader_manual", "favorite"]);
    transaction.execute(
        "INSERT INTO vocabulary_sources(source_id,lexeme_key,source_type,source_ref,active,added_at,removed_at,updated_at,device_id) VALUES(?1,?2,'reader_manual','favorite',?3,?4,?5,?4,?6) ON CONFLICT(source_id) DO UPDATE SET active=excluded.active,removed_at=excluded.removed_at,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![source_id, lexeme_key, i64::from(active), now, if active { None::<String> } else { Some(now.clone()) }, device_id],
    ).map_err(database_error)?;
    Ok(())
}

fn set_saved_context(
    transaction: &rusqlite::Transaction<'_>,
    context: &VerifiedVocabularyContext,
    lexeme_key: &str,
    active: bool,
    device_id: &str,
) -> Result<(), PlatformError> {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let sentence_hash = hex::encode(Sha256::digest(context.sentence.as_bytes()));
    let context_id = context_identity(context, lexeme_key);
    transaction.execute(
        "INSERT INTO saved_contexts(context_id,lexeme_key,surface,publication_id,publication_title_snapshot,article_id,article_title_snapshot,block_id,token_index,sentence_snapshot,paragraph_snapshot,sentence_hash,active,saved_at,removed_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?14,?16) ON CONFLICT(context_id) DO UPDATE SET surface=excluded.surface,publication_id=excluded.publication_id,publication_title_snapshot=excluded.publication_title_snapshot,article_id=excluded.article_id,article_title_snapshot=excluded.article_title_snapshot,block_id=excluded.block_id,token_index=excluded.token_index,sentence_snapshot=excluded.sentence_snapshot,paragraph_snapshot=excluded.paragraph_snapshot,sentence_hash=excluded.sentence_hash,active=excluded.active,removed_at=excluded.removed_at,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![context_id, lexeme_key, context.surface, context.publication_id, context.publication_title, context.article_id, context.article_title, context.block_id, context.token_index, context.sentence, context.paragraph, sentence_hash, i64::from(active), now, if active { None::<String> } else { Some(now.clone()) }, device_id],
    ).map_err(database_error)?;
    Ok(())
}

fn context_identity(context: &VerifiedVocabularyContext, lexeme_key: &str) -> String {
    let sentence_hash = hex::encode(Sha256::digest(context.sentence.as_bytes()));
    stable_identity(&[
        lexeme_key,
        &context.publication_id,
        &context.article_id,
        &context.block_id,
        &context.token_index.to_string(),
        &sentence_hash,
    ])
}

fn map_vocabulary_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabularyListItem> {
    let raw: String = row.get(3)?;
    Ok(VocabularyListItem {
        lexeme_key: row.get(0)?,
        lemma: row.get(1)?,
        phonetic: row.get(2)?,
        brief_meanings: serde_json::from_str(&raw).unwrap_or_default(),
        manual_state: row.get(4)?,
        added_at: row.get(5)?,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
fn database_error(_: rusqlite::Error) -> PlatformError {
    PlatformError::new(
        "learningDatabaseUnavailable",
        "学习数据库暂时不可用。",
        true,
    )
}

use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        dictionary_query::{DictionaryFrequency, DictionarySearchItem},
        platform_paths::PlatformPaths,
    };

    fn detail() -> LexemeDetail {
        LexemeDetail {
            summary: DictionarySearchItem {
                lexeme_key: "lex_en_bef0f93b22ad080a29e3aa86".into(),
                lemma: "run".into(),
                phonetic: Some("rʌn".into()),
                brief_meanings: vec!["跑；运行".into()],
                tags: vec![],
                collins: None,
                oxford: false,
                frequency: DictionaryFrequency {
                    bnc: Some(120),
                    contemporary: Some(90),
                },
                matched_by: "lemma",
            },
            entries: vec![],
            forms: vec!["running".into()],
            collections: vec![],
            provider_id: "ecdict",
            examples: vec![],
            similar_words: vec![],
        }
    }

    fn context() -> VerifiedVocabularyContext {
        VerifiedVocabularyContext {
            publication_id: "publication".into(),
            publication_title: "Weekly".into(),
            article_id: "article".into(),
            article_title: "Running".into(),
            block_id: "block".into(),
            token_index: 0,
            surface: "Running".into(),
            sentence: "Running is useful.".into(),
            paragraph: "Running is useful. It is simple.".into(),
        }
    }

    fn database() -> (tempfile::TempDir, AndroidDatabase) {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        let database = AndroidDatabase::open(&paths, "test").expect("database");
        database.connection().execute_batch(
            "INSERT INTO publications VALUES('publication','hash','source','generic','Weekly',NULL,'en',NULL,'source.epub','2026-07-13T00:00:00.000Z',1,0,'retained');\
             INSERT INTO articles VALUES('article','publication',NULL,'article-source','Running',NULL,NULL,0,'article.xhtml');\
             INSERT INTO blocks VALUES('block','article','block-source','paragraph',0,'Running is useful. It is simple.',NULL,NULL,NULL);",
        ).expect("fixture");
        (root, database)
    }

    #[test]
    fn favorites_contexts_and_tombstones_are_idempotent() {
        let (_root, mut database) = database();
        let detail = detail();
        let context = context();
        let first = set_favorite(&mut database, &context, &detail, true).expect("favorite");
        assert!(first.favorite && first.context_saved);
        set_favorite(&mut database, &context, &detail, true).expect("repeat");
        assert_eq!(
            list_favorites(
                &database,
                VocabularyListQuery {
                    text: String::new(),
                    offset: 0,
                    limit: 50
                }
            )
            .expect("list")
            .total,
            1
        );
        assert_eq!(
            list_contexts(&database, &detail.summary.lexeme_key, 0)
                .expect("contexts")
                .total,
            1
        );

        set_context_saved(&mut database, &context, &detail, false).expect("remove context");
        remove_favorite(&mut database, &detail.summary.lexeme_key).expect("remove favorite");
        remove_favorite(&mut database, &detail.summary.lexeme_key).expect("repeat removal");
        let source: (i64, Option<String>) = database
            .connection()
            .query_row(
                "SELECT active,removed_at FROM vocabulary_sources WHERE lexeme_key=?1",
                [&detail.summary.lexeme_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("source");
        let saved: (i64, Option<String>) = database
            .connection()
            .query_row(
                "SELECT active,removed_at FROM saved_contexts WHERE lexeme_key=?1",
                [&detail.summary.lexeme_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("context");
        assert_eq!(source.0, 0);
        assert!(source.1.is_some());
        assert_eq!(saved.0, 0);
        assert!(saved.1.is_some());
    }

    #[test]
    fn snapshots_survive_publication_and_dictionary_removal() {
        let (_root, mut database) = database();
        let detail = detail();
        let context = context();
        set_favorite(&mut database, &context, &detail, true).expect("favorite");
        database
            .connection()
            .execute("DELETE FROM publications WHERE id='publication'", [])
            .expect("delete publication");
        let page = list_favorites(
            &database,
            VocabularyListQuery {
                text: "跑".into(),
                offset: 0,
                limit: 50,
            },
        )
        .expect("favorites");
        let contexts = list_contexts(&database, &detail.summary.lexeme_key, 0).expect("contexts");
        assert_eq!(page.items[0].lemma, "run");
        assert_eq!(contexts.items[0].publication_id, None);
        assert_eq!(contexts.items[0].publication_title, "Weekly");
        assert_eq!(contexts.items[0].sentence, "Running is useful.");
    }

    #[test]
    fn matches_the_shared_d2_identity_vector() {
        let value: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/d2-vocabulary.json"))
                .expect("vector");
        let context = VerifiedVocabularyContext {
            publication_id: value["publicationId"].as_str().expect("publication").into(),
            publication_title: "Weekly".into(),
            article_id: value["articleId"].as_str().expect("article").into(),
            article_title: "Running".into(),
            block_id: value["blockId"].as_str().expect("block").into(),
            token_index: value["tokenIndex"].as_i64().expect("token"),
            surface: "Running".into(),
            sentence: value["sentence"].as_str().expect("sentence").into(),
            paragraph: "Running is useful.".into(),
        };
        let key = value["lexemeKey"].as_str().expect("key");
        assert_eq!(
            stable_identity(&[key, "reader_manual", "favorite"]),
            value["sourceId"].as_str().expect("source")
        );
        assert_eq!(
            context_identity(&context, key),
            value["contextId"].as_str().expect("context")
        );
    }
}
