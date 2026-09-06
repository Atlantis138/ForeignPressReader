use crate::{
    database::AndroidDatabase, platform_error::PlatformError, platform_paths::PlatformPaths,
    platform_state::PlatformState,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{fs, path::Path, sync::Mutex, time::Duration};
use tauri::Manager;

pub struct StartupRecovery {
    pub paths: PlatformPaths,
    pub error: Mutex<Option<PlatformError>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryView {
    message: String,
    snapshots: Vec<String>,
}

pub fn snapshot(connection: &Connection, root: &Path, label: &str) -> Result<(), PlatformError> {
    fs::create_dir_all(root).map_err(|_| PlatformError::storage_unavailable())?;
    let target = root.join(format!(
        "{}-{label}.sqlite",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    let partial = target.with_extension("partial");
    let mut output =
        Connection::open(&partial).map_err(|_| PlatformError::storage_unavailable())?;
    {
        let backup = rusqlite::backup::Backup::new(connection, &mut output)
            .map_err(|_| PlatformError::storage_unavailable())?;
        backup
            .run_to_completion(256, Duration::from_millis(5), None)
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    let check: String = output
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| PlatformError::database_corrupt())?;
    if check != "ok" {
        return Err(PlatformError::database_corrupt());
    }
    drop(output);
    fs::rename(partial, target).map_err(|_| PlatformError::storage_unavailable())?;
    let names = snapshots(root);
    for name in names.into_iter().skip(5) {
        let _ = fs::remove_file(root.join(name));
    }
    Ok(())
}
fn snapshots(root: &Path) -> Vec<String> {
    let mut values = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".sqlite"))
        .collect::<Vec<_>>();
    values.sort_by(|a, b| b.cmp(a));
    values
}

pub fn restore(paths: &PlatformPaths, name: &str, app_version: &str) -> Result<(), PlatformError> {
    let backups = paths.data.join("backups/migrations");
    if !snapshots(&backups).iter().any(|value| value == name) {
        return Err(PlatformError::new(
            "invalidBackup",
            "备份快照不存在。",
            false,
        ));
    }
    let root = paths
        .data
        .join("recovery")
        .join(uuid::Uuid::new_v4().to_string());
    let staged = PlatformPaths::new(
        root.join("validated"),
        root.join("cache"),
        root.join("logs"),
    );
    staged.prepare()?;
    let original = root.join("original");
    fs::create_dir_all(&original).map_err(|_| PlatformError::storage_unavailable())?;
    let source = Connection::open_with_flags(backups.join(name), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| PlatformError::database_corrupt())?;
    let generation: String = source
        .query_row(
            "SELECT value FROM app_metadata WHERE key='schema_generation'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| PlatformError::database_legacy())?;
    if generation != crate::database::SCHEMA_GENERATION {
        return Err(PlatformError::database_legacy());
    }
    {
        let mut output = Connection::open(staged.database_path())
            .map_err(|_| PlatformError::storage_unavailable())?;
        rusqlite::backup::Backup::new(&source, &mut output)
            .map_err(|_| PlatformError::storage_unavailable())?
            .run_to_completion(256, Duration::from_millis(5), None)
            .map_err(|_| PlatformError::storage_unavailable())?;
    }
    drop(source);
    drop(AndroidDatabase::open(&staged, app_version)?);
    let mut moved = Vec::new();
    let result = (|| {
        for suffix in ["", "-wal", "-shm"] {
            let name = format!("reader.sqlite{suffix}");
            let current = paths.data.join(&name);
            if current.exists() {
                fs::rename(current, original.join(&name))
                    .map_err(|_| PlatformError::storage_unavailable())?;
                moved.push(name);
            }
        }
        fs::rename(staged.database_path(), paths.database_path())
            .map_err(|_| PlatformError::storage_unavailable())
    })();
    if result.is_err() {
        for name in moved.into_iter().rev() {
            let _ = fs::rename(original.join(&name), paths.data.join(name));
        }
    }
    result
}

#[tauri::command]
pub fn get_startup_recovery(
    state: tauri::State<'_, StartupRecovery>,
) -> Result<Option<RecoveryView>, PlatformError> {
    let error = state
        .error
        .lock()
        .map_err(|_| PlatformError::storage_unavailable())?;
    Ok(error.as_ref().map(|error| RecoveryView {
        message: error.message.into(),
        snapshots: if error.code == "databaseIncompatible" {
            Vec::new()
        } else {
            snapshots(&state.paths.data.join("backups/migrations"))
        },
    }))
}

#[tauri::command]
pub fn restore_startup_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupRecovery>,
    name: String,
) -> Result<(), PlatformError> {
    let mut error = state
        .error
        .lock()
        .map_err(|_| PlatformError::storage_unavailable())?;
    if error.is_none() || app.try_state::<PlatformState>().is_some() {
        return Err(PlatformError::new(
            "recoveryUnavailable",
            "仅能在启动失败时恢复快照。",
            false,
        ));
    }
    if error
        .as_ref()
        .is_some_and(|e| e.code == "databaseIncompatible")
    {
        return Err(PlatformError::database_legacy());
    }
    restore(&state.paths, &name, &app.package_info().version.to_string())?;
    // An older snapshot may not reference newer publication assets. Preserve those assets.
    fs::write(
        state.paths.data.join("recovery-preserve-assets"),
        b"preserve",
    )
    .map_err(|_| PlatformError::storage_unavailable())?;
    let restored =
        PlatformState::new(state.paths.clone(), &app.package_info().version.to_string())?;
    app.manage(restored);
    *error = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_keeps_originals_and_rejects_invalid_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        paths.prepare().unwrap();
        let db = AndroidDatabase::open(&paths, "test").unwrap();
        let device = db.device_id().to_owned();
        snapshot(
            db.connection(),
            &paths.data.join("backups/migrations"),
            "test",
        )
        .unwrap();
        drop(db);
        fs::write(paths.database_path(), b"damaged original").unwrap();
        let name = snapshots(&paths.data.join("backups/migrations"))[0].clone();
        assert!(restore(&paths, "../reader.sqlite", "test").is_err());
        assert_eq!(
            fs::read(paths.database_path()).unwrap(),
            b"damaged original"
        );
        restore(&paths, &name, "test").unwrap();
        let restored = AndroidDatabase::open(&paths, "test").unwrap();
        assert_eq!(restored.device_id(), device);
        drop(restored);
        let original = fs::read_dir(paths.data.join("recovery"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("original/reader.sqlite");
        assert_eq!(fs::read(original).unwrap(), b"damaged original");
        fs::write(
            paths.data.join("backups/migrations/invalid.sqlite"),
            b"invalid snapshot",
        )
        .unwrap();
        let bytes = fs::read(paths.database_path()).unwrap();
        assert!(restore(&paths, "invalid.sqlite", "test").is_err());
        assert_eq!(fs::read(paths.database_path()).unwrap(), bytes);
    }
}
