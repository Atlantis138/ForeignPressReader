use serde::Serialize;
use std::{fs, path::Path};
use tauri::Emitter;

use crate::{
    mobile_portable, mobile_reading, platform_error::PlatformError, platform_state::PlatformState,
};

struct PlatformSelectedPortable {
    cancelled: bool,
    display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileDataProgress<'a> {
    operation: &'a str,
    stage: &'a str,
    completed_bytes: u64,
    total_bytes: u64,
    message: &'a str,
}

#[tauri::command]
pub fn get_mobile_data_status(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_portable::DataStatus, PlatformError> {
    let database = state.database()?;
    mobile_portable::data_status(&database)
}

#[tauri::command]
pub async fn export_mobile_portable(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<Option<mobile_portable::PortableTransferResult>, PlatformError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    state.begin_portable_request(request_id.clone())?;
    let destination = state
        .paths
        .temporary_staging
        .join(format!("portable-{request_id}.fprbackup"));
    let suggested_name = format!(
        "外刊阅读器-{}.fprbackup",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    emit_mobile_data_progress(&app, "export", "exporting", 0, 0, "正在生成便携备份");
    let result = (|| {
        let mut transfer = {
            let database = state.database()?;
            mobile_portable::export_archive(
                &database,
                &state.paths,
                &destination,
                env!("CARGO_PKG_VERSION"),
            )?
        };
        let selected = save_portable_on_platform(&app, &request_id, &destination, &suggested_name)?;
        if selected.cancelled {
            return Ok(None);
        }
        transfer.file_name = selected.display_name.unwrap_or(suggested_name);
        emit_mobile_data_progress(
            &app,
            "export",
            "completed",
            transfer.bytes,
            transfer.bytes,
            "便携备份已导出",
        );
        Ok(Some(transfer))
    })();
    let _ = fs::remove_file(destination);
    state.finish_portable_request(&request_id);
    result
}

#[tauri::command]
pub async fn select_mobile_portable_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<Option<mobile_portable::InspectResult>, PlatformError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let token = uuid::Uuid::new_v4().to_string();
    let portable_root = state.paths.persistent_staging.join("portable");
    let token_root = portable_root.join(&token);
    fs::create_dir_all(&token_root).map_err(|_| PlatformError::storage_unavailable())?;
    let destination = token_root.join("incoming.fprbackup");
    state.begin_portable_request(request_id.clone())?;
    emit_mobile_data_progress(&app, "import", "validating", 0, 0, "请选择便携备份");
    let result = (|| {
        let selection = select_portable_on_platform(&app, &request_id, &destination)?;
        if selection.cancelled {
            return Ok(None);
        }
        let file_name = selection
            .display_name
            .unwrap_or_else(|| "外刊阅读器.fprbackup".into());
        let inspected = {
            let database = state.database()?;
            mobile_portable::inspect_archive(
                &database,
                &destination,
                &token_root,
                &token,
                &file_name,
            )?
        };
        emit_mobile_data_progress(
            &app,
            "import",
            "validating",
            inspected.preview.total_bytes,
            inspected.preview.total_bytes,
            "便携备份校验完成",
        );
        Ok(Some(inspected))
    })();
    if result.is_err() || matches!(result, Ok(None)) {
        let _ = mobile_portable::discard(&portable_root, &token);
    }
    state.finish_portable_request(&request_id);
    result
}

#[tauri::command]
pub fn confirm_mobile_portable_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    token: String,
) -> Result<mobile_portable::PortableTransferResult, PlatformError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    state.begin_portable_request(request_id.clone())?;
    let portable_root = state.paths.persistent_staging.join("portable");
    let result = (|| {
        let metadata = mobile_portable::staged_metadata(&portable_root, &token)?;
        {
            let database = state.database()?;
            mobile_portable::create_safety_backup(&database, &state.paths)?;
        }
        let mut created = Vec::new();
        for package in &metadata.packages {
            emit_mobile_data_progress(&app, "import", "importing-books", 0, 0, "正在恢复刊物内容");
            let imported = {
                let mut database = state.database()?;
                mobile_portable::restore_staged_package(
                    &mut database,
                    &state.paths,
                    &portable_root.join(&token),
                    package,
                )
            };
            match imported {
                Ok(imported) if !imported.duplicate => {
                    let id = imported.publication.summary.id.clone();
                    created.push(id.clone());
                    let cleared = (|| {
                        let database = state.database()?;
                        mobile_reading::clear_publication_lifecycle_for_restore(&database, &id)
                    })();
                    if let Err(error) = cleared {
                        rollback_portable_books(&state, &created);
                        return Err(error);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    rollback_portable_books(&state, &created);
                    return Err(error);
                }
            }
        }
        emit_mobile_data_progress(&app, "import", "merging-data", 0, 0, "正在合并用户数据");
        let archive = portable_root.join(&token).join("incoming.fprbackup");
        let merge_result = {
            let mut database = state.database()?;
            mobile_portable::merge_archive(&mut database, &archive)
        };
        let merged = match merge_result {
            Ok(merged) => merged,
            Err(error) => {
                rollback_portable_books(&state, &created);
                return Err(error);
            }
        };
        {
            let database = state.database()?;
            let _ = mobile_reading::remove_deleted_publication_roots(
                &database,
                &state.paths.data.join("library"),
            );
        }
        emit_mobile_data_progress(
            &app,
            "import",
            "completed",
            metadata.total_bytes,
            metadata.total_bytes,
            "便携备份导入完成",
        );
        let result = mobile_portable::transfer_result(&metadata, created.len(), merged);
        mobile_portable::discard(&portable_root, &token)?;
        Ok(result)
    })();
    if result.is_err() {
        let _ = mobile_portable::discard(&portable_root, &token);
    }
    state.finish_portable_request(&request_id);
    result
}

#[tauri::command]
pub fn discard_mobile_portable_import(
    state: tauri::State<'_, PlatformState>,
    token: String,
) -> Result<(), PlatformError> {
    let root = state.paths.persistent_staging.join("portable");
    mobile_portable::discard(&root, &token)
}

#[tauri::command]
pub fn cancel_mobile_data_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<(), PlatformError> {
    if let Some(request_id) = state.portable_request() {
        cancel_portable_on_platform(&app, &request_id)?;
        state.finish_portable_request(&request_id);
    }
    Ok(())
}

fn rollback_portable_books(state: &PlatformState, publication_ids: &[String]) {
    for publication_id in publication_ids.iter().rev() {
        if let Ok(mut database) = state.database() {
            let _ = mobile_reading::purge_imported_publication(
                &mut database,
                &state.paths.data.join("library"),
                publication_id,
            );
        }
    }
}

fn emit_mobile_data_progress(
    app: &tauri::AppHandle,
    operation: &str,
    stage: &str,
    completed: u64,
    total: u64,
    message: &str,
) {
    let _ = app.emit(
        "mobile-data-transfer-progress",
        MobileDataProgress {
            operation,
            stage,
            completed_bytes: completed,
            total_bytes: total,
            message,
        },
    );
}

#[cfg(target_os = "android")]
fn select_portable_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
    destination: &Path,
) -> Result<PlatformSelectedPortable, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let selected = app
        .foundation()
        .select_portable_backup(request_id, &destination.to_string_lossy())
        .map_err(|error| map_android_portable_error(error.code()))?;
    Ok(PlatformSelectedPortable {
        cancelled: selected.cancelled,
        display_name: selected.display_name,
    })
}

#[cfg(not(target_os = "android"))]
fn select_portable_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
    _destination: &Path,
) -> Result<PlatformSelectedPortable, PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "便携备份系统选择器仅在 Android 可用。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn save_portable_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
    source: &Path,
    suggested_name: &str,
) -> Result<PlatformSelectedPortable, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let selected = app
        .foundation()
        .save_portable_backup(request_id, &source.to_string_lossy(), suggested_name)
        .map_err(|error| map_android_portable_error(error.code()))?;
    Ok(PlatformSelectedPortable {
        cancelled: selected.cancelled,
        display_name: selected.display_name,
    })
}

#[cfg(not(target_os = "android"))]
fn save_portable_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
    _source: &Path,
    _suggested_name: &str,
) -> Result<PlatformSelectedPortable, PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "便携备份系统保存器仅在 Android 可用。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn cancel_portable_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .cancel_portable_transfer(request_id)
        .map_err(|error| map_android_portable_error(error.code()))
}

#[cfg(not(target_os = "android"))]
fn cancel_portable_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
) -> Result<(), PlatformError> {
    Ok(())
}

#[cfg(target_os = "android")]
fn map_android_portable_error(code: Option<&str>) -> PlatformError {
    match code {
        Some("portableBackupTooLarge") => {
            PlatformError::new("portableBackupTooLarge", "便携备份超过 20 GB 限制。", false)
        }
        Some("portableTransferCancelled") => {
            PlatformError::new("portableTransferCancelled", "便携备份传输已取消。", false)
        }
        Some("portableBackupReadFailed") => {
            PlatformError::new("portableBackupReadFailed", "无法读取所选便携备份。", true)
        }
        Some("portableBackupWriteFailed") => {
            PlatformError::new("portableBackupWriteFailed", "无法写入所选位置。", true)
        }
        _ => PlatformError::new(
            "portableTransferUnavailable",
            "Android 系统文件服务暂时不可用。",
            true,
        ),
    }
}
