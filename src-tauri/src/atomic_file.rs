use crate::platform_error::PlatformError;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

pub fn atomic_replace(destination: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let parent = destination
        .parent()
        .ok_or_else(PlatformError::storage_unavailable)?;
    fs::create_dir_all(parent).map_err(|_| PlatformError::storage_unavailable())?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(PlatformError::storage_unavailable)?;
    let temporary = parent.join(format!(".{file_name}.{}.partial", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| PlatformError::storage_unavailable())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| PlatformError::storage_unavailable())?;
        drop(file);

        #[cfg(target_os = "windows")]
        if destination.exists() {
            fs::remove_file(destination).map_err(|_| PlatformError::storage_unavailable())?;
        }
        fs::rename(&temporary, destination).map_err(|_| PlatformError::storage_unavailable())?;
        sync_parent(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_parent(parent: &Path) {
    if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_in_place_and_leaves_no_partial_files() {
        let root = tempfile::tempdir().expect("tempdir");
        let destination = root.path().join("state.json");
        atomic_replace(&destination, b"one").expect("first write");
        atomic_replace(&destination, b"two").expect("replacement");
        assert_eq!(fs::read(&destination).expect("read"), b"two");
        assert_eq!(
            fs::read_dir(root.path()).expect("read directory").count(),
            1
        );
    }
}
