use crate::{
    database::AndroidDatabase, mobile_reading::ParsedPublicationPlan, platform_error::PlatformError,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::ErrorKind, path::Path};

fn conflict() -> PlatformError {
    PlatformError::new(
        "importConflict",
        "重新解析后的内容身份冲突，已保留原数据。",
        false,
    )
}

pub fn repair(
    database: &AndroidDatabase,
    plan: &ParsedPublicationPlan,
) -> Result<bool, PlatformError> {
    crate::mobile_reading::validate_plan(plan)?;
    let connection = database.connection();
    let hash: String = connection
        .query_row(
            "SELECT hash FROM publications WHERE id=?1",
            [&plan.id],
            |r| r.get(0),
        )
        .map_err(|_| conflict())?;
    if hash != plan.hash {
        return Err(conflict());
    }
    let before = content_hash(database, &plan.id)?;
    let check = |table: &str,
                 id: &str,
                 parent: &str,
                 parent_column: &str,
                 source: &str|
     -> Result<bool, PlatformError> {
        let row: Option<(String, String)> = connection
            .query_row(
                &format!("SELECT {parent_column},source_key FROM {table} WHERE id=?1"),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| conflict())?;
        if row
            .as_ref()
            .is_some_and(|(p, s)| p != parent || s != source)
        {
            return Err(conflict());
        }
        Ok(row.is_none())
    };
    connection
        .execute_batch("SAVEPOINT repair_publication")
        .map_err(|_| conflict())?;
    let result: Result<bool, PlatformError> = (|| {
        let mut added = false;
        for section in &plan.sections {
            added |= check(
                "sections",
                &section.id,
                &plan.id,
                "publication_id",
                &section.source_key,
            )?;
            connection.execute("INSERT INTO sections(id,publication_id,source_key,title,position) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET position=excluded.position,title=excluded.title",params![section.id,plan.id,section.source_key,section.title,section.position]).map_err(|_|conflict())?;
        }
        for (article, section) in plan
            .sections
            .iter()
            .flat_map(|s| s.articles.iter().map(move |a| (a, Some(s.id.as_str()))))
            .chain(plan.unsectioned_articles.iter().map(|a| (a, None)))
        {
            added |= check(
                "articles",
                &article.id,
                &plan.id,
                "publication_id",
                &article.source_key,
            )?;
            connection.execute("INSERT INTO articles(id,publication_id,section_id,source_key,title,rubric,published_at,position,source_href) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET position=excluded.position,section_id=excluded.section_id,title=excluded.title,rubric=excluded.rubric",params![article.id,plan.id,section,article.source_key,article.title,article.rubric,article.published_at,article.position,article.source_href]).map_err(|_|conflict())?;
            for block in &article.blocks {
                added |= check(
                    "blocks",
                    &block.id,
                    &article.id,
                    "article_id",
                    &block.source_key,
                )?;
                let old: Option<Option<String>> = connection
                    .query_row("SELECT text FROM blocks WHERE id=?1", [&block.id], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(|_| conflict())?;
                if old.is_some_and(|old| old != block.text) {
                    return Err(conflict());
                }
                connection.execute("INSERT INTO blocks(id,article_id,source_key,type,position,text,html,asset_path,alt) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET position=excluded.position",params![block.id,article.id,block.source_key,block.block_type,block.position,block.text,block.html,block.asset_path,block.alt]).map_err(|_|conflict())?;
            }
        }
        connection.execute("UPDATE publications SET article_count=(SELECT count(*) FROM articles WHERE publication_id=?1),section_count=(SELECT count(*) FROM sections WHERE publication_id=?1) WHERE id=?1",[&plan.id]).map_err(|_|conflict())?;
        let changed = added || content_hash(database, &plan.id)? != before;
        if changed {
            connection.execute("UPDATE publication_lifecycle SET changed_at=?1,device_id=?2 WHERE publication_id=?3",params![chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),database.device_id(),plan.id]).map_err(|_|conflict())?;
        }
        Ok(changed)
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK TO repair_publication");
    }
    connection
        .execute_batch("RELEASE repair_publication")
        .map_err(|_| conflict())?;
    result
}

pub fn copy_missing_assets(
    source: &Path,
    target: &Path,
    paths: &[String],
) -> Result<(), PlatformError> {
    for relative in paths {
        crate::mobile_reading::validate_archive_path(relative)?;
        let from = source.join(relative);
        let to = target.join(relative);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&to)
        {
            Ok(mut output) => {
                let result = (|| {
                    let mut input = fs::File::open(from)?;
                    std::io::copy(&mut input, &mut output)?;
                    output.sync_all()
                })();
                if result.is_err() {
                    drop(output);
                    let _ = fs::remove_file(to);
                    return Err(PlatformError::storage_unavailable());
                }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(_) => return Err(PlatformError::storage_unavailable()),
        }
    }
    Ok(())
}

pub fn content_hash(
    database: &AndroidDatabase,
    publication_id: &str,
) -> Result<String, PlatformError> {
    let key = format!("local.publication-digest.{publication_id}");
    let connection = database.connection();
    let cached: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    if let Some(hash) = cached {
        if hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Ok(hash);
        }
    }
    let queries=["SELECT id,source_key,title,position FROM sections WHERE publication_id=? ORDER BY id",
        "SELECT id,section_id,source_key,title,rubric,published_at,position,source_href FROM articles WHERE publication_id=? ORDER BY id",
        "SELECT b.id,b.article_id,b.source_key,b.type,b.position,b.text,b.html,b.asset_path,b.alt FROM blocks b JOIN articles a ON a.id=b.article_id WHERE a.publication_id=? ORDER BY b.id"];
    let mut values = vec![json!(publication_id)];
    for query in queries {
        let mut statement = connection
            .prepare(query)
            .map_err(|_| PlatformError::database_corrupt())?;
        let count = statement.column_count();
        let rows = statement
            .query_map([publication_id], |r| {
                (0..count)
                    .map(|i| match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Ok(Value::Null),
                        rusqlite::types::ValueRef::Integer(n) => Ok(json!(n)),
                        rusqlite::types::ValueRef::Text(s) => Ok(json!(String::from_utf8_lossy(s))),
                        _ => Err(rusqlite::Error::InvalidQuery),
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|_| PlatformError::database_corrupt())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlatformError::database_corrupt())?;
        values.push(json!(rows));
    }
    let hash = hex::encode(Sha256::digest(json!(values).to_string().as_bytes()));
    connection.execute("INSERT OR REPLACE INTO settings(key,value,updated_at,device_id) VALUES(?1,?2,?3,'local-cache')",params![key,hash,chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)]).map_err(|_|PlatformError::storage_unavailable())?;
    Ok(hash)
}
