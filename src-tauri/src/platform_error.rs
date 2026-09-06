use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl PlatformError {
    pub const fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
        }
    }

    pub const fn storage_unavailable() -> Self {
        Self::new("storageUnavailable", "无法访问应用私有存储。", true)
    }

    pub const fn database_corrupt() -> Self {
        Self::new(
            "databaseCorrupt",
            "数据库完整性检查失败。请从备份快照恢复，原文件将保留供后续处理。",
            false,
        )
    }

    pub const fn database_legacy() -> Self {
        Self::new(
            "databaseIncompatible",
            "检测到不兼容的 Demo 或旧版数据库。",
            false,
        )
    }

    pub const fn database_future() -> Self {
        Self::new(
            "databaseTooNew",
            "数据库版本高于当前应用支持的版本。",
            false,
        )
    }

    pub const fn migration_failed() -> Self {
        Self::new("migrationFailed", "数据库迁移失败，已安全回滚。", false)
    }
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for PlatformError {}
