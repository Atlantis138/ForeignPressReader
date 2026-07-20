use crate::{
    mobile_reading::{self, ParsedPublicationPlan},
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
use fs2::available_space;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use zip::ZipArchive;

const MAX_EPUB_BYTES: u64 = 500 * 1024 * 1024;
const MAX_ENTRIES: usize = 4_000;
const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_ASSETS: u64 = 750 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 2_000;
const FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubEntryInfo {
    pub path: String,
    pub directory: bool,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BeginImportResult {
    Cancelled,
    Duplicate {
        result: Box<mobile_reading::ImportResult>,
    },
    Ready {
        session_id: String,
        display_name: String,
        bytes: u64,
        content_hash: String,
        entries: Vec<EpubEntryInfo>,
    },
}

#[derive(Debug)]
pub struct EpubImportSession {
    pub id: String,
    pub request_id: String,
    pub display_name: String,
    pub root: PathBuf,
    pub source: PathBuf,
    pub bytes: u64,
    pub content_hash: String,
    entries: HashMap<String, EpubEntryInfo>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug)]
pub struct EpubImportManager {
    root: PathBuf,
    sessions: HashMap<String, EpubImportSession>,
    inflight: HashMap<String, InflightImport>,
}

#[derive(Debug)]
struct InflightImport {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl EpubImportManager {
    pub fn new(paths: &PlatformPaths) -> Result<Self, PlatformError> {
        let root = paths.persistent_staging.join("imports");
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
        }
        fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
        Ok(Self {
            root,
            sessions: HashMap::new(),
            inflight: HashMap::new(),
        })
    }

    pub fn prepare_destination(
        &self,
        request_id: &str,
    ) -> Result<(String, PathBuf), PlatformError> {
        require_uuid(request_id)?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let root = self.root.join(&session_id);
        fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
        Ok((session_id, root.join("source.epub")))
    }

    pub fn register(
        &mut self,
        session_id: String,
        request_id: String,
        display_name: String,
        source: PathBuf,
    ) -> Result<&EpubImportSession, PlatformError> {
        let (bytes, content_hash, entries) = match validate_epub(&source) {
            Ok(result) => result,
            Err(error) => {
                if let Some(root) = source.parent() {
                    let _ = remove_private_root(root, &self.root);
                }
                return Err(error);
            }
        };
        let root = source
            .parent()
            .ok_or_else(PlatformError::storage_unavailable)?
            .to_path_buf();
        self.sessions.insert(
            session_id.clone(),
            EpubImportSession {
                id: session_id.clone(),
                request_id,
                display_name: safe_display_name(&display_name),
                root,
                source,
                bytes,
                content_hash,
                entries,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(self.sessions.get(&session_id).expect("inserted session"))
    }

    pub fn session(&self, session_id: &str) -> Result<&EpubImportSession, PlatformError> {
        self.sessions
            .get(session_id)
            .ok_or_else(|| PlatformError::new("importSessionMissing", "导入会话已失效。", false))
    }

    pub fn take_for_commit(
        &mut self,
        session_id: &str,
    ) -> Result<EpubImportSession, PlatformError> {
        let session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| PlatformError::new("importSessionMissing", "导入会话已失效。", false))?;
        self.inflight.insert(
            session_id.to_owned(),
            InflightImport {
                request_id: session.request_id.clone(),
                cancelled: Arc::clone(&session.cancelled),
            },
        );
        Ok(session)
    }

    pub fn finish_commit(&mut self, session_id: &str) {
        self.inflight.remove(session_id);
    }

    pub fn cancel(&mut self, request_or_session: &str) -> Result<(), PlatformError> {
        let id = self
            .sessions
            .iter()
            .find(|(id, session)| {
                *id == request_or_session || session.request_id == request_or_session
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            if let Some(session) = self.sessions.remove(&id) {
                remove_private_root(&session.root, &self.root)?;
            }
            return Ok(());
        }
        if let Some(import) = self.inflight.iter().find_map(|(id, import)| {
            (id == request_or_session || import.request_id == request_or_session).then_some(import)
        }) {
            import.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl EpubImportSession {
    pub fn entries(&self) -> Vec<EpubEntryInfo> {
        let mut entries = self.entries.values().cloned().collect::<Vec<_>>();
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        entries
    }

    pub fn read_text(&self, path: &str) -> Result<String, PlatformError> {
        mobile_reading::validate_archive_path(path)?;
        let entry = self
            .entries
            .get(path)
            .filter(|entry| !entry.directory && entry.uncompressed_bytes <= MAX_TEXT_BYTES)
            .ok_or_else(|| {
                PlatformError::new("importEntryDenied", "EPUB 文本入口不可读取。", false)
            })?;
        if !is_text_entry(&entry.path) {
            return Err(PlatformError::new(
                "importEntryDenied",
                "EPUB 文本入口不可读取。",
                false,
            ));
        }
        let mut archive = open_archive(&self.source)?;
        let mut file = archive
            .by_name(path)
            .map_err(|_| PlatformError::new("invalidEpub", "EPUB 结构已损坏。", false))?;
        let mut bytes = Vec::with_capacity(entry.uncompressed_bytes as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| PlatformError::new("invalidEpub", "EPUB 结构已损坏。", false))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn extract_assets(&self, parsed: &mut ParsedPublicationPlan) -> Result<(), PlatformError> {
        self.ensure_not_cancelled()?;
        if parsed.hash != self.content_hash {
            return Err(PlatformError::new(
                "invalidImportPlan",
                "EPUB 解析结果与所选文件不匹配。",
                false,
            ));
        }
        let requested = parsed.asset_paths.iter().cloned().collect::<HashSet<_>>();
        let mut allowed = HashSet::new();
        for path in requested {
            mobile_reading::validate_archive_path(&path)?;
            let entry = self.entries.get(&path).ok_or_else(|| {
                PlatformError::new("invalidImportPlan", "EPUB 图片资源不存在。", false)
            })?;
            if entry.directory || !is_raster(&path) {
                return Err(PlatformError::new(
                    "unsupportedEpubImage",
                    "EPUB 包含不受支持的图片资源；仅支持 JPG、PNG、GIF 和 WebP。",
                    false,
                ));
            }
            if entry.uncompressed_bytes > MAX_ASSET_BYTES {
                return Err(PlatformError::new(
                    "epubAssetTooLarge",
                    "EPUB 单张图片超过 64 MiB 限制。",
                    false,
                ));
            }
            allowed.insert(path);
        }
        let total = allowed.iter().try_fold(0_u64, |sum, path| {
            let size = self
                .entries
                .get(path)
                .map(|entry| entry.uncompressed_bytes)
                .unwrap_or(0);
            sum.checked_add(size)
                .filter(|value| *value <= MAX_EXTRACTED_ASSETS)
                .ok_or_else(|| {
                    PlatformError::new("epubExpandedTooLarge", "EPUB 图片资源解压后过大。", false)
                })
        })?;
        let free = available_space(&self.root).map_err(|_| PlatformError::storage_unavailable())?;
        if free < total.saturating_add(FREE_SPACE_RESERVE) {
            return Err(PlatformError::new(
                "storageFull",
                "设备空间不足，无法导入 EPUB。",
                false,
            ));
        }
        let assets_root = self.root.join("assets");
        fs::create_dir_all(&assets_root).map_err(|_| PlatformError::storage_unavailable())?;
        let mut archive = open_archive(&self.source)?;
        let mut sorted = allowed.iter().collect::<Vec<_>>();
        sorted.sort();
        for path in sorted {
            self.ensure_not_cancelled()?;
            let mut source = archive
                .by_name(path)
                .map_err(|_| PlatformError::new("invalidEpub", "EPUB 结构已损坏。", false))?;
            let destination = safe_destination(&assets_root, path)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
            }
            let temporary = destination.with_extension(format!(
                "{}.partial",
                destination
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("asset")
            ));
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| PlatformError::storage_unavailable())?;
            let mut buffer = [0_u8; 64 * 1024];
            let expected_bytes = self
                .entries
                .get(path)
                .map(|entry| entry.uncompressed_bytes)
                .ok_or_else(|| PlatformError::new("invalidEpub", "EPUB 图片资源不存在。", false))?;
            let mut written = 0_u64;
            loop {
                self.ensure_not_cancelled()?;
                let read = source
                    .read(&mut buffer)
                    .map_err(|_| PlatformError::storage_unavailable())?;
                if read == 0 {
                    break;
                }
                written = written
                    .checked_add(read as u64)
                    .filter(|value| *value <= expected_bytes)
                    .ok_or_else(|| {
                        PlatformError::new("invalidEpub", "EPUB 图片实际大小异常。", false)
                    })?;
                io::Write::write_all(&mut output, &buffer[..read])
                    .map_err(|_| PlatformError::storage_unavailable())?;
            }
            if written != expected_bytes {
                return Err(PlatformError::new(
                    "invalidEpub",
                    "EPUB 图片实际大小与中央目录不一致。",
                    false,
                ));
            }
            output
                .sync_all()
                .map_err(|_| PlatformError::storage_unavailable())?;
            drop(output);
            fs::rename(&temporary, &destination)
                .map_err(|_| PlatformError::storage_unavailable())?;
        }
        parsed.cover_path = parsed
            .cover_path
            .take()
            .filter(|path| allowed.contains(path));
        for article in parsed
            .sections
            .iter_mut()
            .flat_map(|section| section.articles.iter_mut())
            .chain(parsed.unsectioned_articles.iter_mut())
        {
            for block in &mut article.blocks {
                block.asset_path = block
                    .asset_path
                    .take()
                    .filter(|path| allowed.contains(path));
            }
        }
        parsed.asset_paths = allowed.into_iter().collect();
        parsed.asset_paths.sort();
        Ok(())
    }

    fn ensure_not_cancelled(&self) -> Result<(), PlatformError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(PlatformError::new(
                "importCancelled",
                "EPUB 导入已取消。",
                false,
            ))
        } else {
            Ok(())
        }
    }
}

pub fn cleanup_session(session: &EpubImportSession) {
    let _ = fs::remove_dir_all(&session.root);
}

fn validate_epub(
    path: &Path,
) -> Result<(u64, String, HashMap<String, EpubEntryInfo>), PlatformError> {
    let bytes = fs::metadata(path)
        .map_err(|_| PlatformError::storage_unavailable())?
        .len();
    if bytes == 0 || bytes > MAX_EPUB_BYTES {
        return Err(PlatformError::new(
            "epubTooLarge",
            "EPUB 为空或超过 500 MiB 限制。",
            false,
        ));
    }
    let mut source = File::open(path).map_err(|_| PlatformError::storage_unavailable())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| PlatformError::storage_unavailable())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let content_hash = hex::encode(digest.finalize());
    let mut archive = open_archive(path)?;
    if archive.len() > MAX_ENTRIES {
        return Err(PlatformError::new(
            "epubEntryLimit",
            "EPUB 内文件数量异常。",
            false,
        ));
    }
    let mut expanded = 0_u64;
    let mut entries = HashMap::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| PlatformError::new("invalidEpub", "EPUB 结构已损坏。", false))?;
        let raw_name = file.name().trim_end_matches('/').to_string();
        if raw_name.is_empty() && file.is_dir() {
            continue;
        }
        mobile_reading::validate_archive_path(&raw_name)?;
        if file.enclosed_name().is_none() || entries.contains_key(&raw_name) {
            return Err(PlatformError::new(
                "invalidArchive",
                "EPUB 包含重复或越界路径。",
                false,
            ));
        }
        expanded = expanded
            .checked_add(file.size())
            .filter(|value| *value <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| {
                PlatformError::new("epubExpandedTooLarge", "EPUB 解压后过大。", false)
            })?;
        if file.size() > 0
            && (file.compressed_size() == 0
                || file.size() > file.compressed_size().saturating_mul(MAX_COMPRESSION_RATIO))
        {
            return Err(PlatformError::new(
                "epubCompressionRatio",
                "EPUB 条目压缩比异常。",
                false,
            ));
        }
        if is_text_entry(&raw_name) && file.size() > MAX_TEXT_BYTES {
            return Err(PlatformError::new(
                "epubTextTooLarge",
                "EPUB 文本条目超过 16 MiB 限制。",
                false,
            ));
        }
        if is_raster(&raw_name) && file.size() > MAX_ASSET_BYTES {
            return Err(PlatformError::new(
                "epubAssetTooLarge",
                "EPUB 单张图片超过 64 MiB 限制。",
                false,
            ));
        }
        let info = EpubEntryInfo {
            path: raw_name.clone(),
            directory: file.is_dir(),
            compressed_bytes: file.compressed_size(),
            uncompressed_bytes: file.size(),
        };
        if !file.is_dir() {
            io::copy(&mut file, &mut io::sink())
                .map_err(|_| PlatformError::new("invalidEpub", "EPUB CRC 校验失败。", false))?;
        }
        entries.insert(raw_name, info);
    }
    if !entries.contains_key("META-INF/container.xml") {
        return Err(PlatformError::new(
            "invalidEpub",
            "EPUB 缺少 container.xml。",
            false,
        ));
    }
    Ok((bytes, content_hash, entries))
}

fn open_archive(path: &Path) -> Result<ZipArchive<File>, PlatformError> {
    ZipArchive::new(File::open(path).map_err(|_| PlatformError::storage_unavailable())?)
        .map_err(|_| PlatformError::new("invalidEpub", "无法打开 EPUB ZIP。", false))
}

fn safe_destination(root: &Path, archive_path: &str) -> Result<PathBuf, PlatformError> {
    mobile_reading::validate_archive_path(archive_path)?;
    let destination = archive_path
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    if !destination.starts_with(root) {
        return Err(PlatformError::new(
            "invalidArchive",
            "EPUB 资源路径越界。",
            false,
        ));
    }
    Ok(destination)
}

fn remove_private_root(path: &Path, root: &Path) -> Result<(), PlatformError> {
    if path.parent() != Some(root) {
        return Err(PlatformError::storage_unavailable());
    }
    fs::remove_dir_all(path)
        .or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|_| PlatformError::storage_unavailable())
}

fn require_uuid(value: &str) -> Result<(), PlatformError> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| PlatformError::new("invalidInput", "导入请求标识无效。", false))
}

fn safe_display_name(value: &str) -> String {
    let value = value.replace(['/', '\\', '\0'], "_");
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "publication.epub".into()
    } else {
        trimmed.chars().take(240).collect()
    }
}

fn is_text_entry(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "xml" | "opf" | "xhtml" | "html" | "htm" | "ncx"
    )
}

fn is_raster(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn fixture(path: &Path) {
        let file = File::create(path).expect("create");
        let mut zip = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("META-INF/container.xml", options)
            .expect("container");
        zip.write_all(b"<container/>").expect("write");
        zip.start_file("EPUB/article.xhtml", options)
            .expect("article");
        zip.write_all(b"<html><body>hello</body></html>")
            .expect("write");
        zip.finish().expect("finish");
    }

    #[test]
    fn matches_the_shared_epub_safety_policy() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/epub-safety-v1.json"))
                .expect("policy vector");
        assert_eq!(vector["sourceBytes"].as_u64(), Some(MAX_EPUB_BYTES));
        assert_eq!(vector["entries"].as_u64(), Some(MAX_ENTRIES as u64));
        assert_eq!(vector["expandedBytes"].as_u64(), Some(MAX_EXPANDED_BYTES));
        assert_eq!(vector["textEntryBytes"].as_u64(), Some(MAX_TEXT_BYTES));
        assert_eq!(vector["rasterEntryBytes"].as_u64(), Some(MAX_ASSET_BYTES));
        assert_eq!(
            vector["extractedRasterBytes"].as_u64(),
            Some(MAX_EXTRACTED_ASSETS)
        );
        assert_eq!(
            vector["compressionRatio"].as_u64(),
            Some(MAX_COMPRESSION_RATIO)
        );
    }

    #[test]
    fn validates_indexes_and_reads_only_text_entries() {
        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("source.epub");
        fixture(&source);
        let (bytes, hash, entries) = validate_epub(&source).expect("validate");
        let session = EpubImportSession {
            id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            display_name: "fixture.epub".into(),
            root: root.path().into(),
            source,
            bytes,
            content_hash: hash,
            entries,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        assert!(session
            .read_text("EPUB/article.xhtml")
            .expect("text")
            .contains("hello"));
        assert_eq!(session.entries().len(), 2);
    }

    #[test]
    fn observes_cancellation_during_commit() {
        let flag = Arc::new(AtomicBool::new(true));
        let session = EpubImportSession {
            id: "session".into(),
            request_id: "request".into(),
            display_name: "fixture.epub".into(),
            root: PathBuf::new(),
            source: PathBuf::new(),
            bytes: 0,
            content_hash: "a".repeat(64),
            entries: HashMap::new(),
            cancelled: flag,
        };
        assert_eq!(
            session.ensure_not_cancelled().expect_err("cancelled").code,
            "importCancelled"
        );
    }

    #[test]
    fn rejects_traversal_and_missing_container() {
        assert!(mobile_reading::validate_archive_path("../secret").is_err());
        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("invalid.epub");
        let file = File::create(&source).expect("create");
        let mut zip = ZipWriter::new(file);
        zip.start_file("only.txt", SimpleFileOptions::default())
            .expect("file");
        zip.write_all(b"no container").expect("write");
        zip.finish().expect("finish");
        assert_eq!(
            validate_epub(&source).expect_err("reject").code,
            "invalidEpub"
        );
    }

    #[test]
    fn serializes_import_boundary_in_camel_case() {
        let value = serde_json::to_value(BeginImportResult::Ready {
            session_id: "session".into(),
            display_name: "fixture.epub".into(),
            bytes: 42,
            content_hash: "a".repeat(64),
            entries: vec![EpubEntryInfo {
                path: "EPUB/article.xhtml".into(),
                directory: false,
                compressed_bytes: 10,
                uncompressed_bytes: 20,
            }],
        })
        .expect("serialize");
        assert_eq!(value["kind"], "ready");
        assert_eq!(value["sessionId"], "session");
        assert_eq!(value["contentHash"], "a".repeat(64));
        assert_eq!(value["entries"][0]["compressedBytes"], 10);
        assert!(value.get("session_id").is_none());
    }
}
