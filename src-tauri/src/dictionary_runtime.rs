use crate::{
    dictionary_pack::{self, DictionaryResourceStatus},
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct GenerationFingerprint(Vec<(bool, u64, Option<std::time::SystemTime>)>);

#[derive(Clone)]
struct CachedGeneration {
    fingerprint: GenerationFingerprint,
    status: DictionaryResourceStatus,
}

struct ActiveInstall {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct DictionaryRuntime {
    install: Mutex<Option<ActiveInstall>>,
    queries: Mutex<HashMap<String, Arc<AtomicBool>>>,
    generation: Mutex<Option<CachedGeneration>>,
}

impl DictionaryRuntime {
    pub fn begin_install(&self, request_id: &str) -> Result<Arc<AtomicBool>, PlatformError> {
        require_uuid(request_id)?;
        let mut active = self.install.lock().map_err(|_| unavailable())?;
        if active.is_some() {
            return Err(PlatformError::new(
                "learningDatabaseUnavailable",
                "已有词典安装任务正在运行。",
                true,
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveInstall {
            request_id: request_id.into(),
            cancelled: Arc::clone(&cancelled),
        });
        Ok(cancelled)
    }

    pub fn finish_install(&self, request_id: &str) {
        if let Ok(mut active) = self.install.lock() {
            if active
                .as_ref()
                .is_some_and(|install| install.request_id == request_id)
            {
                *active = None;
            }
        }
    }

    pub fn cancel_install(&self, request_id: &str) {
        if let Ok(active) = self.install.lock() {
            if let Some(install) = active
                .as_ref()
                .filter(|install| install.request_id == request_id)
            {
                install.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn install_active(&self) -> bool {
        self.install.lock().is_ok_and(|active| active.is_some())
    }

    pub fn begin_query(&self, request_id: &str) -> Result<Arc<AtomicBool>, PlatformError> {
        require_uuid(request_id)?;
        let mut queries = self.queries.lock().map_err(|_| unavailable())?;
        if queries.contains_key(request_id) {
            return Err(PlatformError::new(
                "invalidInput",
                "词典查询标识重复。",
                false,
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        queries.insert(request_id.into(), Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub fn finish_query(&self, request_id: &str) {
        if let Ok(mut queries) = self.queries.lock() {
            queries.remove(request_id);
        }
    }

    pub fn cancel_query(&self, request_id: &str) {
        if let Ok(queries) = self.queries.lock() {
            if let Some(cancelled) = queries.get(request_id) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn cancel_all_queries(&self) {
        if let Ok(queries) = self.queries.lock() {
            for cancelled in queries.values() {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn fast_status(
        &self,
        paths: &PlatformPaths,
    ) -> Result<DictionaryResourceStatus, PlatformError> {
        let fingerprint = generation_fingerprint(paths);
        let installing = self.install_active();
        let mut cached = self.generation.lock().map_err(|_| unavailable())?;
        if let Some(current) = cached
            .as_ref()
            .filter(|current| current.fingerprint == fingerprint)
        {
            let mut status = current.status.clone();
            status.installing = installing;
            status.base.installing = installing;
            status.full.installing = installing;
            return Ok(status);
        }
        let status = dictionary_pack::fast_resource_status(paths, installing)?;
        *cached = Some(CachedGeneration {
            fingerprint,
            status: status.clone(),
        });
        Ok(status)
    }

    pub fn deep_verify(
        &self,
        paths: &PlatformPaths,
    ) -> Result<DictionaryResourceStatus, PlatformError> {
        let status = dictionary_pack::deep_verify(paths)?;
        self.invalidate_generation();
        Ok(status)
    }

    pub fn invalidate_generation(&self) {
        if let Ok(mut cached) = self.generation.lock() {
            *cached = None;
        }
    }
}

fn generation_fingerprint(paths: &PlatformPaths) -> GenerationFingerprint {
    let dictionary_root = paths.data.join("dictionaries");
    GenerationFingerprint(
        [
            dictionary_root.join("ecdict-base/manifest.json"),
            dictionary_root.join("ecdict-base/ecdict-base.sqlite"),
            dictionary_root.join("ecdict-full/manifest.json"),
            dictionary_root.join("ecdict-full/ecdict-full.sqlite"),
        ]
        .iter()
        .map(|path| file_fingerprint(path))
        .collect(),
    )
}

fn file_fingerprint(path: &Path) -> (bool, u64, Option<std::time::SystemTime>) {
    fs::metadata(path)
        .map(|metadata| (true, metadata.len(), metadata.modified().ok()))
        .unwrap_or((false, 0, None))
}

fn require_uuid(value: &str) -> Result<(), PlatformError> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| PlatformError::new("invalidInput", "请求标识无效。", false))
}

fn unavailable() -> PlatformError {
    PlatformError::new(
        "learningDatabaseUnavailable",
        "词典任务状态暂时不可用。",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_installs_and_cancels_queries() {
        let runtime = DictionaryRuntime::default();
        let install_id = uuid::Uuid::new_v4().to_string();
        let install = runtime.begin_install(&install_id).expect("install");
        assert!(runtime
            .begin_install(&uuid::Uuid::new_v4().to_string())
            .is_err());
        runtime.cancel_install(&install_id);
        assert!(install.load(Ordering::Relaxed));
        runtime.finish_install(&install_id);

        let query_id = uuid::Uuid::new_v4().to_string();
        let query = runtime.begin_query(&query_id).expect("query");
        runtime.cancel_query(&query_id);
        assert!(query.load(Ordering::Relaxed));
        runtime.finish_query(&query_id);
    }
}
