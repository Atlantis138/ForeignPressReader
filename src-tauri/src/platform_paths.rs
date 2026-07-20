use crate::platform_error::PlatformError;
use std::{fs, path::PathBuf};

#[derive(Debug, Clone)]
pub struct PlatformPaths {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub persistent_staging: PathBuf,
    pub temporary_staging: PathBuf,
}

impl PlatformPaths {
    pub fn new(data: PathBuf, cache: PathBuf, logs: PathBuf) -> Self {
        Self {
            persistent_staging: data.join(".staging"),
            temporary_staging: cache.join("staging"),
            data,
            cache,
            logs,
        }
    }

    pub fn prepare(&self) -> Result<(), PlatformError> {
        for directory in [
            &self.data,
            &self.cache,
            &self.logs,
            &self.persistent_staging,
            &self.temporary_staging,
        ] {
            fs::create_dir_all(directory).map_err(|_| PlatformError::storage_unavailable())?;
        }
        Ok(())
    }

    pub fn database_path(&self) -> PathBuf {
        self.data.join("reader.sqlite")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_separate_persistent_and_disposable_staging() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().expect("prepare");
        assert!(paths.database_path().starts_with(&paths.data));
        assert!(paths.persistent_staging.starts_with(&paths.data));
        assert!(paths.temporary_staging.starts_with(&paths.cache));
        assert!(paths.logs.is_dir());
    }
}
