use crate::{database::AndroidDatabase, mobile_online, platform_error::PlatformError};
use chrono::Utc;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedPublicationPlan {
    pub id: String,
    pub hash: String,
    pub source_key: String,
    pub profile_id: String,
    pub title: String,
    pub creator: Option<String>,
    pub language: Option<String>,
    pub cover_path: Option<String>,
    pub sections: Vec<ParsedSection>,
    pub unsectioned_articles: Vec<ParsedArticle>,
    pub asset_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedSection {
    pub id: String,
    pub source_key: String,
    pub title: String,
    pub position: i64,
    pub articles: Vec<ParsedArticle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedArticle {
    pub id: String,
    pub source_key: String,
    pub title: String,
    pub rubric: Option<String>,
    pub published_at: Option<String>,
    pub position: i64,
    pub source_href: String,
    pub blocks: Vec<ParsedBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedBlock {
    pub id: String,
    pub source_key: String,
    #[serde(rename = "type")]
    pub block_type: String,
    pub position: i64,
    pub text: Option<String>,
    pub html: Option<String>,
    pub asset_path: Option<String>,
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationSummary {
    pub id: String,
    pub title: String,
    pub original_title: String,
    pub category_id: Option<String>,
    pub creator: Option<String>,
    pub language: Option<String>,
    pub cover_url: Option<String>,
    pub cover_thumbnail_url: Option<String>,
    pub cover_thumbnail_width: Option<u32>,
    pub cover_thumbnail_height: Option<u32>,
    pub imported_at: String,
    pub article_count: i64,
    pub section_count: i64,
    pub last_article_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCategory {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryPreferences {
    pub view_mode: String,
    pub sort_by: String,
    pub sort_direction: String,
    pub active_category_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryState {
    pub publications: Vec<PublicationSummary>,
    pub categories: Vec<LibraryCategory>,
    pub preferences: LibraryPreferences,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItemManagement {
    custom_title: Option<String>,
    category_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryManagementRecord {
    view_mode: String,
    sort_by: String,
    sort_direction: String,
    active_category_id: String,
    categories: Vec<LibraryCategory>,
    items: BTreeMap<String, LibraryItemManagement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationDetail {
    #[serde(flatten)]
    pub summary: PublicationSummary,
    pub sections: Vec<SectionSummary>,
    pub unsectioned_articles: Vec<ArticleSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSummary {
    pub id: String,
    pub title: String,
    pub position: i64,
    pub articles: Vec<ArticleSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
    pub id: String,
    pub section_id: Option<String>,
    pub title: String,
    pub rubric: Option<String>,
    pub published_at: Option<String>,
    pub position: i64,
    pub block_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleDetail {
    #[serde(flatten)]
    pub summary: ArticleSummary,
    pub publication_id: String,
    pub publication_title: String,
    pub section_title: Option<String>,
    pub blocks: Vec<ContentBlock>,
    pub saved_position: ReadingPosition,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    pub id: String,
    #[serde(rename = "type")]
    pub block_type: String,
    pub position: i64,
    pub text: Option<String>,
    pub html: Option<String>,
    pub asset_url: Option<String>,
    pub alt: Option<String>,
    pub translation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingPosition {
    pub scroll_top: f64,
    pub anchor_block_id: Option<String>,
    pub anchor_token_index: Option<i64>,
    pub anchor_fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderPreferences {
    pub theme: String,
    pub font_size: f64,
    pub line_height: f64,
    pub column_width: f64,
    pub paper_tint: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub repaired: bool,
    pub publication: PublicationDetail,
    pub duplicate: bool,
}

pub fn list_publications(
    database: &AndroidDatabase,
) -> Result<Vec<PublicationSummary>, PlatformError> {
    let connection = database.connection();
    let management = load_library_management(connection)?;
    list_publications_with_management(connection, &management)
}

fn list_publications_with_management(
    connection: &Connection,
    management: &LibraryManagementRecord,
) -> Result<Vec<PublicationSummary>, PlatformError> {
    let mut statement = connection
        .prepare(
            "SELECT p.id,p.title,p.creator,p.language,p.cover_path,\
             min(p.imported_at,COALESCE(l.changed_at,p.imported_at)),p.article_count,p.section_count,rp.article_id,p.hash \
             FROM publications p LEFT JOIN publication_lifecycle l ON l.publication_id=p.id AND l.state='present' \
             LEFT JOIN reading_positions rp ON rp.publication_id=p.id ORDER BY min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) DESC",
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let original_title: String = row.get(1)?;
            let cover: Option<String> = row.get(4)?;
            let content_hash: String = row.get(9)?;
            let item = management.items.get(&id);
            Ok(PublicationSummary {
                id: id.clone(),
                title: item
                    .and_then(|value| value.custom_title.clone())
                    .unwrap_or_else(|| original_title.clone()),
                original_title,
                category_id: item.and_then(|value| value.category_id.clone()),
                creator: row.get(2)?,
                language: row.get(3)?,
                cover_url: cover.as_ref().map(|path| asset_url(&id, path)),
                cover_thumbnail_url: cover
                    .as_ref()
                    .map(|_| crate::cover_thumbnail::url(&id, &content_hash)),
                cover_thumbnail_width: None,
                cover_thumbnail_height: None,
                imported_at: row.get(5)?,
                article_count: row.get(6)?,
                section_count: row.get(7)?,
                last_article_id: row.get(8)?,
            })
        })
        .map_err(|_| PlatformError::database_corrupt())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())
}

pub fn get_library_state(database: &AndroidDatabase) -> Result<LibraryState, PlatformError> {
    let management = load_library_management(database.connection())?;
    Ok(LibraryState {
        publications: list_publications_with_management(database.connection(), &management)?,
        categories: management.categories.clone(),
        preferences: library_preferences_of(&management),
    })
}

pub fn save_library_preferences(
    database: &AndroidDatabase,
    preferences: LibraryPreferences,
) -> Result<LibraryState, PlatformError> {
    let mut management = load_library_management(database.connection())?;
    management.view_mode = if preferences.view_mode == "list" {
        "list".into()
    } else {
        "grid".into()
    };
    management.sort_by = if preferences.sort_by == "name" {
        "name".into()
    } else {
        "importedAt".into()
    };
    management.sort_direction = if preferences.sort_direction == "asc" {
        "asc".into()
    } else {
        "desc".into()
    };
    management.active_category_id = normalize_active_category(
        Some(preferences.active_category_id.as_str()),
        &management.categories,
    );
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn create_category(
    database: &AndroidDatabase,
    name: &str,
) -> Result<LibraryState, PlatformError> {
    let mut management = load_library_management(database.connection())?;
    let name = require_library_name(name, "分类名称不能为空。")?;
    ensure_unique_category_name(&management.categories, &name, None)?;
    management.categories.push(LibraryCategory {
        id: format!("category_{}", uuid::Uuid::new_v4().simple()),
        name,
        created_at: now(),
    });
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn rename_category(
    database: &AndroidDatabase,
    category_id: &str,
    name: &str,
) -> Result<LibraryState, PlatformError> {
    let mut management = load_library_management(database.connection())?;
    if !management
        .categories
        .iter()
        .any(|category| category.id == category_id)
    {
        return Err(category_not_found());
    }
    let name = require_library_name(name, "分类名称不能为空。")?;
    ensure_unique_category_name(&management.categories, &name, Some(category_id))?;
    if let Some(category) = management
        .categories
        .iter_mut()
        .find(|category| category.id == category_id)
    {
        category.name = name;
    }
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn delete_category(
    database: &AndroidDatabase,
    category_id: &str,
) -> Result<LibraryState, PlatformError> {
    let mut management = load_library_management(database.connection())?;
    if !management
        .categories
        .iter()
        .any(|category| category.id == category_id)
    {
        return Err(category_not_found());
    }
    management
        .categories
        .retain(|category| category.id != category_id);
    for item in management.items.values_mut() {
        if item.category_id.as_deref() == Some(category_id) {
            item.category_id = None;
        }
    }
    prune_empty_library_items(&mut management.items);
    if management.active_category_id == category_id {
        management.active_category_id = "all".into();
    }
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn rename_publication(
    database: &AndroidDatabase,
    publication_id: &str,
    title: &str,
) -> Result<LibraryState, PlatformError> {
    let original_title = database
        .connection()
        .query_row(
            "SELECT title FROM publications WHERE id=?1",
            [publication_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .ok_or_else(publication_not_found)?;
    let title = require_library_name_with_limit(title, 200, "书名不能为空。")?;
    let mut management = load_library_management(database.connection())?;
    let item = management
        .items
        .entry(publication_id.to_string())
        .or_insert(LibraryItemManagement {
            custom_title: None,
            category_id: None,
        });
    item.custom_title = (title != original_title).then_some(title);
    prune_empty_library_items(&mut management.items);
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn assign_publications(
    database: &AndroidDatabase,
    publication_ids: Vec<String>,
    category_id: Option<String>,
) -> Result<LibraryState, PlatformError> {
    let unique = validate_publication_selection(publication_ids)?;
    let mut management = load_library_management(database.connection())?;
    if let Some(category_id) = category_id.as_deref() {
        if !management
            .categories
            .iter()
            .any(|category| category.id == category_id)
        {
            return Err(category_not_found());
        }
    }
    let mut exists = database
        .connection()
        .prepare("SELECT EXISTS(SELECT 1 FROM publications WHERE id=?1)")
        .map_err(|_| PlatformError::database_corrupt())?;
    for publication_id in &unique {
        let present: bool = exists
            .query_row([publication_id], |row| row.get(0))
            .map_err(|_| PlatformError::database_corrupt())?;
        if !present {
            return Err(PlatformError::new(
                "publicationNotFound",
                "选择中包含不存在的刊物。",
                false,
            ));
        }
    }
    drop(exists);
    for publication_id in unique {
        let item = management
            .items
            .entry(publication_id)
            .or_insert(LibraryItemManagement {
                custom_title: None,
                category_id: None,
            });
        item.category_id = category_id.clone();
    }
    prune_empty_library_items(&mut management.items);
    write_library_management(database.connection(), database.device_id(), &management)?;
    get_library_state(database)
}

pub fn delete_publications(
    database: &mut AndroidDatabase,
    library_root: &Path,
    publication_ids: Vec<String>,
) -> Result<LibraryState, PlatformError> {
    let unique = validate_publication_selection(publication_ids)?;
    let device_id = database.device_id().to_string();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut management = load_library_management(&transaction)?;
    let changed_at = now();
    for publication_id in &unique {
        let publication = transaction
            .query_row(
                "SELECT hash,title FROM publications WHERE id=?1",
                [publication_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| PlatformError::database_corrupt())?;
        let Some((content_hash, title)) = publication else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO publication_lifecycle(publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id) \
                 VALUES(?1,?2,COALESCE((SELECT format_id FROM publication_lifecycle WHERE publication_id=?1),'epub'),?3,'deleted',?4,?5) \
                 ON CONFLICT(publication_id) DO UPDATE SET content_hash=excluded.content_hash,title_snapshot=excluded.title_snapshot,\
                 state='deleted',changed_at=excluded.changed_at,device_id=excluded.device_id",
                params![publication_id, content_hash, title, changed_at, device_id],
            )
            .map_err(|_| PlatformError::storage_unavailable())?;
        transaction
            .execute("DELETE FROM publications WHERE id=?1", [publication_id])
            .map_err(|_| PlatformError::storage_unavailable())?;
        management.items.remove(publication_id);
    }
    write_library_management(&transaction, &device_id, &management)?;
    transaction
        .commit()
        .map_err(|_| PlatformError::storage_unavailable())?;

    let mut cleanup_failed = false;
    for publication_id in &unique {
        let path = library_root.join(publication_id);
        if path.exists() && fs::remove_dir_all(path).is_err() {
            cleanup_failed = true;
        }
    }
    if cleanup_failed {
        return Err(PlatformError::new(
            "libraryCleanupDeferred",
            "刊物已从书库移除；本地文件将在下次启动时继续清理。",
            true,
        ));
    }
    get_library_state(database)
}

pub fn find_publication_by_hash(
    database: &AndroidDatabase,
    hash: &str,
) -> Result<Option<String>, PlatformError> {
    database
        .connection()
        .query_row("SELECT id FROM publications WHERE hash=?1", [hash], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| PlatformError::database_corrupt())
}

pub fn dictionary_lookup_context(
    database: &AndroidDatabase,
    request: &crate::dictionary_query::DictionaryLookupRequest,
) -> Result<crate::dictionary_query::DictionaryLookupContext, PlatformError> {
    let text = database
        .connection()
        .query_row(
            "SELECT b.text FROM blocks b WHERE b.id=?1 AND b.article_id=?2",
            params![request.block_id, request.article_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .flatten()
        .ok_or_else(|| PlatformError::new("invalidInput", "阅读器查词内容不存在。", false))?;
    crate::dictionary_query::resolve_context(&text, &request.surface, request.token_index)
}

pub fn get_publication(
    database: &AndroidDatabase,
    id: &str,
) -> Result<PublicationDetail, PlatformError> {
    let summary = list_publications(database)?
        .into_iter()
        .find(|publication| publication.id == id)
        .ok_or_else(|| PlatformError::new("publicationNotFound", "未找到该刊物。", false))?;
    let connection = database.connection();
    let mut article_statement = connection
        .prepare(
            "SELECT a.id,a.section_id,a.title,a.rubric,a.published_at,a.position,COUNT(b.id) \
             FROM articles a LEFT JOIN blocks b ON b.article_id=a.id WHERE a.publication_id=?1 \
             GROUP BY a.id ORDER BY a.position",
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    let articles = article_statement
        .query_map([id], |row| {
            Ok(ArticleSummary {
                id: row.get(0)?,
                section_id: row.get(1)?,
                title: row.get(2)?,
                rubric: row.get(3)?,
                published_at: row.get(4)?,
                position: row.get(5)?,
                block_count: row.get(6)?,
            })
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut section_statement = connection
        .prepare("SELECT id,title,position FROM sections WHERE publication_id=?1 ORDER BY position")
        .map_err(|_| PlatformError::database_corrupt())?;
    let sections = section_statement
        .query_map([id], |row| {
            let section_id: String = row.get(0)?;
            Ok(SectionSummary {
                id: section_id.clone(),
                title: row.get(1)?,
                position: row.get(2)?,
                articles: articles
                    .iter()
                    .filter(|article| article.section_id.as_deref() == Some(section_id.as_str()))
                    .cloned()
                    .collect(),
            })
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(PublicationDetail {
        summary,
        sections,
        unsectioned_articles: articles
            .into_iter()
            .filter(|article| article.section_id.is_none())
            .collect(),
    })
}

pub fn get_article(database: &AndroidDatabase, id: &str) -> Result<ArticleDetail, PlatformError> {
    let selected = crate::reader_records::selected(database, id)?;
    let connection = database.connection();
    let management = load_library_management(connection)?;
    let translation_preferences = mobile_online::get_preferences(database)?;
    let cache_model = mobile_online::cache_model(&translation_preferences)?;
    let row = connection
        .query_row(
            "SELECT a.id,a.section_id,a.title,a.rubric,a.published_at,a.position,a.publication_id,p.title,s.title,\
             rp.scroll_top,rp.anchor_block_id,rp.anchor_token_index,rp.anchor_fraction \
             FROM articles a JOIN publications p ON p.id=a.publication_id LEFT JOIN sections s ON s.id=a.section_id \
             LEFT JOIN reading_positions rp ON rp.publication_id=a.publication_id AND rp.article_id=a.id WHERE a.id=?1",
            [id],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<f64>>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<f64>>(12)?,
            )),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?
        .ok_or_else(|| PlatformError::new("articleNotFound", "未找到该文章。", false))?;
    let mut block_statement = connection
        .prepare(
            "SELECT b.id,b.type,b.position,b.text,b.html,b.asset_path,b.alt \
             FROM blocks b WHERE b.article_id=?1 ORDER BY b.position",
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut translation_statement = connection.prepare(
        "SELECT text FROM translations WHERE block_id=?1 AND source_hash=?2 AND target_language='zh-CN' ORDER BY (model=?3 AND prompt_version=?4) DESC,created_at DESC LIMIT 1",
    ).map_err(|_| PlatformError::database_corrupt())?;
    let blocks = block_statement
        .query_map([id], |block| {
            let asset_path: Option<String> = block.get(5)?;
            let text: Option<String> = block.get(3)?;
            let translation = if let Some(value) = text.as_deref() {
                translation_statement
                    .query_row(
                        params![
                            block.get::<_, String>(0)?,
                            hex::encode(Sha256::digest(value.as_bytes())),
                            cache_model.as_str(),
                            mobile_online::TRANSLATION_PROMPT_VERSION
                        ],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            } else {
                None
            };
            let translation = if let Some(segments) = &selected {
                let block_id: String = block.get(0)?;
                let hash = hex::encode(Sha256::digest(
                    text.as_deref().unwrap_or_default().as_bytes(),
                ));
                segments
                    .get(&block_id)
                    .filter(|segment| segment["sourceHash"].as_str() == Some(hash.as_str()))
                    .and_then(|segment| segment["text"].as_str().map(str::to_owned))
            } else {
                translation
            };
            Ok(ContentBlock {
                id: block.get(0)?,
                block_type: block.get(1)?,
                position: block.get(2)?,
                text,
                html: block.get(4)?,
                asset_url: asset_path.map(|path| asset_url(&row.6, &path)),
                alt: block.get(6)?,
                translation,
            })
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let publication_title = management
        .items
        .get(&row.6)
        .and_then(|value| value.custom_title.clone())
        .unwrap_or(row.7);
    Ok(ArticleDetail {
        summary: ArticleSummary {
            id: row.0,
            section_id: row.1,
            title: row.2,
            rubric: row.3,
            published_at: row.4,
            position: row.5,
            block_count: blocks.len() as i64,
        },
        publication_id: row.6,
        publication_title,
        section_title: row.8,
        blocks,
        saved_position: crate::reader_records::position(database, id)?.unwrap_or(ReadingPosition {
            scroll_top: row.9.unwrap_or(0.0),
            anchor_block_id: row.10,
            anchor_token_index: row.11,
            anchor_fraction: row.12.unwrap_or(0.0),
        }),
    })
}

pub fn get_preferences(database: &AndroidDatabase) -> Result<ReaderPreferences, PlatformError> {
    let value = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='reader.preferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(value
        .and_then(|json| serde_json::from_str(&json).ok())
        .map(normalize_preferences)
        .unwrap_or_else(default_preferences))
}

pub fn save_preferences(
    database: &AndroidDatabase,
    preferences: ReaderPreferences,
) -> Result<ReaderPreferences, PlatformError> {
    let value = normalize_preferences(preferences);
    let encoded =
        serde_json::to_string(&value).map_err(|_| PlatformError::storage_unavailable())?;
    database
        .connection()
        .execute(
            "INSERT INTO settings(key,value,updated_at,device_id) VALUES('reader.preferences',?1,?2,?3) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
            params![encoded, now(), database.device_id()],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(value)
}

pub fn save_position(
    database: &AndroidDatabase,
    publication_id: &str,
    article_id: &str,
    position: ReadingPosition,
) -> Result<(), PlatformError> {
    validate_id(publication_id, "刊物")?;
    validate_id(article_id, "文章")?;
    let belongs: bool = database
        .connection()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM articles WHERE id=?1 AND publication_id=?2)",
            params![article_id, publication_id],
            |row| row.get(0),
        )
        .map_err(|_| PlatformError::database_corrupt())?;
    if !belongs {
        return Err(PlatformError::new(
            "articleNotFound",
            "未找到该文章。",
            false,
        ));
    }
    let scroll_top = if position.scroll_top.is_finite() {
        position.scroll_top.max(0.0)
    } else {
        0.0
    };
    let fraction = if position.anchor_fraction.is_finite() {
        position.anchor_fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    database
        .connection()
        .execute(
            "INSERT INTO reading_positions(publication_id,article_id,scroll_top,anchor_block_id,anchor_token_index,anchor_fraction,updated_at,device_id) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(publication_id) DO UPDATE SET article_id=excluded.article_id,\
             scroll_top=excluded.scroll_top,anchor_block_id=excluded.anchor_block_id,anchor_token_index=excluded.anchor_token_index,\
             anchor_fraction=excluded.anchor_fraction,updated_at=excluded.updated_at,device_id=excluded.device_id",
            params![publication_id, article_id, scroll_top, position.anchor_block_id, position.anchor_token_index, fraction, now(), database.device_id()],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}

pub fn commit_publication<F>(
    database: &mut AndroidDatabase,
    parsed: &ParsedPublicationPlan,
    format_id: &str,
    publish: F,
) -> Result<(), PlatformError>
where
    F: FnOnce() -> Result<(), PlatformError>,
{
    commit_publication_at(database, parsed, format_id, None, publish)
}

pub fn commit_publication_at<F>(
    database: &mut AndroidDatabase,
    parsed: &ParsedPublicationPlan,
    format_id: &str,
    first_imported_at: Option<&str>,
    publish: F,
) -> Result<(), PlatformError>
where
    F: FnOnce() -> Result<(), PlatformError>,
{
    validate_plan(parsed)?;
    let imported_at = match first_imported_at {
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|timestamp| {
                timestamp
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .map_err(|_| PlatformError::new("importConflict", "刊物首次导入时间无效。", false))?,
        None => now(),
    };
    let device_id = database.device_id().to_string();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::storage_unavailable())?;
    publish()?;
    let article_count = parsed.unsectioned_articles.len()
        + parsed
            .sections
            .iter()
            .map(|section| section.articles.len())
            .sum::<usize>();
    transaction
        .execute(
            "INSERT INTO publications(id,hash,source_key,profile_id,title,creator,language,cover_path,source_path,imported_at,article_count,section_count,source_storage) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'',?9,?10,?11,'parsed-only')",
            params![parsed.id, parsed.hash, parsed.source_key, parsed.profile_id, parsed.title, parsed.creator,
                parsed.language, parsed.cover_path, imported_at,
                article_count as i64, parsed.sections.len() as i64],
        )
        .map_err(|_| PlatformError::new("importConflict", "刊物身份已存在但内容不同。", false))?;
    for section in &parsed.sections {
        transaction.execute(
            "INSERT INTO sections(id,publication_id,source_key,title,position) VALUES(?1,?2,?3,?4,?5)",
            params![section.id, parsed.id, section.source_key, section.title, section.position],
        ).map_err(|_| PlatformError::storage_unavailable())?;
        for article in &section.articles {
            insert_article(&transaction, &parsed.id, Some(&section.id), article)?;
        }
    }
    for article in &parsed.unsectioned_articles {
        insert_article(&transaction, &parsed.id, None, article)?;
    }
    transaction.execute(
        "INSERT INTO publication_lifecycle(publication_id,content_hash,format_id,title_snapshot,state,changed_at,device_id) \
         VALUES(?1,?2,?3,?4,'present',?5,?6) ON CONFLICT(publication_id) DO UPDATE SET content_hash=excluded.content_hash,\
         format_id=excluded.format_id,title_snapshot=excluded.title_snapshot,state='present',changed_at=excluded.changed_at,device_id=excluded.device_id",
        params![parsed.id, parsed.hash, format_id, parsed.title, imported_at, device_id],
    ).map_err(|_| PlatformError::storage_unavailable())?;
    transaction
        .commit()
        .map_err(|_| PlatformError::storage_unavailable())
}

pub fn clear_publication_lifecycle_for_restore(
    database: &AndroidDatabase,
    publication_id: &str,
) -> Result<(), PlatformError> {
    database
        .connection()
        .execute(
            "DELETE FROM publication_lifecycle WHERE publication_id=?1",
            [publication_id],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}

pub fn purge_imported_publication(
    database: &mut AndroidDatabase,
    library_root: &Path,
    publication_id: &str,
) -> Result<(), PlatformError> {
    validate_id(publication_id, "刊物")?;
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| PlatformError::storage_unavailable())?;
    transaction
        .execute(
            "DELETE FROM publication_lifecycle WHERE publication_id=?1",
            [publication_id],
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    transaction
        .execute("DELETE FROM publications WHERE id=?1", [publication_id])
        .map_err(|_| PlatformError::storage_unavailable())?;
    transaction
        .commit()
        .map_err(|_| PlatformError::storage_unavailable())?;
    let root = library_root.join(publication_id);
    if root.starts_with(library_root) {
        fs::remove_dir_all(root)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    Ok(())
}

pub fn remove_deleted_publication_roots(
    database: &AndroidDatabase,
    library_root: &Path,
) -> Result<(), PlatformError> {
    let mut statement = database
        .connection()
        .prepare("SELECT publication_id FROM publication_lifecycle WHERE state='deleted'")
        .map_err(|_| PlatformError::database_corrupt())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    drop(statement);
    for id in ids {
        validate_id(&id, "刊物")?;
        let root = library_root.join(id);
        if root.starts_with(library_root) {
            let _ = fs::remove_dir_all(root);
        }
    }
    Ok(())
}

fn insert_article(
    transaction: &rusqlite::Transaction<'_>,
    publication_id: &str,
    section_id: Option<&str>,
    article: &ParsedArticle,
) -> Result<(), PlatformError> {
    transaction.execute(
        "INSERT INTO articles(id,publication_id,section_id,source_key,title,rubric,published_at,position,source_href) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![article.id, publication_id, section_id, article.source_key, article.title, article.rubric,
            article.published_at, article.position, article.source_href],
    ).map_err(|_| PlatformError::storage_unavailable())?;
    for block in &article.blocks {
        transaction.execute(
            "INSERT INTO blocks(id,article_id,source_key,type,position,text,html,asset_path,alt) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![block.id, article.id, block.source_key, block.block_type, block.position, block.text,
                block.html, block.asset_path, block.alt],
        ).map_err(|_| PlatformError::storage_unavailable())?;
    }
    Ok(())
}

pub fn resolve_asset(
    database: &AndroidDatabase,
    library_root: &Path,
    publication_id: &str,
    asset_path: &str,
) -> Result<Option<PathBuf>, PlatformError> {
    validate_id(publication_id, "刊物")?;
    validate_archive_path(asset_path)?;
    let referenced: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM publications p WHERE p.id=?1 AND p.cover_path=?2 \
         UNION SELECT 1 FROM blocks b JOIN articles a ON a.id=b.article_id WHERE a.publication_id=?1 AND b.asset_path=?2)",
        params![publication_id, asset_path],
        |row| row.get(0),
    ).map_err(|_| PlatformError::database_corrupt())?;
    if !referenced {
        return Ok(None);
    }
    let root = library_root.join(publication_id).join("assets");
    let candidate = asset_path
        .split('/')
        .fold(root.clone(), |path, segment| path.join(segment));
    if !candidate.starts_with(&root) {
        return Ok(None);
    }
    Ok(candidate.is_file().then_some(candidate))
}

pub fn resolve_cover_asset(
    database: &AndroidDatabase,
    library_root: &Path,
    publication_id: &str,
    expected_content_hash: &str,
) -> Result<Option<PathBuf>, PlatformError> {
    validate_id(publication_id, "刊物")?;
    let record = database
        .connection()
        .query_row(
            "SELECT hash,cover_path FROM publications WHERE id=?1",
            [publication_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    let Some((content_hash, Some(cover_path))) = record else {
        return Ok(None);
    };
    if content_hash != expected_content_hash {
        return Ok(None);
    }
    resolve_asset(database, library_root, publication_id, &cover_path)
}

pub fn cleanup_orphaned_library(
    database: &AndroidDatabase,
    library_root: &Path,
) -> Result<(), PlatformError> {
    if !library_root.exists() {
        return Ok(());
    }
    let mut statement = database
        .connection()
        .prepare("SELECT id FROM publications")
        .map_err(|_| PlatformError::storage_unavailable())?;
    let known = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| PlatformError::storage_unavailable())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|_| PlatformError::storage_unavailable())?;
    for entry in fs::read_dir(library_root).map_err(|_| PlatformError::storage_unavailable())? {
        let entry = entry.map_err(|_| PlatformError::storage_unavailable())?;
        let file_type = entry
            .file_type()
            .map_err(|_| PlatformError::storage_unavailable())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() && is_managed_publication_dir(&name) && !known.contains(&name) {
            fs::remove_dir_all(entry.path()).map_err(|_| PlatformError::storage_unavailable())?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCleanupReport {
    pub removed: usize,
    pub reclaimed_bytes: u64,
    pub skipped: Vec<String>,
}

pub fn remove_retained_publication_sources(
    database: &AndroidDatabase,
    library_root: &Path,
) -> Result<SourceCleanupReport, PlatformError> {
    let candidates = {
        let mut statement = database
            .connection()
            .prepare(
                "SELECT p.id,p.hash,p.source_path,p.article_count,p.section_count, \
             (SELECT COUNT(*) FROM articles a WHERE a.publication_id=p.id), \
             (SELECT COUNT(*) FROM sections s WHERE s.publication_id=p.id) \
             FROM publications p WHERE p.source_storage='retained' ORDER BY p.imported_at",
            )
            .map_err(|_| PlatformError::database_corrupt())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|_| PlatformError::database_corrupt())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlatformError::database_corrupt())?;
        rows
    };
    let mut report = SourceCleanupReport {
        removed: 0,
        reclaimed_bytes: 0,
        skipped: Vec::new(),
    };
    for (
        publication_id,
        content_hash,
        source_path,
        expected_articles,
        expected_sections,
        actual_articles,
        actual_sections,
    ) in candidates
    {
        let validation = (|| -> Result<(PathBuf, Option<u64>), String> {
            if expected_articles != actual_articles
                || expected_sections != actual_sections
                || actual_articles == 0
            {
                return Err("解析内容计数不完整".into());
            }
            let publication_root = library_root.join(&publication_id);
            let expected_source = publication_root.join("source.epub");
            let managed_source = if source_path.is_empty() {
                expected_source.clone()
            } else {
                PathBuf::from(&source_path)
            };
            if managed_source != expected_source {
                return Err("源文件不在受管书库路径内".into());
            }
            let asset_paths = {
                let mut statement = database.connection().prepare(
                    "SELECT cover_path FROM publications WHERE id=?1 AND cover_path IS NOT NULL \
                     UNION SELECT b.asset_path FROM blocks b JOIN articles a ON a.id=b.article_id \
                     WHERE a.publication_id=?1 AND b.asset_path IS NOT NULL",
                ).map_err(|_| "无法校验解析资源".to_string())?;
                let rows = statement
                    .query_map([&publication_id], |row| row.get::<_, String>(0))
                    .map_err(|_| "无法校验解析资源".to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "无法校验解析资源".to_string())?;
                rows
            };
            for asset_path in asset_paths {
                validate_archive_path(&asset_path)
                    .map_err(|_| format!("解析资源路径无效：{asset_path}"))?;
                let asset_root = publication_root.join("assets");
                let asset = asset_path
                    .split('/')
                    .fold(asset_root.clone(), |path, part| path.join(part));
                if !asset.starts_with(&asset_root) || !asset.is_file() {
                    return Err(format!("解析资源不可用：{asset_path}"));
                }
            }
            if !managed_source.exists() {
                return Ok((managed_source, None));
            }
            let metadata =
                fs::metadata(&managed_source).map_err(|_| "无法读取受管源文件".to_string())?;
            if !metadata.is_file()
                || hash_file(&managed_source).map_err(|_| "无法校验受管源文件".to_string())?
                    != content_hash
            {
                return Err("受管源文件校验失败".into());
            }
            Ok((managed_source, Some(metadata.len())))
        })();
        match validation {
            Ok((source, size)) => {
                if let Some(size) = size {
                    if fs::remove_file(&source).is_err() {
                        report
                            .skipped
                            .push(format!("{publication_id}: 无法删除受管源文件"));
                        continue;
                    }
                    report.removed += 1;
                    report.reclaimed_bytes += size;
                }
                database.connection().execute(
                    "UPDATE publications SET source_path='',source_storage='parsed-only' WHERE id=?1 AND source_storage='retained'",
                    [&publication_id],
                ).map_err(|_| PlatformError::storage_unavailable())?;
            }
            Err(reason) => report.skipped.push(format!("{publication_id}: {reason}")),
        }
    }
    Ok(report)
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut input = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn is_managed_publication_dir(value: &str) -> bool {
    value.len() == 28
        && value.starts_with("pub_")
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn validate_archive_path(value: &str) -> Result<(), PlatformError> {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(PlatformError::new(
            "invalidArchive",
            "EPUB 包含无效文件路径。",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn validate_plan(parsed: &ParsedPublicationPlan) -> Result<(), PlatformError> {
    validate_id(&parsed.id, "刊物")?;
    if !parsed.id.starts_with("pub_")
        || !is_hash(&parsed.hash, 64)
        || parsed.title.trim().is_empty()
        || parsed.title.len() > 500
    {
        return Err(PlatformError::new(
            "invalidImportPlan",
            "EPUB 解析结果无效。",
            false,
        ));
    }
    let mut ids = std::collections::HashSet::new();
    ids.insert(parsed.id.as_str());
    for section in &parsed.sections {
        validate_id(&section.id, "栏目")?;
        if !ids.insert(section.id.as_str()) {
            return Err(invalid_plan());
        }
        for article in &section.articles {
            validate_article(article, &mut ids)?;
        }
    }
    for article in &parsed.unsectioned_articles {
        validate_article(article, &mut ids)?;
    }
    for path in &parsed.asset_paths {
        validate_archive_path(path)?;
    }
    if let Some(path) = &parsed.cover_path {
        validate_archive_path(path)?;
    }
    Ok(())
}

fn validate_article<'a>(
    article: &'a ParsedArticle,
    ids: &mut std::collections::HashSet<&'a str>,
) -> Result<(), PlatformError> {
    validate_id(&article.id, "文章")?;
    if !ids.insert(article.id.as_str()) || article.title.trim().is_empty() {
        return Err(invalid_plan());
    }
    for block in &article.blocks {
        validate_id(&block.id, "内容块")?;
        if !ids.insert(block.id.as_str())
            || !matches!(
                block.block_type.as_str(),
                "title"
                    | "rubric"
                    | "heading"
                    | "paragraph"
                    | "image"
                    | "caption"
                    | "list-item"
                    | "quote"
            )
        {
            return Err(invalid_plan());
        }
        if let Some(path) = &block.asset_path {
            validate_archive_path(path)?;
        }
    }
    Ok(())
}

fn invalid_plan() -> PlatformError {
    PlatformError::new("invalidImportPlan", "EPUB 解析结果无效。", false)
}

fn validate_id(value: &str, label: &str) -> Result<(), PlatformError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(PlatformError::new(
            "invalidInput",
            match label {
                "刊物" => "刊物标识无效。",
                "文章" => "文章标识无效。",
                _ => "内容标识无效。",
            },
            false,
        ));
    }
    Ok(())
}

fn is_hash(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn default_library_management() -> LibraryManagementRecord {
    LibraryManagementRecord {
        view_mode: "grid".into(),
        sort_by: "importedAt".into(),
        sort_direction: "desc".into(),
        active_category_id: "all".into(),
        categories: Vec::new(),
        items: BTreeMap::new(),
    }
}

fn load_library_management(
    connection: &Connection,
) -> Result<LibraryManagementRecord, PlatformError> {
    let encoded = connection
        .query_row(
            "SELECT value FROM settings WHERE key='library.management'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    let Some(encoded) = encoded else {
        return Ok(default_library_management());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&encoded) else {
        return Ok(default_library_management());
    };
    Ok(normalize_library_management(&value))
}

fn normalize_library_management(value: &serde_json::Value) -> LibraryManagementRecord {
    let mut result = default_library_management();
    result.view_mode = if value.get("viewMode").and_then(|item| item.as_str()) == Some("list") {
        "list".into()
    } else {
        "grid".into()
    };
    result.sort_by = if value.get("sortBy").and_then(|item| item.as_str()) == Some("name") {
        "name".into()
    } else {
        "importedAt".into()
    };
    result.sort_direction =
        if value.get("sortDirection").and_then(|item| item.as_str()) == Some("asc") {
            "asc".into()
        } else {
            "desc".into()
        };

    let mut category_ids = HashSet::new();
    let mut category_names = HashSet::new();
    if let Some(categories) = value.get("categories").and_then(|item| item.as_array()) {
        for candidate in categories {
            let Some(id) = candidate.get("id").and_then(|item| item.as_str()) else {
                continue;
            };
            let Some(name) = candidate.get("name").and_then(|item| item.as_str()) else {
                continue;
            };
            let name = normalize_library_text(name, 100);
            let folded = name.to_lowercase();
            if !is_category_id(id)
                || name.is_empty()
                || !category_ids.insert(id.to_string())
                || !category_names.insert(folded)
            {
                continue;
            }
            result.categories.push(LibraryCategory {
                id: id.to_string(),
                name,
                created_at: candidate
                    .get("createdAt")
                    .and_then(|item| item.as_str())
                    .unwrap_or("1970-01-01T00:00:00.000Z")
                    .to_string(),
            });
        }
    }

    if let Some(items) = value.get("items").and_then(|item| item.as_object()) {
        for (publication_id, candidate) in items {
            if !is_library_publication_id(publication_id) || !candidate.is_object() {
                continue;
            }
            let custom_title = candidate
                .get("customTitle")
                .and_then(|item| item.as_str())
                .map(|item| normalize_library_text(item, 200))
                .filter(|item| !item.is_empty());
            let category_id = candidate
                .get("categoryId")
                .and_then(|item| item.as_str())
                .filter(|item| category_ids.contains(*item))
                .map(str::to_string);
            if custom_title.is_some() || category_id.is_some() {
                result.items.insert(
                    publication_id.clone(),
                    LibraryItemManagement {
                        custom_title,
                        category_id,
                    },
                );
            }
        }
    }
    result.active_category_id = normalize_active_category(
        value.get("activeCategoryId").and_then(|item| item.as_str()),
        &result.categories,
    );
    result
}

fn write_library_management(
    connection: &Connection,
    device_id: &str,
    management: &LibraryManagementRecord,
) -> Result<(), PlatformError> {
    let value =
        serde_json::to_value(management).map_err(|_| PlatformError::storage_unavailable())?;
    crate::library_sync_settings::write_management(connection, device_id, &value)
}

fn library_preferences_of(management: &LibraryManagementRecord) -> LibraryPreferences {
    LibraryPreferences {
        view_mode: management.view_mode.clone(),
        sort_by: management.sort_by.clone(),
        sort_direction: management.sort_direction.clone(),
        active_category_id: management.active_category_id.clone(),
    }
}

fn normalize_active_category(value: Option<&str>, categories: &[LibraryCategory]) -> String {
    let candidate = value.unwrap_or("all");
    if candidate == "all"
        || candidate == "uncategorized"
        || categories.iter().any(|category| category.id == candidate)
    {
        candidate.to_string()
    } else {
        "all".into()
    }
}

fn normalize_library_text(value: &str, limit: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn require_library_name(value: &str, message: &'static str) -> Result<String, PlatformError> {
    require_library_name_with_limit(value, 100, message)
}

fn require_library_name_with_limit(
    value: &str,
    limit: usize,
    message: &'static str,
) -> Result<String, PlatformError> {
    let normalized = normalize_library_text(value, limit);
    if normalized.is_empty() {
        Err(PlatformError::new("invalidLibraryName", message, false))
    } else {
        Ok(normalized)
    }
}

fn ensure_unique_category_name(
    categories: &[LibraryCategory],
    name: &str,
    except_id: Option<&str>,
) -> Result<(), PlatformError> {
    let folded = name.to_lowercase();
    if categories.iter().any(|category| {
        Some(category.id.as_str()) != except_id && category.name.to_lowercase() == folded
    }) {
        Err(PlatformError::new(
            "duplicateCategory",
            "已有同名分类。",
            false,
        ))
    } else {
        Ok(())
    }
}

fn category_not_found() -> PlatformError {
    PlatformError::new("categoryNotFound", "未找到该分类。", false)
}

fn publication_not_found() -> PlatformError {
    PlatformError::new("publicationNotFound", "未找到该刊物。", false)
}

fn validate_publication_selection(values: Vec<String>) -> Result<Vec<String>, PlatformError> {
    let mut seen = HashSet::new();
    let unique = values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect::<Vec<_>>();
    if unique.is_empty()
        || unique.len() > 2_000
        || unique.iter().any(|value| !is_library_publication_id(value))
    {
        return Err(PlatformError::new(
            "invalidPublicationSelection",
            "请选择 1 至 2000 本有效刊物。",
            false,
        ));
    }
    Ok(unique)
}

fn prune_empty_library_items(items: &mut BTreeMap<String, LibraryItemManagement>) {
    items.retain(|_, item| item.custom_title.is_some() || item.category_id.is_some());
}

fn is_category_id(value: &str) -> bool {
    value.len() == 41
        && value.starts_with("category_")
        && value[9..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_library_publication_id(value: &str) -> bool {
    (8..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn asset_url(publication_id: &str, path: &str) -> String {
    let encoded_path = path
        .split('/')
        .map(|part| utf8_percent_encode(part, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "http://reader-asset.localhost/asset/{}/{encoded_path}",
        utf8_percent_encode(publication_id, NON_ALPHANUMERIC)
    )
}
fn default_preferences() -> ReaderPreferences {
    ReaderPreferences {
        theme: "light".into(),
        font_size: 20.0,
        line_height: 1.8,
        column_width: 760.0,
        paper_tint: 58.0,
    }
}
fn normalize_preferences(value: ReaderPreferences) -> ReaderPreferences {
    ReaderPreferences {
        theme: if value.theme == "dark" {
            "dark".into()
        } else {
            "light".into()
        },
        font_size: value.font_size.clamp(15.0, 30.0),
        line_height: value.line_height.clamp(1.4, 2.2),
        column_width: value.column_width.clamp(560.0, 980.0),
        paper_tint: value.paper_tint.clamp(0.0, 100.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database::AndroidDatabase, platform_paths::PlatformPaths};

    fn database(root: &Path) -> AndroidDatabase {
        AndroidDatabase::open(
            &PlatformPaths::new(root.join("data"), root.join("cache"), root.join("logs")),
            "test",
        )
        .expect("database")
    }

    fn plan(hash: &str) -> ParsedPublicationPlan {
        ParsedPublicationPlan {
            id: "pub_0123456789abcdef01234567".into(),
            hash: hash.into(),
            source_key: "generic-epub:identifier:fixture".into(),
            profile_id: "generic-epub".into(),
            title: "Fixture Weekly".into(),
            creator: Some("Fixture Author".into()),
            language: Some("en".into()),
            cover_path: Some("EPUB/cover.jpg".into()),
            sections: vec![ParsedSection {
                id: "0123456789abcdef012345678901".into(),
                source_key: "section.xhtml".into(),
                title: "Leaders".into(),
                position: 0,
                articles: vec![ParsedArticle {
                    id: "1123456789abcdef012345678901".into(),
                    source_key: "article.xhtml".into(),
                    title: "A fixture article".into(),
                    rubric: Some("A useful rubric".into()),
                    published_at: None,
                    position: 0,
                    source_href: "article.xhtml".into(),
                    blocks: vec![ParsedBlock {
                        id: "2123456789abcdef012345678901".into(),
                        source_key: "paragraph:fixture:0".into(),
                        block_type: "paragraph".into(),
                        position: 0,
                        text: Some("Fixture article body.".into()),
                        html: Some("Fixture article body.".into()),
                        asset_path: None,
                        alt: None,
                    }],
                }],
            }],
            unsectioned_articles: vec![],
            asset_paths: vec!["EPUB/cover.jpg".into()],
        }
    }

    #[test]
    fn commits_reads_and_restores_the_mobile_slice() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let parsed = plan(&"a".repeat(64));
        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");
        let publications = list_publications(&database).expect("list");
        assert_eq!(publications.len(), 1);
        let publication = get_publication(&database, &parsed.id).expect("publication");
        assert_eq!(publication.sections[0].articles.len(), 1);
        let article_id = &publication.sections[0].articles[0].id;
        save_position(
            &database,
            &parsed.id,
            article_id,
            ReadingPosition {
                scroll_top: 340.0,
                anchor_block_id: Some("2123456789abcdef012345678901".into()),
                anchor_token_index: Some(3),
                anchor_fraction: 0.45,
            },
        )
        .expect("position");
        let article = get_article(&database, article_id).expect("article");
        assert_eq!(article.saved_position.anchor_token_index, Some(3));
        assert!(article.blocks[0]
            .text
            .as_deref()
            .unwrap()
            .contains("Fixture"));
        let preferences = save_preferences(
            &database,
            ReaderPreferences {
                theme: "dark".into(),
                font_size: 100.0,
                line_height: 0.2,
                column_width: 20.0,
                paper_tint: 120.0,
            },
        )
        .expect("preferences");
        assert_eq!(preferences.theme, "dark");
        assert_eq!(preferences.font_size, 30.0);
        assert_eq!(
            get_preferences(&database)
                .expect("get preferences")
                .line_height,
            1.4
        );
    }

    #[test]
    fn manages_the_flat_library_and_reads_only_the_selected_translation_cache() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let parsed = plan(&"d".repeat(64));
        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");

        let state = create_category(&database, "  周刊   精选  ").expect("create category");
        let category_id = state.categories[0].id.clone();
        let state = rename_publication(&database, &parsed.id, "Fixture 精读").expect("rename");
        assert_eq!(state.publications[0].title, "Fixture 精读");
        let state = assign_publications(
            &database,
            vec![parsed.id.clone()],
            Some(category_id.clone()),
        )
        .expect("assign");
        assert_eq!(
            state.publications[0].category_id.as_deref(),
            Some(category_id.as_str())
        );
        let state = save_library_preferences(
            &database,
            LibraryPreferences {
                view_mode: "list".into(),
                sort_by: "name".into(),
                sort_direction: "asc".into(),
                active_category_id: category_id.clone(),
            },
        )
        .expect("preferences");
        assert_eq!(state.preferences.view_mode, "list");
        assert_eq!(state.preferences.active_category_id, category_id);
        assert_eq!(
            create_category(&database, "周刊 精选")
                .expect_err("duplicate")
                .code,
            "duplicateCategory"
        );

        let article_id = &parsed.sections[0].articles[0].id;
        let block_id = &parsed.sections[0].articles[0].blocks[0].id;
        let source_hash = hex::encode(Sha256::digest(
            parsed.sections[0].articles[0].blocks[0]
                .text
                .as_deref()
                .unwrap()
                .as_bytes(),
        ));
        database.connection().execute(
            "INSERT INTO translations(block_id,source_hash,target_language,model,prompt_version,text,created_at) VALUES(?1,?2,'zh-CN','deepseek-v4-flash','editorial-zh-v1','当前译文','2026-01-01T00:00:00.000Z')",
            params![block_id, source_hash],
        ).expect("old translation");
        database.connection().execute(
            "INSERT INTO translations(block_id,source_hash,target_language,model,prompt_version,text,created_at) VALUES(?1,'stale','zh-CN','fixture','v1','较新的其他模型译文','2026-02-01T00:00:00.000Z')",
            [block_id],
        ).expect("new translation");
        let article = get_article(&database, article_id).expect("article");
        assert_eq!(article.publication_title, "Fixture 精读");
        assert_eq!(article.blocks[0].translation.as_deref(), Some("当前译文"));
        database.connection().execute(
            "UPDATE translations SET model='previous-model',prompt_version='previous-prompt' WHERE source_hash=?1",
            [&source_hash],
        ).expect("change cached model");
        assert_eq!(
            get_article(&database, article_id).expect("fallback").blocks[0]
                .translation
                .as_deref(),
            Some("当前译文")
        );

        let state = delete_category(&database, &state.categories[0].id).expect("delete category");
        assert!(state.categories.is_empty());
        assert_eq!(state.publications[0].category_id, None);
        assert_eq!(state.preferences.active_category_id, "all");
    }

    #[test]
    fn deletes_publications_transactionally_before_cleaning_files() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let parsed = plan(&"e".repeat(64));
        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");
        let library = root.path().join("data/library");
        fs::create_dir_all(library.join(&parsed.id)).expect("publication directory");
        fs::write(library.join(&parsed.id).join("asset.bin"), b"fixture").expect("asset");

        let state =
            delete_publications(&mut database, &library, vec![parsed.id.clone()]).expect("delete");

        assert!(state.publications.is_empty());
        assert!(!library.join(&parsed.id).exists());
        let lifecycle: (String, String) = database
            .connection()
            .query_row(
                "SELECT state,content_hash FROM publication_lifecycle WHERE publication_id=?1",
                [&parsed.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("lifecycle");
        assert_eq!(lifecycle, ("deleted".into(), "e".repeat(64)));
    }

    #[test]
    fn rolls_back_when_publication_publish_fails() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let parsed = plan(&"b".repeat(64));
        let error = commit_publication(&mut database, &parsed, "epub", || {
            Err(PlatformError::storage_unavailable())
        })
        .expect_err("fail");
        assert_eq!(error.code, "storageUnavailable");
        assert!(list_publications(&database).expect("list").is_empty());
    }

    #[test]
    fn removes_only_managed_orphaned_library_directories() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let parsed = plan(&"c".repeat(64));
        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");
        let library = root.path().join("data/library");
        let orphan = library.join("pub_abcdefabcdefabcdefabcdef");
        let unrelated = library.join("notes");
        fs::create_dir_all(library.join(&parsed.id)).expect("known");
        fs::create_dir_all(&orphan).expect("orphan");
        fs::create_dir_all(&unrelated).expect("unrelated");

        cleanup_orphaned_library(&database, &library).expect("cleanup");

        assert!(library.join(&parsed.id).is_dir());
        assert!(!orphan.exists());
        assert!(unrelated.is_dir());
    }

    #[test]
    fn removes_only_validated_retained_sources() {
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());
        let source = b"validated retained EPUB";
        let parsed = plan(&hex::encode(Sha256::digest(source)));
        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");
        let library = root.path().join("data/library");
        let publication_root = library.join(&parsed.id);
        let managed_source = publication_root.join("source.epub");
        fs::create_dir_all(publication_root.join("assets/EPUB")).expect("asset root");
        fs::write(publication_root.join("assets/EPUB/cover.jpg"), b"cover").expect("asset");
        fs::write(&managed_source, source).expect("source");
        database
            .connection()
            .execute(
                "UPDATE publications SET source_path=?1,source_storage='retained' WHERE id=?2",
                params![managed_source.to_string_lossy(), parsed.id],
            )
            .expect("retained state");

        let report = remove_retained_publication_sources(&database, &library).expect("cleanup");
        assert_eq!(report.removed, 1);
        assert_eq!(report.reclaimed_bytes, source.len() as u64);
        assert!(report.skipped.is_empty());
        assert!(!managed_source.exists());
        let storage: (String, String) = database
            .connection()
            .query_row(
                "SELECT source_path,source_storage FROM publications WHERE id=?1",
                [&parsed.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("storage state");
        assert_eq!(storage, (String::new(), "parsed-only".into()));

        fs::write(&managed_source, b"tampered").expect("tampered source");
        database
            .connection()
            .execute(
                "UPDATE publications SET source_path=?1,source_storage='retained' WHERE id=?2",
                params![managed_source.to_string_lossy(), parsed.id],
            )
            .expect("retained state");
        let unsafe_report =
            remove_retained_publication_sources(&database, &library).expect("safe cleanup");
        assert_eq!(unsafe_report.removed, 0);
        assert_eq!(unsafe_report.skipped.len(), 1);
        assert!(managed_source.is_file());
    }

    #[test]
    fn accepts_the_shared_content_id_v2_epub_vector_without_rewriting_ids() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-content-v2.json"))
                .expect("vector");
        assert_eq!(vector["contentIdVersion"], 2);
        let parsed: ParsedPublicationPlan =
            serde_json::from_value(vector["expectedPlan"].clone()).expect("plan");
        let expected_publication = parsed.id.clone();
        let expected_article = parsed.sections[0].articles[0].id.clone();
        let expected_block = parsed.sections[0].articles[0].blocks[0].id.clone();
        let root = tempfile::tempdir().expect("root");
        let mut database = database(root.path());

        commit_publication(&mut database, &parsed, "epub", || Ok(())).expect("commit");

        let publication = get_publication(&database, &expected_publication).expect("publication");
        assert_eq!(publication.sections[0].articles[0].id, expected_article);
        let article = get_article(&database, &expected_article).expect("article");
        assert_eq!(article.blocks[0].id, expected_block);
    }
}
