use crate::{
    database::AndroidDatabase, diagnostic_logger::DiagnosticLogger, dictionary_pack,
    dictionary_runtime::DictionaryRuntime, epub_import::EpubImportManager, mobile_maintenance,
    mobile_portable, mobile_reading, mobile_sync_runtime::MobileSyncRuntime,
    platform_error::PlatformError, platform_paths::PlatformPaths,
};
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
};

#[derive(Default)]
pub struct OnlineServiceRuntime {
    translations: Mutex<HashMap<String, String>>,
}

impl OnlineServiceRuntime {
    pub fn begin_translation(&self, article_id: &str) -> Result<(), PlatformError> {
        let mut jobs = self
            .translations
            .lock()
            .map_err(|_| PlatformError::new("internal", "在线服务暂时不可用。", true))?;
        if jobs.contains_key(article_id) {
            return Err(PlatformError::new("serviceBusy", "该文章正在翻译。", false));
        }
        jobs.insert(article_id.to_owned(), String::new());
        Ok(())
    }

    pub fn set_translation_request(
        &self,
        article_id: &str,
        request_id: &str,
    ) -> Result<(), PlatformError> {
        let mut jobs = self
            .translations
            .lock()
            .map_err(|_| PlatformError::new("internal", "在线服务暂时不可用。", true))?;
        if let Some(value) = jobs.get_mut(article_id) {
            *value = request_id.to_owned();
        }
        Ok(())
    }

    pub fn translation_request(&self, article_id: &str) -> Result<Option<String>, PlatformError> {
        let jobs = self
            .translations
            .lock()
            .map_err(|_| PlatformError::new("internal", "在线服务暂时不可用。", true))?;
        Ok(jobs
            .get(article_id)
            .filter(|value| !value.is_empty())
            .cloned())
    }

    pub fn finish_translation(&self, article_id: &str) {
        if let Ok(mut jobs) = self.translations.lock() {
            jobs.remove(article_id);
        }
    }
}

pub struct PlatformState {
    pub paths: PlatformPaths,
    database: Mutex<AndroidDatabase>,
    logger: Mutex<DiagnosticLogger>,
    imports: Mutex<EpubImportManager>,
    portable_request: Mutex<Option<String>>,
    dictionary_runtime: DictionaryRuntime,
    online_runtime: OnlineServiceRuntime,
    sync_runtime: MobileSyncRuntime,
}

impl PlatformState {
    pub fn new(paths: PlatformPaths, app_version: &str) -> Result<Self, PlatformError> {
        let database = AndroidDatabase::open(&paths, app_version)?;
        let source_cleanup = mobile_reading::remove_retained_publication_sources(
            &database,
            &paths.data.join("library"),
        )?;
        mobile_reading::cleanup_orphaned_library(&database, &paths.data.join("library"))?;
        dictionary_pack::prepare(&paths)?;
        mobile_portable::prepare(&paths)?;
        let mut logger = DiagnosticLogger::new(paths.logs.clone());
        let developer_enabled =
            mobile_maintenance::read_boolean(database.connection(), "study.developer-mode")?;
        let logging_requested =
            mobile_maintenance::read_boolean(database.connection(), "developer.logging-enabled")?;
        let logging_enabled = developer_enabled && logging_requested;
        if !developer_enabled && logging_requested {
            mobile_maintenance::write_boolean(&database, "developer.logging-enabled", false)?;
        }
        logger.set_enabled(logging_enabled);
        logger.log(
            "info",
            "library",
            "parsed-only-source-cleanup",
            serde_json::to_value(source_cleanup).unwrap_or(serde_json::Value::Null),
        )?;
        let imports = EpubImportManager::new(&paths)?;
        Ok(Self {
            paths,
            database: Mutex::new(database),
            logger: Mutex::new(logger),
            imports: Mutex::new(imports),
            portable_request: Mutex::new(None),
            dictionary_runtime: DictionaryRuntime::default(),
            online_runtime: OnlineServiceRuntime::default(),
            sync_runtime: MobileSyncRuntime::default(),
        })
    }

    pub fn database(&self) -> Result<MutexGuard<'_, AndroidDatabase>, PlatformError> {
        self.database
            .lock()
            .map_err(|_| PlatformError::new("internal", "平台数据库暂时不可用。", true))
    }

    pub fn logger(&self) -> Result<MutexGuard<'_, DiagnosticLogger>, PlatformError> {
        self.logger
            .lock()
            .map_err(|_| PlatformError::new("internal", "诊断日志暂时不可用。", true))
    }

    pub fn imports(&self) -> Result<MutexGuard<'_, EpubImportManager>, PlatformError> {
        self.imports
            .lock()
            .map_err(|_| PlatformError::new("internal", "EPUB 导入服务暂时不可用。", true))
    }

    pub fn begin_portable_request(&self, request_id: String) -> Result<(), PlatformError> {
        let mut active = self
            .portable_request
            .lock()
            .map_err(|_| PlatformError::new("internal", "数据传输服务暂时不可用。", true))?;
        if active.is_some() {
            return Err(PlatformError::new(
                "dataTransferBusy",
                "已有数据传输任务正在进行。",
                false,
            ));
        }
        *active = Some(request_id);
        Ok(())
    }

    pub fn finish_portable_request(&self, request_id: &str) {
        if let Ok(mut active) = self.portable_request.lock() {
            if active.as_deref() == Some(request_id) {
                *active = None;
            }
        }
    }

    pub fn portable_request(&self) -> Option<String> {
        self.portable_request
            .lock()
            .ok()
            .and_then(|active| active.clone())
    }

    pub fn dictionary_runtime(&self) -> &DictionaryRuntime {
        &self.dictionary_runtime
    }

    pub fn online_runtime(&self) -> &OnlineServiceRuntime {
        &self.online_runtime
    }

    pub fn sync_runtime(&self) -> &MobileSyncRuntime {
        &self.sync_runtime
    }
}
