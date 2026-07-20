use crate::{atomic_file::atomic_replace, platform_error::PlatformError};
use chrono::Utc;
use serde_json::{Map, Value};
use std::{fs, path::PathBuf};

const DEFAULT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 5;

pub struct DiagnosticLogger {
    enabled: bool,
    root: PathBuf,
    maximum_file_bytes: u64,
    maximum_files: usize,
}

impl DiagnosticLogger {
    pub fn new(root: PathBuf) -> Self {
        Self::with_limits(root, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES)
    }

    pub fn with_limits(root: PathBuf, maximum_file_bytes: u64, maximum_files: usize) -> Self {
        Self {
            enabled: false,
            root,
            maximum_file_bytes,
            maximum_files,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn log(
        &self,
        level: &str,
        area: &str,
        event: &str,
        details: Value,
    ) -> Result<(), PlatformError> {
        if !self.enabled {
            return Ok(());
        }
        fs::create_dir_all(&self.root).map_err(|_| PlatformError::storage_unavailable())?;
        let path = self.current_file()?;
        let mut existing = fs::read(&path).unwrap_or_default();
        let record = serde_json::json!({
            "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": safe_token(level),
            "area": safe_token(area),
            "event": safe_token(event),
            "details": sanitize(details, 0),
        });
        existing.extend_from_slice(
            serde_json::to_string(&record)
                .map_err(|_| PlatformError::storage_unavailable())?
                .as_bytes(),
        );
        existing.push(b'\n');
        atomic_replace(&path, &existing)?;
        self.prune()
    }

    pub fn clear(&self) -> Result<(), PlatformError> {
        fs::remove_dir_all(&self.root)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|_| PlatformError::storage_unavailable())
    }

    fn current_file(&self) -> Result<PathBuf, PlatformError> {
        let day = Utc::now().format("%Y-%m-%d");
        for index in 0..100 {
            let suffix = if index == 0 {
                String::new()
            } else {
                format!("-{index}")
            };
            let candidate = self.root.join(format!("app-{day}{suffix}.jsonl"));
            let size = fs::metadata(&candidate)
                .map(|value| value.len())
                .unwrap_or(0);
            if size < self.maximum_file_bytes {
                return Ok(candidate);
            }
        }
        Err(PlatformError::storage_unavailable())
    }

    fn prune(&self) -> Result<(), PlatformError> {
        let mut files = fs::read_dir(&self.root)
            .map_err(|_| PlatformError::storage_unavailable())?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("app-"))
            .collect::<Vec<_>>();
        files.sort_by_key(|entry| {
            std::cmp::Reverse(entry.metadata().and_then(|value| value.modified()).ok())
        });
        for entry in files.into_iter().skip(self.maximum_files) {
            let _ = fs::remove_file(entry.path());
        }
        Ok(())
    }
}

fn safe_token(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.-".contains(character) {
                character
            } else {
                '-'
            }
        })
        .take(80)
        .collect()
}

fn sanitize(value: Value, depth: usize) -> Value {
    if depth > 3 {
        return Value::String("[truncated]".into());
    }
    match value {
        Value::String(value) => Value::String(sanitize_string(&value)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(20)
                .map(|value| sanitize(value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut result = Map::new();
            for (key, value) in values.into_iter().take(30) {
                if is_sensitive_key(&key) {
                    result.insert(key, Value::String("[redacted]".into()));
                } else {
                    result.insert(key, sanitize(value, depth + 1));
                }
            }
            Value::Object(result)
        }
        other => other,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "key",
        "secret",
        "token",
        "authorization",
        "header",
        "body",
        "text",
        "audio",
        "content",
        "path",
        "url",
    ]
    .iter()
    .any(|part| key.contains(part))
}

fn sanitize_string(value: &str) -> String {
    let mut result = value.replace('\\', "/");
    if result.contains("Bearer ") || result.contains("sk-") || result.contains("AIza") {
        result = "[redacted]".into();
    } else if result.contains(":/") || result.contains(":\\") {
        result = "[local-path]".into();
    } else if result.starts_with("http://") || result.starts_with("https://") {
        result = "[url]".into();
    }
    result.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_off_redacts_and_rotates() {
        let root = tempfile::tempdir().expect("tempdir");
        let logs = root.path().join("logs");
        let mut logger = DiagnosticLogger::with_limits(logs.clone(), 120, 2);
        logger
            .log(
                "info",
                "test",
                "disabled",
                serde_json::json!({"body":"secret"}),
            )
            .expect("disabled log");
        assert!(!logs.exists());
        logger.set_enabled(true);
        for index in 0..8 {
            logger
                .log(
                    "error",
                    "network",
                    "failed",
                    serde_json::json!({
                        "authorization": format!("Bearer secret-{index}"),
                        "body": "private article",
                        "safeCode": "networkOffline"
                    }),
                )
                .expect("write log");
        }
        let files = fs::read_dir(&logs).expect("logs").collect::<Vec<_>>();
        assert!(files.len() <= 2);
        let content = files
            .into_iter()
            .map(|entry| fs::read_to_string(entry.expect("entry").path()).expect("read"))
            .collect::<String>();
        assert!(!content.contains("private article"));
        assert!(!content.contains("secret-"));
        assert!(content.contains("[redacted]"));
    }
}
