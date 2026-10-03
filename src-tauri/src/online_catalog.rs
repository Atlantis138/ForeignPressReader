use crate::{
    atomic_file::atomic_replace, platform_error::PlatformError, platform_paths::PlatformPaths,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

const API: &str = "https://api.github.com/repos/hehonghui/awesome-english-ebooks";
const MAX_JSON: usize = 2 * 1024 * 1024;
const MAX_EPUB: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineIssue {
    pub id: String,
    pub date: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineCatalog {
    pub revision: String,
    pub fetched_at: String,
    pub issues: Vec<OnlineIssue>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Default)]
pub struct CatalogRuntime {
    pub catalog_lock: tokio::sync::Mutex<()>,
    request: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

impl CatalogRuntime {
    pub fn begin(&self, request: &str) -> Result<Arc<AtomicBool>, PlatformError> {
        if uuid::Uuid::parse_str(request).is_err() {
            return Err(invalid());
        }
        let mut active = self
            .request
            .lock()
            .map_err(|_| PlatformError::storage_unavailable())?;
        if active.is_some() {
            return Err(PlatformError::new(
                "importBusy",
                "已有刊物正在下载。",
                false,
            ));
        }
        let token = Arc::new(AtomicBool::new(false));
        *active = Some((request.to_owned(), token.clone()));
        Ok(token)
    }
    pub fn cancel(&self, request: &str) {
        if let Ok(active) = self.request.lock() {
            if let Some((id, token)) = active.as_ref() {
                if id == request {
                    token.store(true, Ordering::Release);
                }
            }
        }
    }
    pub fn finish(&self) {
        if let Ok(mut active) = self.request.lock() {
            *active = None;
        }
    }
}

pub fn valid_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn issue_date(path: &str) -> Option<String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 2
        || parts[..parts.len() - 2]
            .iter()
            .any(|p| p.len() != 4 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let date = parts[parts.len() - 2].strip_prefix("te_")?;
    if date.len() != 10 || parts.last()? != &format!("TheEconomist.{date}.epub") {
        return None;
    }
    let parsed = NaiveDate::parse_from_str(date, "%Y.%m.%d").ok()?;
    if parsed.format("%Y.%m.%d").to_string() != date {
        return None;
    }
    Some(parsed.format("%Y-%m-%d").to_string())
}

pub fn parse_tree(value: &Value) -> Result<Vec<OnlineIssue>, PlatformError> {
    let tree = value["tree"].as_array().ok_or_else(invalid)?;
    if value["truncated"].as_bool() != Some(false) || tree.len() > 10_000 {
        return Err(invalid());
    }
    let mut issues: BTreeMap<String, OnlineIssue> = BTreeMap::new();
    for entry in tree {
        let (Some(path), Some(id), Some(bytes)) = (
            entry["path"].as_str(),
            entry["sha"].as_str(),
            entry["size"].as_u64(),
        ) else {
            continue;
        };
        let Some(date) = issue_date(path) else {
            continue;
        };
        if entry["type"] != "blob"
            || !matches!(entry["mode"].as_str(), Some("100644" | "100755"))
            || !valid_sha(id)
            || bytes == 0
            || bytes > MAX_EPUB
        {
            continue;
        }
        if issues
            .get(&date)
            .is_some_and(|previous| previous.path.as_str() <= path)
        {
            continue;
        }
        issues.insert(
            date.clone(),
            OnlineIssue {
                id: id.into(),
                date,
                path: path.into(),
                bytes,
            },
        );
    }
    if issues.is_empty() || issues.len() > 2_000 {
        return Err(invalid());
    }
    Ok(issues.into_values().rev().collect())
}

fn valid_catalog(catalog: &OnlineCatalog) -> bool {
    valid_sha(&catalog.revision)
        && DateTime::parse_from_rfc3339(&catalog.fetched_at).is_ok()
        && !catalog.issues.is_empty()
        && catalog.issues.len() <= 2_000
        && catalog.issues.iter().all(|i| {
            valid_sha(&i.id)
                && issue_date(&i.path).as_deref() == Some(&i.date)
                && i.bytes > 0
                && i.bytes <= MAX_EPUB
        })
}

fn client() -> Result<reqwest::Client, PlatformError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("ForeignPressReader")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| network_error())
}

async fn json(client: &reqwest::Client, endpoint: &str) -> Result<Value, PlatformError> {
    let mut response = client
        .get(format!("{API}{endpoint}"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| network_error())?;
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err(PlatformError::new(
            "catalogRateLimited",
            "GitHub 请求较频繁，请稍后再刷新。",
            true,
        ));
    }
    if !response.status().is_success() {
        return Err(network_error());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if bytes.len() + chunk.len() > MAX_JSON {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

async fn fetch_catalog() -> Result<OnlineCatalog, PlatformError> {
    let client = client()?;
    let branch = json(&client, "/branches/master").await?;
    let revision = branch["commit"]["sha"]
        .as_str()
        .filter(|s| valid_sha(s))
        .ok_or_else(invalid)?;
    let tree_sha = branch["commit"]["commit"]["tree"]["sha"]
        .as_str()
        .filter(|s| valid_sha(s))
        .ok_or_else(invalid)?;
    let root = json(&client, &format!("/git/trees/{tree_sha}")).await?;
    if root["truncated"].as_bool() != Some(false) {
        return Err(invalid());
    }
    let folder = root["tree"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|e| e["path"] == "01_economist" && e["type"] == "tree")
        .ok_or_else(invalid)?;
    let folder_sha = folder["sha"]
        .as_str()
        .filter(|s| valid_sha(s))
        .ok_or_else(invalid)?;
    let issues =
        parse_tree(&json(&client, &format!("/git/trees/{folder_sha}?recursive=1")).await?)?;
    Ok(OnlineCatalog {
        revision: revision.into(),
        fetched_at: Utc::now().to_rfc3339(),
        issues,
        stale: false,
        notice: None,
    })
}

pub async fn load_catalog(
    paths: &PlatformPaths,
    refresh: bool,
) -> Result<OnlineCatalog, PlatformError> {
    let path = paths.cache.join("online-catalog/economist-v1.json");
    let cached = fs::metadata(&path)
        .ok()
        .filter(|m| m.len() <= MAX_JSON as u64)
        .and_then(|_| fs::read(&path).ok())
        .and_then(|bytes| serde_json::from_slice::<OnlineCatalog>(&bytes).ok())
        .filter(valid_catalog);
    if !refresh {
        if let Some(catalog) = &cached {
            let age = Utc::now()
                .signed_duration_since(
                    DateTime::parse_from_rfc3339(&catalog.fetched_at).map_err(|_| invalid())?,
                )
                .num_seconds();
            if (0..3600).contains(&age) {
                return Ok(catalog.clone());
            }
        }
    }
    match fetch_catalog().await {
        Ok(catalog) => {
            if let Ok(bytes) = serde_json::to_vec(&catalog) {
                let _ = atomic_replace(&path, &bytes);
            }
            Ok(catalog)
        }
        Err(error) => match cached {
            Some(mut cached) => {
                cached.stale = true;
                cached.notice = Some(format!("{} 当前显示上次保存的列表。", error.message));
                Ok(cached)
            }
            None => Err(error),
        },
    }
}

pub fn local_issue<'a>(
    publications: &'a [crate::mobile_reading::PublicationSummary],
    date: &str,
) -> Option<&'a crate::mobile_reading::PublicationSummary> {
    let title = format!("theeconomist.{}", date.replace('-', "."));
    publications.iter().find(|p| {
        p.original_title
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase()
            == title
    })
}

pub async fn cancellable<T>(
    token: &AtomicBool,
    future: impl std::future::Future<Output = Result<T, PlatformError>>,
) -> Result<T, PlatformError> {
    tokio::pin!(future);
    loop {
        if token.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        tokio::select! { result = &mut future => return result, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
    }
}

pub async fn download(
    catalog: &OnlineCatalog,
    issue: &OnlineIssue,
    destination: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), PlatformError> {
    if !valid_catalog(catalog)
        || !valid_sha(&issue.id)
        || issue_date(&issue.path).as_deref() != Some(&issue.date)
    {
        return Err(invalid());
    }
    let parent = destination
        .parent()
        .ok_or_else(PlatformError::storage_unavailable)?;
    if fs2::available_space(parent).map_err(|_| PlatformError::storage_unavailable())?
        < issue.bytes + 64 * 1024 * 1024
    {
        return Err(PlatformError::new(
            "storageFull",
            "本机空间不足，无法下载期刊。",
            true,
        ));
    }
    let url = format!(
        "https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/{}/01_economist/{}",
        catalog.revision, issue.path
    );
    progress(0, issue.bytes);
    let mut response = client()?
        .get(url)
        .send()
        .await
        .map_err(|_| network_error())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len != issue.bytes)
    {
        return Err(network_error());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(|_| PlatformError::storage_unavailable())?;
    let mut received = 0;
    let mut reported = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        received += chunk.len() as u64;
        if received > issue.bytes {
            return Err(invalid());
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| PlatformError::storage_unavailable())?;
        if reported.elapsed() > Duration::from_millis(150) || received == issue.bytes {
            progress(received, issue.bytes);
            reported = std::time::Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|_| PlatformError::storage_unavailable())?;
    if received != issue.bytes {
        return Err(network_error());
    }
    Ok(())
}

pub fn invalid() -> PlatformError {
    PlatformError::new(
        "catalogInvalid",
        "期刊目录不完整或来源已变化，请刷新后重试。",
        true,
    )
}
fn network_error() -> PlatformError {
    PlatformError::new(
        "catalogNetwork",
        "连接期刊来源失败或超时，请检查网络后重试。",
        true,
    )
}
fn cancelled() -> PlatformError {
    PlatformError::new("importCancelled", "期刊下载已取消。", false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_paths_ignore_unrelated_or_unsafe_files() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../test-vectors/online-catalog-v1.json"))
                .unwrap();
        for vector in vectors["paths"].as_array().unwrap() {
            assert_eq!(
                issue_date(vector["path"].as_str().unwrap()).as_deref(),
                vector["date"].as_str()
            );
        }
        let item = json!({"path":"te_2026.10.03/TheEconomist.2026.10.03.epub","type":"blob","mode":"100644","sha":"a".repeat(40),"size":1024});
        let tree = json!({"truncated":false,"tree":[item.clone()]});
        assert_eq!(parse_tree(&tree).unwrap()[0].date, "2026-10-03");
        assert!(parse_tree(&json!({"truncated":true,"tree":[item.clone()]})).is_err());
        let oversized: Vec<_> = (0..2001).map(|index| {
            let date = (NaiveDate::from_ymd_opt(2020, 1, 1).unwrap() + chrono::Duration::days(index)).format("%Y.%m.%d").to_string();
            json!({"path":format!("te_{date}/TheEconomist.{date}.epub"),"type":"blob","mode":"100644","sha":"a".repeat(40),"size":1024})
        }).collect();
        assert!(parse_tree(&json!({"truncated":false,"tree":oversized})).is_err());
        for (field, value) in [
            ("mode", json!("120000")),
            ("size", json!(MAX_EPUB + 1)),
            ("sha", json!("bad")),
        ] {
            let mut changed = item.clone();
            changed[field] = value;
            assert!(parse_tree(&json!({"truncated":false,"tree":[changed]})).is_err());
        }
    }

    #[test]
    fn recognizes_original_issue_after_user_rename() {
        let publications = vec![crate::mobile_reading::PublicationSummary {
            id: "book".into(),
            title: "我的精读".into(),
            original_title: "The Economist.2026.10.03".into(),
            category_id: None,
            creator: None,
            language: None,
            cover_url: None,
            cover_thumbnail_url: None,
            cover_thumbnail_width: None,
            cover_thumbnail_height: None,
            imported_at: String::new(),
            article_count: 1,
            section_count: 0,
            last_article_id: None,
        }];
        assert_eq!(local_issue(&publications, "2026-10-03").unwrap().id, "book");
        assert!(local_issue(&publications, "2026-09-26").is_none());
    }

    #[tokio::test]
    async fn fresh_cache_survives_new_runtime_without_network() {
        let root = tempfile::tempdir().unwrap();
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().unwrap();
        let catalog = OnlineCatalog {
            revision: "a".repeat(40),
            fetched_at: Utc::now().to_rfc3339(),
            stale: false,
            notice: None,
            issues: vec![OnlineIssue {
                id: "b".repeat(40),
                date: "2026-10-03".into(),
                path: "te_2026.10.03/TheEconomist.2026.10.03.epub".into(),
                bytes: 1024,
            }],
        };
        atomic_replace(
            &paths.cache.join("online-catalog/economist-v1.json"),
            &serde_json::to_vec(&catalog).unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_catalog(&paths, false).await.unwrap().revision,
            catalog.revision
        );
        let mut bad = catalog;
        bad.issues[0].path = "../../escape".into();
        assert!(!valid_catalog(&bad));
    }

    #[tokio::test]
    async fn cancellation_interrupts_waits_and_busy_requests_can_retry() {
        let runtime = CatalogRuntime::default();
        let id = uuid::Uuid::new_v4().to_string();
        let token = runtime.begin(&id).unwrap();
        assert!(runtime.begin(&uuid::Uuid::new_v4().to_string()).is_err());
        runtime.cancel(&id);
        let result = cancellable(&token, std::future::pending::<Result<(), PlatformError>>()).await;
        assert_eq!(result.unwrap_err().code, "importCancelled");
        runtime.finish();
        assert!(runtime.begin(&uuid::Uuid::new_v4().to_string()).is_ok());
    }
}
