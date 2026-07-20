use crate::{platform_error::PlatformError, platform_paths::PlatformPaths};
use fs2::available_space;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use zip::ZipArchive;

const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;
const ONLINE_BUILD_REQUIRED_BYTES: u64 = 256 * 1024 * 1024;
const PACKAGE_DATABASE: &str = "ecdict-base.sqlite";
const FULL_PACKAGE_DATABASE: &str = "ecdict-full.sqlite";
const PACKAGE_MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictionaryPackManifest {
    pub format_version: u32,
    pub resource_schema_version: u32,
    pub profile: String,
    pub dataset_revision: String,
    pub entry_count: u64,
    pub form_count: u64,
    pub file_bytes: u64,
    pub sha256: String,
    pub lexeme_map_hash: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryPackStatus {
    pub installed: bool,
    pub profile: Option<String>,
    pub dataset_revision: Option<String>,
    pub entry_count: u64,
    pub form_count: u64,
    pub lexeme_map_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryLocalPackStatus {
    pub installed: bool,
    pub installing: bool,
    pub version: Option<String>,
    pub entry_count: u64,
    pub form_count: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryResourceStatus {
    pub provider_id: &'static str,
    pub installed: bool,
    pub base_installed: bool,
    pub full_extension_installed: bool,
    pub extension_compatible: bool,
    pub effective_profile: &'static str,
    pub installing: bool,
    pub base: DictionaryLocalPackStatus,
    pub full: DictionaryLocalPackStatus,
    pub version: Option<String>,
    pub entry_count: u64,
    pub form_count: u64,
    pub size_bytes: u64,
    pub source: &'static str,
    pub license: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryInstallPreflight {
    pub profile: String,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub can_install: bool,
}

impl DictionaryPackStatus {
    pub fn missing() -> Self {
        Self {
            installed: false,
            profile: None,
            dataset_revision: None,
            entry_count: 0,
            form_count: 0,
            lexeme_map_hash: None,
        }
    }
}

pub fn prepare(paths: &PlatformPaths) -> Result<(), PlatformError> {
    let staging = staging_root(paths);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|_| PlatformError::storage_unavailable())?;
    }
    fs::create_dir_all(&staging).map_err(|_| PlatformError::storage_unavailable())?;
    fs::create_dir_all(dictionaries_root(paths))
        .map_err(|_| PlatformError::storage_unavailable())?;
    recover_previous_generation(paths, ".ecdict-base.previous-", &installed_root(paths));
    recover_previous_generation(paths, ".ecdict-full.previous-", &installed_full_root(paths));
    Ok(())
}

pub fn prepare_install_destination(
    paths: &PlatformPaths,
    request_id: &str,
) -> Result<PathBuf, PlatformError> {
    require_uuid(request_id)?;
    let root = staging_root(paths).join(request_id);
    fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(root.join("source.fprdict"))
}

pub fn prepare_online_source_paths(
    paths: &PlatformPaths,
    request_id: &str,
) -> Result<(PathBuf, PathBuf), PlatformError> {
    require_uuid(request_id)?;
    let root = staging_root(paths).join(request_id);
    fs::create_dir_all(&root).map_err(|_| PlatformError::storage_unavailable())?;
    Ok((root.join("ecdict.csv"), root.join("lemma.en.txt")))
}

pub fn status(paths: &PlatformPaths) -> Result<DictionaryPackStatus, PlatformError> {
    fast_status(paths)
}

/// Reads only the small manifest and database file metadata. This function is safe for
/// navigation and point-lookup hot paths; it deliberately does not open SQLite.
pub fn fast_status(paths: &PlatformPaths) -> Result<DictionaryPackStatus, PlatformError> {
    let root = installed_root(paths);
    if !root.is_dir() {
        return Ok(DictionaryPackStatus::missing());
    }
    let manifest = read_manifest_file(&root.join(PACKAGE_MANIFEST))?;
    validate_manifest_for_profile(&manifest, "standard-v1", 4)?;
    verify_file_identity(&root.join(PACKAGE_DATABASE), &manifest)?;
    Ok(status_from_manifest(&manifest))
}

pub fn fast_resource_status(
    paths: &PlatformPaths,
    installing: bool,
) -> Result<DictionaryResourceStatus, PlatformError> {
    let base_manifest = read_optional_manifest(&installed_root(paths))?;
    let full_manifest = read_optional_manifest(&installed_full_root(paths))?;
    if let Some(manifest) = base_manifest.as_ref() {
        validate_manifest_for_profile(manifest, "standard-v1", 4)?;
        verify_file_identity(&installed_database_path(paths), manifest)?;
    }
    if let Some(manifest) = full_manifest.as_ref() {
        validate_manifest_for_profile(manifest, "full-extension-v1", 1)?;
        verify_file_identity(&installed_full_database_path(paths), manifest)?;
    }
    let compatible = matches!((&base_manifest, &full_manifest), (Some(base), Some(full))
        if base.dataset_revision == full.dataset_revision
            && base.lexeme_map_hash == full.lexeme_map_hash);
    let base = local_pack_status(base_manifest.as_ref(), installing);
    let full = local_pack_status(full_manifest.as_ref(), installing);
    let base_installed = base.installed;
    let full_extension_installed = full.installed;
    let effective_profile = if base_installed && compatible {
        "full"
    } else if base_installed {
        "standard"
    } else {
        "none"
    };
    let effective = if compatible {
        full_manifest.as_ref().or(base_manifest.as_ref())
    } else {
        base_manifest.as_ref()
    };
    Ok(DictionaryResourceStatus {
        provider_id: "ecdict",
        installed: base_installed,
        base_installed,
        full_extension_installed,
        extension_compatible: compatible,
        effective_profile,
        installing,
        version: effective.map(manifest_version),
        entry_count: effective.map_or(0, |manifest| manifest.entry_count),
        form_count: effective.map_or(0, |manifest| manifest.form_count),
        size_bytes: base.size_bytes.saturating_add(full.size_bytes),
        base,
        full,
        source: "https://github.com/skywind3000/ECDICT",
        license: "MIT",
    })
}

/// Performs the expensive integrity, row-count and lexeme-map verification. Callers must run
/// this in a blocking worker and never in a navigation or lookup request.
pub fn deep_verify(paths: &PlatformPaths) -> Result<DictionaryResourceStatus, PlatformError> {
    let status = fast_resource_status(paths, false)?;
    if status.base_installed {
        let manifest = read_manifest_file(&installed_root(paths).join(PACKAGE_MANIFEST))?;
        verify_database(&installed_database_path(paths), &manifest)?;
    }
    if status.full_extension_installed {
        let manifest = read_manifest_file(&installed_full_root(paths).join(PACKAGE_MANIFEST))?;
        verify_full_database(&installed_full_database_path(paths), &manifest)?;
    }
    Ok(status)
}

pub fn install_package(
    paths: &PlatformPaths,
    package: &Path,
) -> Result<DictionaryPackStatus, PlatformError> {
    let result = install_package_with_hook(paths, package, || Ok(()));
    if let Some(root) = package.parent() {
        let _ = fs::remove_dir_all(root);
    }
    result
}

pub fn install_full_package(
    paths: &PlatformPaths,
    package: &Path,
) -> Result<DictionaryPackStatus, PlatformError> {
    let result = install_full_package_inner(paths, package);
    if let Some(root) = package.parent() {
        let _ = fs::remove_dir_all(root);
    }
    result
}

fn install_full_package_inner(
    paths: &PlatformPaths,
    package: &Path,
) -> Result<DictionaryPackStatus, PlatformError> {
    validate_package_size(package)?;
    let session_root = package
        .parent()
        .ok_or_else(PlatformError::storage_unavailable)?;
    if session_root.parent() != Some(staging_root(paths).as_path()) {
        return Err(PlatformError::storage_unavailable());
    }
    let payload = session_root.join("full-payload");
    fs::create_dir_all(&payload).map_err(|_| PlatformError::storage_unavailable())?;
    let mut archive = open_package(package)?;
    validate_package_entries_for(&mut archive, FULL_PACKAGE_DATABASE)?;
    let manifest = read_package_manifest(&mut archive)?;
    validate_manifest_for_profile(&manifest, "full-extension-v1", 1)?;
    let base = fast_status(paths)?;
    if base.dataset_revision.as_deref() != Some(manifest.dataset_revision.as_str())
        || base.lexeme_map_hash.as_deref() != Some(manifest.lexeme_map_hash.as_str())
    {
        return Err(PlatformError::new(
            "dictionaryPackIncompatible",
            "完整词典扩展与已安装基础词典不兼容。",
            false,
        ));
    }
    let free = available_space(&paths.data).map_err(|_| PlatformError::storage_unavailable())?;
    if free < manifest.file_bytes.saturating_add(FREE_SPACE_RESERVE) {
        return Err(PlatformError::new(
            "dictionaryStorageFull",
            "设备空间不足，无法验证完整词典扩展。",
            false,
        ));
    }
    let database = payload.join(FULL_PACKAGE_DATABASE);
    extract_database_named(&mut archive, FULL_PACKAGE_DATABASE, &database, &manifest)?;
    verify_full_database(&database, &manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| invalid_pack("完整词典 manifest 无法序列化。"))?;
    write_synced(&payload.join(PACKAGE_MANIFEST), &manifest_bytes)?;
    publish_generation_at(paths, &payload, &installed_full_root(paths), ".ecdict-full")?;
    Ok(status_from_manifest(&manifest))
}

fn install_package_with_hook<F>(
    paths: &PlatformPaths,
    package: &Path,
    before_publish: F,
) -> Result<DictionaryPackStatus, PlatformError>
where
    F: FnOnce() -> Result<(), PlatformError>,
{
    validate_package_size(package)?;
    let session_root = package
        .parent()
        .ok_or_else(PlatformError::storage_unavailable)?;
    let staging = staging_root(paths);
    if session_root.parent() != Some(staging.as_path()) {
        return Err(PlatformError::storage_unavailable());
    }
    let payload = session_root.join("payload");
    fs::create_dir_all(&payload).map_err(|_| PlatformError::storage_unavailable())?;
    let mut archive = open_package(package)?;
    validate_package_entries(&mut archive)?;
    let manifest = read_package_manifest(&mut archive)?;
    validate_manifest(&manifest)?;
    let free = available_space(&paths.data).map_err(|_| PlatformError::storage_unavailable())?;
    if free < manifest.file_bytes.saturating_add(FREE_SPACE_RESERVE) {
        return Err(PlatformError::new(
            "dictionaryStorageFull",
            "设备空间不足，无法验证词典包。",
            false,
        ));
    }
    let database = payload.join(PACKAGE_DATABASE);
    extract_database(&mut archive, &database, &manifest)?;
    verify_database(&database, &manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| invalid_pack("词典包 manifest 无法序列化。"))?;
    write_synced(&payload.join(PACKAGE_MANIFEST), &manifest_bytes)?;
    before_publish()?;
    publish_generation(paths, &payload)?;
    Ok(status_from_manifest(&manifest))
}

pub fn cleanup_request(paths: &PlatformPaths, request_id: &str) {
    if uuid::Uuid::parse_str(request_id).is_ok() {
        let _ = fs::remove_dir_all(staging_root(paths).join(request_id));
    }
}

pub fn built_database_path(
    paths: &PlatformPaths,
    request_id: &str,
) -> Result<PathBuf, PlatformError> {
    require_uuid(request_id)?;
    let payload = staging_root(paths).join(request_id).join("payload");
    fs::create_dir_all(&payload).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(payload.join(PACKAGE_DATABASE))
}

pub fn publish_built_database(
    paths: &PlatformPaths,
    request_id: &str,
    dataset_revision: &str,
    entry_count: u64,
    form_count: u64,
    lexeme_map_hash: String,
) -> Result<DictionaryPackStatus, PlatformError> {
    require_uuid(request_id)?;
    let session_root = staging_root(paths).join(request_id);
    let payload = session_root.join("payload");
    let database = payload.join(PACKAGE_DATABASE);
    let bytes = fs::read(&database).map_err(|_| PlatformError::storage_unavailable())?;
    let manifest = DictionaryPackManifest {
        format_version: 1,
        resource_schema_version: 4,
        profile: "standard-v1".into(),
        dataset_revision: dataset_revision.into(),
        entry_count,
        form_count,
        file_bytes: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(&bytes)),
        lexeme_map_hash,
    };
    verify_database(&database, &manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| invalid_pack("词典 manifest 无法序列化。"))?;
    write_synced(&payload.join(PACKAGE_MANIFEST), &manifest_bytes)?;
    publish_generation(paths, &payload)?;
    let status = status_from_manifest(&manifest);
    let _ = fs::remove_dir_all(session_root);
    Ok(status)
}

pub fn ensure_online_build_space(paths: &PlatformPaths) -> Result<(), PlatformError> {
    let free = available_space(&paths.data).map_err(|_| PlatformError::storage_unavailable())?;
    if free < ONLINE_BUILD_REQUIRED_BYTES {
        Err(PlatformError::new(
            "dictionaryStorageFull",
            "设备至少需要 256 MiB 可用空间来预载词典。",
            false,
        ))
    } else {
        Ok(())
    }
}

/// Returns a best-effort capacity snapshot for the install UI. Filesystem probing failures are
/// represented as zero available bytes rather than surfaced as navigation-blocking errors.
pub fn install_preflight(paths: &PlatformPaths, profile: &str) -> DictionaryInstallPreflight {
    let required_bytes = ONLINE_BUILD_REQUIRED_BYTES;
    let available_bytes = available_space(&paths.data).unwrap_or(0);
    DictionaryInstallPreflight {
        profile: profile.to_string(),
        required_bytes,
        available_bytes,
        can_install: available_bytes >= required_bytes,
    }
}

pub fn installed_database_path(paths: &PlatformPaths) -> PathBuf {
    installed_root(paths).join(PACKAGE_DATABASE)
}

pub fn installed_full_database_path(paths: &PlatformPaths) -> PathBuf {
    installed_full_root(paths).join(FULL_PACKAGE_DATABASE)
}

pub fn built_full_database_path(
    paths: &PlatformPaths,
    request_id: &str,
) -> Result<PathBuf, PlatformError> {
    require_uuid(request_id)?;
    let payload = staging_root(paths).join(request_id).join("full-payload");
    fs::create_dir_all(&payload).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(payload.join(FULL_PACKAGE_DATABASE))
}

pub fn publish_built_full_database(
    paths: &PlatformPaths,
    request_id: &str,
    dataset_revision: &str,
    entry_count: u64,
    form_count: u64,
    lexeme_map_hash: String,
) -> Result<DictionaryPackStatus, PlatformError> {
    require_uuid(request_id)?;
    let session_root = staging_root(paths).join(request_id);
    let payload = session_root.join("full-payload");
    let database = payload.join(FULL_PACKAGE_DATABASE);
    let bytes = fs::read(&database).map_err(|_| PlatformError::storage_unavailable())?;
    let manifest = DictionaryPackManifest {
        format_version: 1,
        resource_schema_version: 1,
        profile: "full-extension-v1".into(),
        dataset_revision: dataset_revision.into(),
        entry_count,
        form_count,
        file_bytes: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(&bytes)),
        lexeme_map_hash,
    };
    verify_full_database(&database, &manifest)?;
    let base = fast_status(paths)?;
    if base.dataset_revision.as_deref() != Some(dataset_revision)
        || base.lexeme_map_hash.as_deref() != Some(manifest.lexeme_map_hash.as_str())
    {
        return Err(PlatformError::new(
            "dictionaryPackIncompatible",
            "完整词典扩展与已安装基础词典不兼容。",
            false,
        ));
    }
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| invalid_pack("完整词典 manifest 无法序列化。"))?;
    write_synced(&payload.join(PACKAGE_MANIFEST), &manifest_bytes)?;
    publish_generation_at(paths, &payload, &installed_full_root(paths), ".ecdict-full")?;
    Ok(status_from_manifest(&manifest))
}

pub fn remove(paths: &PlatformPaths) -> Result<(), PlatformError> {
    let installed = installed_root(paths);
    if !installed.exists() {
        return Ok(());
    }
    let removing =
        dictionaries_root(paths).join(format!(".ecdict-base.removing-{}", uuid::Uuid::new_v4()));
    fs::rename(&installed, &removing).map_err(|_| PlatformError::storage_unavailable())?;
    fs::remove_dir_all(removing).map_err(|_| PlatformError::storage_unavailable())?;
    sync_parent(&dictionaries_root(paths));
    Ok(())
}

pub fn remove_full(paths: &PlatformPaths) -> Result<(), PlatformError> {
    remove_generation(paths, &installed_full_root(paths), ".ecdict-full")
}

fn publish_generation(paths: &PlatformPaths, payload: &Path) -> Result<(), PlatformError> {
    publish_generation_at(paths, payload, &installed_root(paths), ".ecdict-base")
}

fn publish_generation_at(
    paths: &PlatformPaths,
    payload: &Path,
    destination: &Path,
    prefix: &str,
) -> Result<(), PlatformError> {
    let backup =
        dictionaries_root(paths).join(format!("{prefix}.previous-{}", uuid::Uuid::new_v4()));
    let had_existing = destination.exists();
    if had_existing {
        fs::rename(destination, &backup).map_err(|_| PlatformError::storage_unavailable())?;
    }
    if let Err(error) = fs::rename(payload, destination) {
        if had_existing {
            let _ = fs::rename(&backup, destination);
        }
        return Err(if error.kind() == io::ErrorKind::NotFound {
            invalid_pack("词典包 staging 已失效。")
        } else {
            PlatformError::storage_unavailable()
        });
    }
    sync_parent(&dictionaries_root(paths));
    if had_existing {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn remove_generation(
    paths: &PlatformPaths,
    installed: &Path,
    prefix: &str,
) -> Result<(), PlatformError> {
    if !installed.exists() {
        return Ok(());
    }
    let removing =
        dictionaries_root(paths).join(format!("{prefix}.removing-{}", uuid::Uuid::new_v4()));
    fs::rename(installed, &removing).map_err(|_| PlatformError::storage_unavailable())?;
    fs::remove_dir_all(removing).map_err(|_| PlatformError::storage_unavailable())?;
    sync_parent(&dictionaries_root(paths));
    Ok(())
}

fn validate_package_size(path: &Path) -> Result<(), PlatformError> {
    let bytes = fs::metadata(path)
        .map_err(|_| invalid_pack("未找到词典包。"))?
        .len();
    if bytes == 0 || bytes > MAX_PACKAGE_BYTES {
        return Err(invalid_pack("词典包为空或超过 512 MiB 限制。"));
    }
    Ok(())
}

fn open_package(path: &Path) -> Result<ZipArchive<File>, PlatformError> {
    ZipArchive::new(File::open(path).map_err(|_| invalid_pack("无法读取词典包。"))?)
        .map_err(|_| invalid_pack("词典包不是有效 ZIP。"))
}

fn validate_package_entries(archive: &mut ZipArchive<File>) -> Result<(), PlatformError> {
    validate_package_entries_for(archive, PACKAGE_DATABASE)
}

fn validate_package_entries_for(
    archive: &mut ZipArchive<File>,
    database_name: &str,
) -> Result<(), PlatformError> {
    if archive.len() != 2 {
        return Err(invalid_pack("词典包文件清单无效。"));
    }
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| invalid_pack("词典包结构已损坏。"))?;
        if file.is_dir()
            || file.enclosed_name().is_none()
            || (file.name() != PACKAGE_MANIFEST && file.name() != database_name)
        {
            return Err(invalid_pack("词典包包含未授权路径。"));
        }
    }
    Ok(())
}

fn read_package_manifest(
    archive: &mut ZipArchive<File>,
) -> Result<DictionaryPackManifest, PlatformError> {
    let mut file = archive
        .by_name(PACKAGE_MANIFEST)
        .map_err(|_| invalid_pack("词典包缺少 manifest.json。"))?;
    if file.size() == 0 || file.size() > MAX_MANIFEST_BYTES {
        return Err(invalid_pack("词典包 manifest 大小无效。"));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| invalid_pack("词典包 manifest 已损坏。"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_pack("词典包 manifest 无效。"))
}

fn read_manifest_file(path: &Path) -> Result<DictionaryPackManifest, PlatformError> {
    let bytes = fs::read(path).map_err(|_| invalid_pack("已安装词典 manifest 缺失。"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(invalid_pack("已安装词典 manifest 无效。"));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_pack("已安装词典 manifest 无效。"))
}

fn read_optional_manifest(root: &Path) -> Result<Option<DictionaryPackManifest>, PlatformError> {
    if !root.is_dir() {
        return Ok(None);
    }
    read_manifest_file(&root.join(PACKAGE_MANIFEST)).map(Some)
}

fn validate_manifest(manifest: &DictionaryPackManifest) -> Result<(), PlatformError> {
    validate_manifest_for_profile(manifest, "standard-v1", 4)
}

fn validate_manifest_for_profile(
    manifest: &DictionaryPackManifest,
    expected_profile: &str,
    expected_schema: u32,
) -> Result<(), PlatformError> {
    if manifest.format_version != 1
        || manifest.resource_schema_version != expected_schema
        || manifest.profile != expected_profile
        || manifest.dataset_revision.is_empty()
        || manifest.dataset_revision.len() > 160
        || manifest.entry_count == 0
        || manifest.file_bytes == 0
        || manifest.file_bytes > MAX_PACKAGE_BYTES
        || !is_hash(&manifest.sha256)
        || !is_hash(&manifest.lexeme_map_hash)
    {
        return Err(PlatformError::new(
            "dictionaryPackIncompatible",
            "词典包版本或 manifest 不兼容。",
            false,
        ));
    }
    Ok(())
}

fn verify_file_identity(
    path: &Path,
    manifest: &DictionaryPackManifest,
) -> Result<(), PlatformError> {
    let metadata = fs::metadata(path).map_err(|_| invalid_pack("已安装词典数据库缺失。"))?;
    if !metadata.is_file() || metadata.len() != manifest.file_bytes {
        return Err(invalid_pack("已安装词典数据库大小与 manifest 不一致。"));
    }
    Ok(())
}

fn extract_database(
    archive: &mut ZipArchive<File>,
    destination: &Path,
    manifest: &DictionaryPackManifest,
) -> Result<(), PlatformError> {
    extract_database_named(archive, PACKAGE_DATABASE, destination, manifest)
}

fn extract_database_named(
    archive: &mut ZipArchive<File>,
    database_name: &str,
    destination: &Path,
    manifest: &DictionaryPackManifest,
) -> Result<(), PlatformError> {
    let mut source = archive
        .by_name(database_name)
        .map_err(|_| invalid_pack("词典包缺少基础数据库。"))?;
    if source.size() != manifest.file_bytes {
        return Err(invalid_pack("词典数据库大小与 manifest 不一致。"));
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| invalid_pack("词典数据库解压失败。"))?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(read as u64)
            .filter(|value| *value <= manifest.file_bytes)
            .ok_or_else(|| invalid_pack("词典数据库展开量无效。"))?;
        digest.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    output
        .sync_all()
        .map_err(|_| PlatformError::storage_unavailable())?;
    if copied != manifest.file_bytes || hex::encode(digest.finalize()) != manifest.sha256 {
        return Err(invalid_pack("词典数据库摘要与 manifest 不一致。"));
    }
    Ok(())
}

fn verify_database(path: &Path, manifest: &DictionaryPackManifest) -> Result<(), PlatformError> {
    validate_manifest(manifest)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| invalid_pack("词典数据库无法只读打开。"))?;
    let quick: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| invalid_pack("词典数据库完整性检查失败。"))?;
    if quick != "ok" {
        return Err(invalid_pack("词典数据库完整性检查失败。"));
    }
    for (key, expected) in [
        ("provider", "ecdict".to_string()),
        (
            "schemaVersion",
            manifest.resource_schema_version.to_string(),
        ),
        ("indexProfile", manifest.profile.clone()),
        ("datasetRevision", manifest.dataset_revision.clone()),
        ("lexemeMapHash", manifest.lexeme_map_hash.clone()),
        ("entryCount", manifest.entry_count.to_string()),
        ("formCount", manifest.form_count.to_string()),
    ] {
        let value: String = connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(|_| invalid_pack("词典数据库 metadata 缺失。"))?;
        if value != expected {
            return Err(invalid_pack("词典数据库 metadata 与 manifest 不一致。"));
        }
    }
    let entry_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM lexemes", [], |row| row.get(0))
        .map_err(|_| invalid_pack("词典数据库 lexemes 无效。"))?;
    let form_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM forms", [], |row| row.get(0))
        .map_err(|_| invalid_pack("词典数据库 forms 无效。"))?;
    if entry_count < 0
        || form_count < 0
        || entry_count as u64 != manifest.entry_count
        || form_count as u64 != manifest.form_count
    {
        return Err(invalid_pack("词典数据库计数与 manifest 不一致。"));
    }
    let mut statement = connection
        .prepare("SELECT lexeme_id,normalized FROM lexemes ORDER BY lexeme_id")
        .map_err(|_| invalid_pack("词典数据库词元映射无效。"))?;
    let mut rows = statement
        .query([])
        .map_err(|_| invalid_pack("词典数据库词元映射无效。"))?;
    let mut digest = Sha256::new();
    while let Some(row) = rows
        .next()
        .map_err(|_| invalid_pack("词典数据库词元映射无效。"))?
    {
        let id: i64 = row
            .get(0)
            .map_err(|_| invalid_pack("词典数据库词元映射无效。"))?;
        let normalized: String = row
            .get(1)
            .map_err(|_| invalid_pack("词典数据库词元映射无效。"))?;
        digest.update(format!("{id}\u{1f}{normalized}\n").as_bytes());
    }
    if hex::encode(digest.finalize()) != manifest.lexeme_map_hash {
        return Err(invalid_pack("词典数据库词元映射摘要无效。"));
    }
    Ok(())
}

fn verify_full_database(
    path: &Path,
    manifest: &DictionaryPackManifest,
) -> Result<(), PlatformError> {
    validate_manifest_for_profile(manifest, "full-extension-v1", 1)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| invalid_pack("完整词典数据库无法只读打开。"))?;
    let quick: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| invalid_pack("完整词典数据库完整性检查失败。"))?;
    if quick != "ok" {
        return Err(invalid_pack("完整词典数据库完整性检查失败。"));
    }
    for (key, expected) in [
        ("provider", "ecdict".to_string()),
        ("schemaVersion", "1".to_string()),
        ("indexProfile", "full-extension-v1".to_string()),
        ("datasetRevision", manifest.dataset_revision.clone()),
        ("lexemeMapHash", manifest.lexeme_map_hash.clone()),
        ("entryCount", manifest.entry_count.to_string()),
        ("formCount", manifest.form_count.to_string()),
    ] {
        let value: String = connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(|_| invalid_pack("完整词典数据库 metadata 缺失。"))?;
        if value != expected {
            return Err(invalid_pack("完整词典数据库 metadata 与 manifest 不一致。"));
        }
    }
    for table in [
        "full_entries",
        "extra_lexemes",
        "extra_entries",
        "extra_entries_fts",
        "extra_tags",
        "extra_forms",
    ] {
        let found: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| invalid_pack("完整词典数据库结构无效。"))?;
        if found != 1 {
            return Err(invalid_pack("完整词典数据库结构无效。"));
        }
    }
    Ok(())
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| PlatformError::storage_unavailable())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| PlatformError::storage_unavailable())
}

fn status_from_manifest(manifest: &DictionaryPackManifest) -> DictionaryPackStatus {
    DictionaryPackStatus {
        installed: true,
        profile: Some(manifest.profile.clone()),
        dataset_revision: Some(manifest.dataset_revision.clone()),
        entry_count: manifest.entry_count,
        form_count: manifest.form_count,
        lexeme_map_hash: Some(manifest.lexeme_map_hash.clone()),
    }
}

fn local_pack_status(
    manifest: Option<&DictionaryPackManifest>,
    installing: bool,
) -> DictionaryLocalPackStatus {
    DictionaryLocalPackStatus {
        installed: manifest.is_some(),
        installing,
        version: manifest.map(manifest_version),
        entry_count: manifest.map_or(0, |value| value.entry_count),
        form_count: manifest.map_or(0, |value| value.form_count),
        size_bytes: manifest.map_or(0, |value| value.file_bytes),
    }
}

fn manifest_version(manifest: &DictionaryPackManifest) -> String {
    manifest.dataset_revision.chars().take(12).collect()
}

fn dictionaries_root(paths: &PlatformPaths) -> PathBuf {
    paths.data.join("dictionaries")
}

fn installed_root(paths: &PlatformPaths) -> PathBuf {
    dictionaries_root(paths).join("ecdict-base")
}

fn installed_full_root(paths: &PlatformPaths) -> PathBuf {
    dictionaries_root(paths).join("ecdict-full")
}

fn staging_root(paths: &PlatformPaths) -> PathBuf {
    paths.persistent_staging.join("dictionary-packs")
}

fn recover_previous_generation(paths: &PlatformPaths, prefix: &str, destination: &Path) {
    let mut previous = fs::read_dir(dictionaries_root(paths))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    previous.sort();
    if !destination.exists() {
        if let Some(candidate) = previous.pop() {
            let _ = fs::rename(candidate, destination);
        }
    }
    for stale in previous {
        let _ = fs::remove_dir_all(stale);
    }
}

fn sync_parent(parent: &Path) {
    if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
        let _ = directory.sync_all();
    }
}

fn require_uuid(value: &str) -> Result<(), PlatformError> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| PlatformError::new("invalidInput", "词典安装请求标识无效。", false))
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn invalid_pack(message: &'static str) -> PlatformError {
    PlatformError::new("dictionaryPackInvalid", message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning_contract::create_lexeme_key;
    use rusqlite::params;
    use std::io::{Seek, SeekFrom};
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn paths(root: &Path) -> PlatformPaths {
        let paths = PlatformPaths::new(root.join("data"), root.join("cache"), root.join("logs"));
        paths.prepare().expect("paths");
        prepare(&paths).expect("dictionary paths");
        paths
    }

    fn package(
        paths: &PlatformPaths,
        request: &str,
        revision: &str,
        corrupt_hash: bool,
    ) -> PathBuf {
        let package = prepare_install_destination(paths, request).expect("destination");
        let root = tempfile::tempdir().expect("database root");
        let database = root.path().join(PACKAGE_DATABASE);
        let connection = Connection::open(&database).expect("database");
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 CREATE TABLE lexemes(lexeme_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL UNIQUE,normalized TEXT NOT NULL);
                 CREATE TABLE forms(form TEXT NOT NULL,lexeme_id INTEGER NOT NULL);",
            )
            .expect("schema");
        let key = create_lexeme_key("en", "run");
        connection
            .execute("INSERT INTO lexemes VALUES(1,?1,'run')", params![key])
            .expect("lexeme");
        connection
            .execute("INSERT INTO forms VALUES('running',1)", [])
            .expect("form");
        let map_hash = hex::encode(Sha256::digest(b"1\x1frun\n"));
        for (name, value) in [
            ("provider", "ecdict".to_string()),
            ("schemaVersion", "4".into()),
            ("indexProfile", "standard-v1".into()),
            ("datasetRevision", revision.into()),
            ("lexemeMapHash", map_hash.clone()),
            ("entryCount", "1".into()),
            ("formCount", "1".into()),
        ] {
            connection
                .execute("INSERT INTO metadata VALUES(?1,?2)", params![name, value])
                .expect("metadata");
        }
        drop(connection);
        let bytes = fs::read(&database).expect("database bytes");
        let manifest = DictionaryPackManifest {
            format_version: 1,
            resource_schema_version: 4,
            profile: "standard-v1".into(),
            dataset_revision: revision.into(),
            entry_count: 1,
            form_count: 1,
            file_bytes: bytes.len() as u64,
            sha256: if corrupt_hash {
                "0".repeat(64)
            } else {
                hex::encode(Sha256::digest(&bytes))
            },
            lexeme_map_hash: map_hash,
        };
        let output = File::create(&package).expect("package");
        let mut zip = ZipWriter::new(output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(PACKAGE_MANIFEST, options)
            .expect("manifest file");
        zip.write_all(&serde_json::to_vec(&manifest).expect("manifest"))
            .expect("manifest bytes");
        zip.start_file(PACKAGE_DATABASE, options)
            .expect("database file");
        zip.write_all(&bytes).expect("database bytes");
        zip.finish().expect("finish");
        package
    }

    #[test]
    fn installs_and_validates_a_versioned_pack() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let request = uuid::Uuid::new_v4().to_string();
        let package = package(&paths, &request, "fixture-a", false);
        let installed = install_package(&paths, &package).expect("install");
        assert!(installed.installed);
        assert_eq!(installed.dataset_revision.as_deref(), Some("fixture-a"));
        assert_eq!(status(&paths).expect("status"), installed);
    }

    #[test]
    fn invalid_replacement_preserves_the_previous_pack() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let first_id = uuid::Uuid::new_v4().to_string();
        install_package(&paths, &package(&paths, &first_id, "fixture-a", false)).expect("first");
        let invalid_id = uuid::Uuid::new_v4().to_string();
        let error = install_package(&paths, &package(&paths, &invalid_id, "fixture-b", true))
            .expect_err("invalid");
        assert_eq!(error.code, "dictionaryPackInvalid");
        assert_eq!(
            status(&paths).expect("status").dataset_revision.as_deref(),
            Some("fixture-a")
        );
    }

    #[test]
    fn publish_hook_failure_preserves_the_previous_pack() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let first_id = uuid::Uuid::new_v4().to_string();
        install_package(&paths, &package(&paths, &first_id, "fixture-a", false)).expect("first");
        let next_id = uuid::Uuid::new_v4().to_string();
        let next = package(&paths, &next_id, "fixture-b", false);
        let error =
            install_package_with_hook(&paths, &next, || Err(PlatformError::storage_unavailable()))
                .expect_err("fail before publish");
        assert_eq!(error.code, "storageUnavailable");
        assert_eq!(
            status(&paths).expect("status").dataset_revision.as_deref(),
            Some("fixture-a")
        );
    }

    #[test]
    fn fast_status_never_runs_database_integrity_or_lexeme_hash_scans() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let request = uuid::Uuid::new_v4().to_string();
        install_package(&paths, &package(&paths, &request, "fixture-a", false)).expect("install");
        let database = installed_database_path(&paths);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&database)
            .expect("open installed database");
        file.seek(SeekFrom::Start(0)).expect("seek");
        file.write_all(b"BROKEN!!").expect("corrupt header");
        file.sync_all().expect("sync corruption");

        assert!(fast_status(&paths).expect("fast status").installed);
        assert!(deep_verify(&paths).is_err());
    }

    #[test]
    fn install_preflight_matches_the_online_build_capacity_gate() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let preflight = install_preflight(&paths, "full");
        assert_eq!(preflight.profile, "full");
        assert_eq!(preflight.required_bytes, 256 * 1024 * 1024);
        assert_eq!(
            preflight.can_install,
            preflight.available_bytes >= preflight.required_bytes
        );
    }

    #[test]
    fn publishes_only_a_full_extension_compatible_with_the_installed_base() {
        let root = tempfile::tempdir().expect("root");
        let paths = paths(root.path());
        let base_request = uuid::Uuid::new_v4().to_string();
        let base = install_package(&paths, &package(&paths, &base_request, "fixture-a", false))
            .expect("install base");
        let full_request = uuid::Uuid::new_v4().to_string();
        let database = built_full_database_path(&paths, &full_request).expect("full path");
        let connection = Connection::open(&database).expect("open full");
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 CREATE TABLE full_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT NOT NULL,definition TEXT,detail TEXT);
                 CREATE TABLE extra_lexemes(lexeme_key TEXT PRIMARY KEY,lemma TEXT,normalized TEXT);
                 CREATE TABLE extra_entries(entry_id INTEGER PRIMARY KEY,lexeme_key TEXT);
                 CREATE VIRTUAL TABLE extra_entries_fts USING fts5(cjk_tokens,content='',columnsize=0);
                 CREATE TABLE extra_tags(lexeme_key TEXT,tag TEXT);
                 CREATE TABLE extra_forms(form TEXT,lexeme_key TEXT);",
            )
            .expect("full schema");
        for (key, value) in [
            ("provider", "ecdict".to_string()),
            ("schemaVersion", "1".into()),
            ("indexProfile", "full-extension-v1".into()),
            ("datasetRevision", "fixture-a".into()),
            (
                "lexemeMapHash",
                base.lexeme_map_hash.clone().expect("base hash"),
            ),
            ("entryCount", "1".into()),
            ("formCount", "1".into()),
        ] {
            connection
                .execute("INSERT INTO metadata VALUES(?1,?2)", params![key, value])
                .expect("full metadata");
        }
        drop(connection);
        publish_built_full_database(
            &paths,
            &full_request,
            "fixture-a",
            1,
            1,
            base.lexeme_map_hash.expect("base hash"),
        )
        .expect("publish full");
        let status = fast_resource_status(&paths, false).expect("resource status");
        assert!(status.extension_compatible);
        assert_eq!(status.effective_profile, "full");
        let incompatible_request = uuid::Uuid::new_v4().to_string();
        let incompatible = built_full_database_path(&paths, &incompatible_request)
            .expect("incompatible full path");
        fs::copy(installed_full_database_path(&paths), &incompatible).expect("copy installed full");
        let connection = Connection::open(&incompatible).expect("open incompatible full");
        let incompatible_hash = "0".repeat(64);
        connection
            .execute(
                "UPDATE metadata SET value='fixture-b' WHERE key='datasetRevision'",
                [],
            )
            .expect("replace revision");
        connection
            .execute(
                "UPDATE metadata SET value=?1 WHERE key='lexemeMapHash'",
                [&incompatible_hash],
            )
            .expect("replace map hash");
        drop(connection);
        assert_eq!(
            publish_built_full_database(
                &paths,
                &incompatible_request,
                "fixture-b",
                1,
                1,
                incompatible_hash,
            )
            .expect_err("reject incompatible replacement")
            .code,
            "dictionaryPackIncompatible"
        );
        assert!(
            fast_resource_status(&paths, false)
                .expect("previous full retained")
                .extension_compatible
        );
        remove_full(&paths).expect("remove full");
        assert_eq!(
            fast_resource_status(&paths, false)
                .expect("standard status")
                .effective_profile,
            "standard"
        );
    }
}
