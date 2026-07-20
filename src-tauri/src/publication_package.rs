use crate::{
    database::AndroidDatabase,
    mobile_reading::{self, ParsedArticle, ParsedBlock, ParsedPublicationPlan, ParsedSection},
    platform_error::PlatformError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const FORMAT: &str = "foreign-press-reader-publication";
const FORMAT_VERSION: i64 = 2;
const CONTENT_ID_VERSION: i64 = 2;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageFile {
    path: String,
    size: u64,
    sha256: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageManifest {
    format: String,
    format_version: i64,
    content_id_version: i64,
    pub publication_id: String,
    pub source_format: String,
    pub source_content_sha256: String,
    pub first_imported_at: String,
    plan_path: String,
    files: Vec<PackageFile>,
}

#[derive(Debug, Clone)]
pub struct CreatedPackage {
    pub byte_length: u64,
    pub payload_sha256: String,
}

#[derive(Debug, Clone)]
pub struct InspectedPackage {
    pub manifest: PackageManifest,
    pub plan: ParsedPublicationPlan,
    pub root: PathBuf,
}

pub fn create(
    database: &AndroidDatabase,
    library_root: &Path,
    publication_id: &str,
    destination: &Path,
) -> Result<CreatedPackage, PlatformError> {
    let asset_root = library_root.join(publication_id).join("assets");
    let assets = list_assets(&asset_root)?;
    let asset_paths = assets
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let (plan, source_format, first_imported_at) =
        export_plan(database, publication_id, asset_paths)?;
    let plan_bytes =
        serde_json::to_vec(&plan).map_err(|_| invalid_package("无法序列化刊物解析内容。"))?;
    let mut files = vec![PackageFile {
        path: "publication.json".into(),
        size: plan_bytes.len() as u64,
        sha256: hash_bytes(&plan_bytes),
        kind: "plan".into(),
    }];
    for (relative, absolute) in &assets {
        let (size, sha256) = hash_file(absolute)?;
        files.push(PackageFile {
            path: format!("assets/{relative}"),
            size,
            sha256,
            kind: "asset".into(),
        });
    }
    let manifest = PackageManifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        content_id_version: CONTENT_ID_VERSION,
        publication_id: plan.id.clone(),
        source_format,
        source_content_sha256: plan.hash.clone(),
        first_imported_at,
        plan_path: "publication.json".into(),
        files,
    };
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
    }
    let output = File::create(destination).map_err(|_| PlatformError::storage_unavailable())?;
    let mut archive = ZipWriter::new(output);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    archive
        .start_file("manifest.json", deflated)
        .map_err(|_| PlatformError::storage_unavailable())?;
    archive
        .write_all(
            &serde_json::to_vec(&manifest).map_err(|_| invalid_package("无法生成刊物包清单。"))?,
        )
        .map_err(|_| PlatformError::storage_unavailable())?;
    archive
        .start_file("publication.json", deflated)
        .map_err(|_| PlatformError::storage_unavailable())?;
    archive
        .write_all(&plan_bytes)
        .map_err(|_| PlatformError::storage_unavailable())?;
    for (relative, absolute) in &assets {
        archive
            .start_file(format!("assets/{relative}"), stored)
            .map_err(|_| PlatformError::storage_unavailable())?;
        let mut input = File::open(absolute).map_err(|_| PlatformError::storage_unavailable())?;
        std::io::copy(&mut input, &mut archive)
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    archive
        .finish()
        .map_err(|_| PlatformError::storage_unavailable())?;
    let (byte_length, payload_sha256) = hash_file(destination)?;
    Ok(CreatedPackage {
        byte_length,
        payload_sha256,
    })
}

pub fn inspect_and_extract(
    package_path: &Path,
    root: &Path,
) -> Result<InspectedPackage, PlatformError> {
    let package_size = fs::metadata(package_path)
        .map_err(|_| invalid_package("无法读取刊物包。"))?
        .len();
    if package_size == 0 || package_size > MAX_PACKAGE_BYTES {
        return Err(invalid_package("刊物包大小无效。"));
    }
    let mut archive =
        ZipArchive::new(File::open(package_path).map_err(|_| invalid_package("无法读取刊物包。"))?)
            .map_err(|_| invalid_package("刊物包不是有效 ZIP。"))?;
    if archive.is_empty() || archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(invalid_package("刊物包文件数量无效。"));
    }
    let mut names = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| invalid_package("刊物包目录损坏。"))?;
        let name = entry.name().to_owned();
        if entry.is_dir()
            || entry.enclosed_name().is_none()
            || name.contains('\\')
            || !safe_entry(&name)
            || !names.insert(name)
        {
            return Err(invalid_package("刊物包包含不安全路径。"));
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|size| *size <= MAX_PACKAGE_BYTES)
            .ok_or_else(|| invalid_package("刊物包解压后过大。"))?;
    }
    let manifest: PackageManifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| invalid_package("刊物包缺少清单。"))?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| invalid_package("无法读取刊物包清单。"))?;
        serde_json::from_slice(&bytes).map_err(|_| invalid_package("刊物包清单无效。"))?
    };
    validate_manifest(&manifest, &names)?;
    for listed in &manifest.files {
        let mut entry = archive
            .by_name(&listed.path)
            .map_err(|_| invalid_package("刊物包缺少清单文件。"))?;
        if entry.size() != listed.size || hash_reader(&mut entry)? != listed.sha256 {
            return Err(invalid_package("刊物包文件完整性校验失败。"));
        }
    }
    let plan: ParsedPublicationPlan = {
        let mut entry = archive
            .by_name("publication.json")
            .map_err(|_| invalid_package("刊物包缺少解析计划。"))?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| invalid_package("无法读取刊物解析计划。"))?;
        serde_json::from_slice(&bytes).map_err(|_| invalid_package("刊物解析计划无效。"))?
    };
    if !valid_plan(&plan) {
        return Err(invalid_package("刊物解析计划字段无效。"));
    }
    if plan.id != manifest.publication_id || plan.hash != manifest.source_content_sha256 {
        return Err(invalid_package("刊物包身份不一致。"));
    }
    let packaged_assets = manifest
        .files
        .iter()
        .filter(|file| file.kind == "asset")
        .map(|file| file.path.trim_start_matches("assets/").to_owned())
        .collect::<HashSet<_>>();
    let planned_assets = plan.asset_paths.iter().cloned().collect::<HashSet<_>>();
    if packaged_assets != planned_assets || planned_assets.len() != plan.asset_paths.len() {
        return Err(invalid_package("刊物包资源清单不一致。"));
    }
    fs::create_dir_all(root).map_err(|_| PlatformError::storage_unavailable())?;
    for name in &names {
        let destination = name
            .split('/')
            .fold(root.to_path_buf(), |path, part| path.join(part));
        if !destination.starts_with(root) {
            return Err(invalid_package("刊物包路径越界。"));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
        }
        let mut entry = archive
            .by_name(name)
            .map_err(|_| invalid_package("刊物包文件损坏。"))?;
        let mut output =
            File::create(&destination).map_err(|_| PlatformError::storage_unavailable())?;
        std::io::copy(&mut entry, &mut output).map_err(|_| PlatformError::storage_unavailable())?;
    }
    Ok(InspectedPackage {
        manifest,
        plan,
        root: root.to_path_buf(),
    })
}

pub fn restore(
    database: &mut AndroidDatabase,
    library_root: &Path,
    inspected: &InspectedPackage,
) -> Result<mobile_reading::ImportResult, PlatformError> {
    if let Some(id) = mobile_reading::find_publication_by_hash(database, &inspected.plan.hash)? {
        return Ok(mobile_reading::ImportResult {
            publication: mobile_reading::get_publication(database, &id)?,
            duplicate: true,
        });
    }
    let final_root = library_root.join(&inspected.plan.id);
    if final_root.exists() {
        return Err(PlatformError::new(
            "importConflict",
            "刊物身份已存在但内容不同。",
            false,
        ));
    }
    let publish_root = inspected.root.join("publish");
    fs::create_dir_all(&publish_root).map_err(|_| PlatformError::storage_unavailable())?;
    let source_assets = inspected.root.join("assets");
    let publish_assets = publish_root.join("assets");
    if source_assets.exists() {
        fs::rename(&source_assets, &publish_assets)
            .map_err(|_| PlatformError::storage_unavailable())?;
    } else {
        fs::create_dir_all(&publish_assets).map_err(|_| PlatformError::storage_unavailable())?;
    }
    let published = std::cell::Cell::new(false);
    let result = mobile_reading::commit_publication_at(
        database,
        &inspected.plan,
        &inspected.manifest.source_format,
        Some(&inspected.manifest.first_imported_at),
        || {
            fs::create_dir_all(library_root).map_err(|_| PlatformError::storage_unavailable())?;
            fs::rename(&publish_root, &final_root)
                .map_err(|_| PlatformError::storage_unavailable())?;
            published.set(true);
            Ok(())
        },
    );
    if let Err(error) = result {
        if published.get() {
            let _ = fs::remove_dir_all(&final_root);
        }
        return Err(error);
    }
    Ok(mobile_reading::ImportResult {
        publication: mobile_reading::get_publication(database, &inspected.plan.id)?,
        duplicate: false,
    })
}

fn export_plan(
    database: &AndroidDatabase,
    publication_id: &str,
    asset_paths: Vec<String>,
) -> Result<(ParsedPublicationPlan, String, String), PlatformError> {
    let connection = database.connection();
    let publication = connection.query_row(
        "SELECT p.id,p.hash,p.source_key,p.profile_id,p.title,p.creator,p.language,p.cover_path, \
         COALESCE(l.format_id,'epub'),min(p.imported_at,COALESCE(l.changed_at,p.imported_at)) \
         FROM publications p LEFT JOIN publication_lifecycle l ON l.publication_id=p.id WHERE p.id=?1",
        [publication_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, String>(8)?,
            row.get::<_, String>(9)?)),
    ).map_err(|_| PlatformError::database_corrupt())?;
    let mut article_statement = connection.prepare(
        "SELECT id,section_id,source_key,title,rubric,published_at,position,source_href FROM articles WHERE publication_id=?1 ORDER BY position,id",
    ).map_err(|_| PlatformError::database_corrupt())?;
    let mut articles = article_statement
        .query_map([publication_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let mut article_records = Vec::new();
    for (id, section_id, source_key, title, rubric, published_at, position, source_href) in
        articles.drain(..)
    {
        let mut blocks_statement = connection.prepare(
            "SELECT id,source_key,type,position,text,html,asset_path,alt FROM blocks WHERE article_id=?1 ORDER BY position,id",
        ).map_err(|_| PlatformError::database_corrupt())?;
        let blocks = blocks_statement
            .query_map([&id], |row| {
                Ok(ParsedBlock {
                    id: row.get(0)?,
                    source_key: row.get(1)?,
                    block_type: row.get(2)?,
                    position: row.get(3)?,
                    text: row.get(4)?,
                    html: row.get(5)?,
                    asset_path: row.get(6)?,
                    alt: row.get(7)?,
                })
            })
            .map_err(|_| PlatformError::database_corrupt())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlatformError::database_corrupt())?;
        article_records.push((
            section_id,
            ParsedArticle {
                id,
                source_key,
                title,
                rubric,
                published_at,
                position,
                source_href,
                blocks,
            },
        ));
    }
    let mut section_statement = connection.prepare(
        "SELECT id,source_key,title,position FROM sections WHERE publication_id=?1 ORDER BY position,id",
    ).map_err(|_| PlatformError::database_corrupt())?;
    let section_rows = section_statement
        .query_map([publication_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|_| PlatformError::database_corrupt())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PlatformError::database_corrupt())?;
    let sections = section_rows
        .into_iter()
        .map(|(id, source_key, title, position)| ParsedSection {
            articles: article_records
                .iter()
                .filter(|(section, _)| section.as_deref() == Some(id.as_str()))
                .map(|(_, article)| article.clone())
                .collect(),
            id,
            source_key,
            title,
            position,
        })
        .collect();
    let unsectioned_articles = article_records
        .iter()
        .filter(|(section, _)| section.is_none())
        .map(|(_, article)| article.clone())
        .collect();
    Ok((
        ParsedPublicationPlan {
            id: publication.0,
            hash: publication.1,
            source_key: publication.2,
            profile_id: publication.3,
            title: publication.4,
            creator: publication.5,
            language: publication.6,
            cover_path: publication.7,
            sections,
            unsectioned_articles,
            asset_paths,
        },
        publication.8,
        publication.9,
    ))
}

fn list_assets(root: &Path) -> Result<Vec<(String, PathBuf)>, PlatformError> {
    fn visit(
        base: &Path,
        directory: &Path,
        output: &mut Vec<(String, PathBuf)>,
    ) -> Result<(), PlatformError> {
        if !directory.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(directory).map_err(|_| PlatformError::storage_unavailable())? {
            let entry = entry.map_err(|_| PlatformError::storage_unavailable())?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| PlatformError::storage_unavailable())?;
            if metadata.file_type().is_symlink() {
                return Err(invalid_package("刊物资源包含符号链接。"));
            }
            if metadata.is_dir() {
                visit(base, &entry.path(), output)?;
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(base)
                    .map_err(|_| invalid_package("刊物资源路径越界。"))?
                    .iter()
                    .map(|part| part.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                if !safe_asset(&relative) {
                    return Err(invalid_package("刊物资源路径无效。"));
                }
                output.push((relative, entry.path()));
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, root, &mut output)?;
    output.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(output)
}

fn validate_manifest(
    manifest: &PackageManifest,
    names: &HashSet<String>,
) -> Result<(), PlatformError> {
    let imported_at_valid =
        chrono::DateTime::parse_from_rfc3339(&manifest.first_imported_at).is_ok();
    if manifest.format != FORMAT
        || manifest.format_version != FORMAT_VERSION
        || !imported_at_valid
        || manifest.content_id_version != CONTENT_ID_VERSION
        || manifest.plan_path != "publication.json"
        || !is_sha256(&manifest.source_content_sha256)
        || manifest.publication_id.is_empty()
        || !valid_source_format(&manifest.source_format)
    {
        return Err(invalid_package("不支持此刊物包格式或版本。"));
    }
    let expected = manifest
        .files
        .iter()
        .map(|file| file.path.clone())
        .chain(["manifest.json".into()])
        .collect::<HashSet<_>>();
    if &expected != names || expected.len() != manifest.files.len() + 1 {
        return Err(invalid_package("刊物包文件清单不一致。"));
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        let valid_kind = (file.kind == "plan" && file.path == "publication.json")
            || (file.kind == "asset"
                && file.path.starts_with("assets/")
                && safe_asset(file.path.trim_start_matches("assets/")));
        if !valid_kind
            || !paths.insert(file.path.as_str())
            || !is_sha256(&file.sha256)
            || file.size > MAX_PACKAGE_BYTES
        {
            return Err(invalid_package("刊物包文件记录无效。"));
        }
    }
    if manifest
        .files
        .iter()
        .filter(|file| file.kind == "plan")
        .count()
        != 1
    {
        return Err(invalid_package("刊物包缺少解析计划。"));
    }
    Ok(())
}

fn safe_entry(value: &str) -> bool {
    value == "manifest.json"
        || value == "publication.json"
        || (value.starts_with("assets/") && safe_asset(value.trim_start_matches("assets/")))
}

fn safe_asset(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_source_format(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_plan(plan: &ParsedPublicationPlan) -> bool {
    if plan.id.is_empty()
        || !is_sha256(&plan.hash)
        || plan.source_key.is_empty()
        || plan.profile_id.is_empty()
        || plan.title.is_empty()
    {
        return false;
    }
    let mut assets = HashSet::new();
    if plan
        .asset_paths
        .iter()
        .any(|asset| !safe_asset(asset) || !assets.insert(asset.as_str()))
    {
        return false;
    }
    if plan
        .cover_path
        .as_ref()
        .is_some_and(|cover| !assets.contains(cover.as_str()))
    {
        return false;
    }
    let mut ids = HashSet::from([plan.id.clone()]);
    let article_count = plan
        .sections
        .iter()
        .map(|section| section.articles.len())
        .sum::<usize>()
        + plan.unsectioned_articles.len();
    for section in &plan.sections {
        if section.id.is_empty()
            || !ids.insert(section.id.clone())
            || section.source_key.is_empty()
            || section.title.is_empty()
            || section
                .articles
                .iter()
                .any(|article| !valid_article(article, &mut ids, &assets))
        {
            return false;
        }
    }
    if plan
        .unsectioned_articles
        .iter()
        .any(|article| !valid_article(article, &mut ids, &assets))
    {
        return false;
    }
    article_count > 0
}

fn valid_article(
    article: &ParsedArticle,
    ids: &mut HashSet<String>,
    assets: &HashSet<&str>,
) -> bool {
    if article.id.is_empty()
        || !ids.insert(article.id.clone())
        || article.source_key.is_empty()
        || article.title.is_empty()
    {
        return false;
    }
    for block in &article.blocks {
        if block.id.is_empty()
            || !ids.insert(block.id.clone())
            || block.source_key.is_empty()
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
            || block
                .asset_path
                .as_ref()
                .is_some_and(|asset| !asset.is_empty() && !assets.contains(asset.as_str()))
        {
            return false;
        }
    }
    true
}

fn hash_file(path: &Path) -> Result<(u64, String), PlatformError> {
    let mut input = File::open(path).map_err(|_| PlatformError::storage_unavailable())?;
    let size = input
        .metadata()
        .map_err(|_| PlatformError::storage_unavailable())?
        .len();
    Ok((size, hash_reader(&mut input)?))
}

fn hash_reader(reader: &mut impl Read) -> Result<String, PlatformError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| invalid_package("无法校验刊物包。"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn invalid_package(message: &'static str) -> PlatformError {
    PlatformError::new("publicationPackageInvalid", message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_paths::PlatformPaths;

    fn database(root: &Path) -> AndroidDatabase {
        AndroidDatabase::open(
            &PlatformPaths::new(root.join("data"), root.join("cache"), root.join("logs")),
            "test",
        )
        .expect("database")
    }

    #[test]
    fn matches_the_shared_publication_package_vector() {
        let package_vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../test-vectors/publication-package-v2.json"
        ))
        .expect("package vector");
        let plan_vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-content-v2.json"))
                .expect("plan vector");
        let plan: ParsedPublicationPlan =
            serde_json::from_value(plan_vector["expectedPlan"].clone()).expect("plan");
        assert!(valid_plan(&plan));
        let plan_bytes = serde_json::to_vec(&plan).expect("serialize plan");
        assert_eq!(
            plan_bytes.len() as u64,
            package_vector["expectedPlanJsonSize"].as_u64().unwrap()
        );
        assert_eq!(
            hash_bytes(&plan_bytes),
            package_vector["expectedPlanJsonSha256"].as_str().unwrap()
        );
        let asset =
            hex::decode(package_vector["assetFixtureHex"].as_str().unwrap()).expect("asset");
        assert_eq!(
            hash_bytes(&asset),
            "32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af"
        );

        let manifest: PackageManifest =
            serde_json::from_value(package_vector["expectedManifest"].clone()).expect("manifest");
        let names = manifest
            .files
            .iter()
            .map(|file| file.path.clone())
            .chain(["manifest.json".into()])
            .collect::<HashSet<_>>();
        validate_manifest(&manifest, &names).expect("valid manifest");

        let mut legacy = manifest.clone();
        legacy.format_version = 1;
        assert!(validate_manifest(&legacy, &names).is_err());
    }

    #[test]
    fn creates_and_restores_a_source_free_publication_package() {
        let root = tempfile::tempdir().expect("root");
        let plan_vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-content-v2.json"))
                .expect("plan vector");
        let plan: ParsedPublicationPlan =
            serde_json::from_value(plan_vector["expectedPlan"].clone()).expect("plan");
        let fixture = [0xff, 0xd8, 0xff, 0xd9];
        let source_root = root.path().join("source");
        let source_library = source_root.join("library");
        for asset in &plan.asset_paths {
            let destination = asset.split('/').fold(
                source_library.join(&plan.id).join("assets"),
                |path, part| path.join(part),
            );
            fs::create_dir_all(destination.parent().unwrap()).expect("asset root");
            fs::write(destination, fixture).expect("asset");
        }
        let mut source_database = database(&source_root);
        let first_imported_at = "2024-02-03T04:05:06.000Z";
        mobile_reading::commit_publication_at(
            &mut source_database,
            &plan,
            "epub",
            Some(first_imported_at),
            || Ok(()),
        )
        .expect("commit source");
        let package_path = root.path().join("publication.fprpub");
        create(&source_database, &source_library, &plan.id, &package_path).expect("package");
        let mut archive =
            ZipArchive::new(File::open(&package_path).expect("open package")).expect("zip");
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"publication.json".to_string()));
        assert!(names.iter().all(|name| !name.ends_with(".epub")));
        drop(archive);

        let extracted =
            inspect_and_extract(&package_path, &root.path().join("extracted")).expect("inspect");
        assert_eq!(extracted.manifest.format_version, 2);
        assert_eq!(extracted.manifest.first_imported_at, first_imported_at);
        let target_root = root.path().join("target");
        let target_library = target_root.join("library");
        let mut target_database = database(&target_root);
        let restored = restore(&mut target_database, &target_library, &extracted).expect("restore");
        assert!(!restored.duplicate);
        let restored_imported_at: String = target_database
            .connection()
            .query_row(
                "SELECT imported_at FROM publications WHERE id=?1",
                [&plan.id],
                |row| row.get(0),
            )
            .expect("restored import time");
        assert_eq!(restored_imported_at, first_imported_at);
        assert!(!target_library.join(&plan.id).join("source.epub").exists());
        assert!(target_library
            .join(&plan.id)
            .join("assets/EPUB/images/cover.jpg")
            .is_file());
        let storage: (String, String) = target_database
            .connection()
            .query_row(
                "SELECT source_path,source_storage FROM publications WHERE id=?1",
                [&plan.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("storage");
        assert_eq!(storage, (String::new(), "parsed-only".into()));
    }
}
