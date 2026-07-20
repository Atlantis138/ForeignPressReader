use super::*;

#[tauri::command]
pub fn get_mobile_storage_report(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_maintenance::StorageReport, PlatformError> {
    let package = package_storage_on_platform(&app)?;
    let database = state.database()?;
    mobile_maintenance::storage_report(
        &state.paths,
        &database,
        package.application_bytes,
        package.secret_bytes,
    )
}

#[tauri::command]
pub fn clear_mobile_safe_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_maintenance::CacheClearResult, PlatformError> {
    let package = package_storage_on_platform(&app)?;
    let before = {
        let database = state.database()?;
        mobile_maintenance::storage_report(
            &state.paths,
            &database,
            package.application_bytes,
            package.secret_bytes,
        )?
    };
    mobile_maintenance::clear_safe_caches(&state.paths)?;
    clear_webview_cache_on_platform(&app)?;
    let report = {
        let database = state.database()?;
        mobile_maintenance::storage_report(
            &state.paths,
            &database,
            package.application_bytes,
            package.secret_bytes,
        )?
    };
    Ok(mobile_maintenance::CacheClearResult {
        cleared_bytes: before.total_bytes.saturating_sub(report.total_bytes),
        report,
    })
}

#[cfg(target_os = "android")]
fn clear_webview_cache_on_platform(app: &tauri::AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation().clear_webview_cache().map_err(|_| {
        PlatformError::new(
            "storageClearUnavailable",
            "无法清理 Android WebView 缓存。",
            true,
        )
    })
}

#[cfg(not(target_os = "android"))]
fn clear_webview_cache_on_platform(_app: &tauri::AppHandle) -> Result<(), PlatformError> {
    Ok(())
}

#[tauri::command]
pub fn clear_mobile_ai_text_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    confirmation_token: String,
) -> Result<mobile_maintenance::CacheClearResult, PlatformError> {
    if confirmation_token != "CLEAR_AI_TEXT_CACHE" {
        return Err(PlatformError::new("invalidInput", "清理确认无效。", false));
    }
    let package = package_storage_on_platform(&app)?;
    let before = {
        let database = state.database()?;
        mobile_maintenance::storage_report(
            &state.paths,
            &database,
            package.application_bytes,
            package.secret_bytes,
        )?
    };
    {
        let database = state.database()?;
        mobile_maintenance::clear_ai_text(&database)?;
    }
    let report = {
        let database = state.database()?;
        mobile_maintenance::storage_report(
            &state.paths,
            &database,
            package.application_bytes,
            package.secret_bytes,
        )?
    };
    Ok(mobile_maintenance::CacheClearResult {
        cleared_bytes: before.total_bytes.saturating_sub(report.total_bytes),
        report,
    })
}

#[tauri::command]
pub fn open_mobile_app_storage_settings(app: tauri::AppHandle) -> Result<(), PlatformError> {
    open_storage_settings_on_platform(&app)
}

#[tauri::command]
pub fn share_mobile_diagnostic_bundle(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<(), PlatformError> {
    let path = mobile_maintenance::create_diagnostic_bundle(&state.paths)?;
    mobile_maintenance::share_bundle(&app, &path)
}

#[tauri::command]
pub fn get_mobile_developer_state(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_maintenance::DeveloperState, PlatformError> {
    let logging = state.logger()?.is_enabled();
    let database = state.database()?;
    mobile_maintenance::developer_state(&database, logging, &state.paths)
}

#[tauri::command]
pub fn set_mobile_developer_enabled(
    state: tauri::State<'_, PlatformState>,
    enabled: bool,
) -> Result<mobile_maintenance::DeveloperState, PlatformError> {
    {
        let database = state.database()?;
        mobile_study::set_developer_mode(&database, enabled)?;
        if !enabled {
            mobile_maintenance::write_boolean(&database, "developer.logging-enabled", false)?;
        }
    }
    if !enabled {
        state.logger()?.set_enabled(false);
    }
    get_mobile_developer_state(state)
}

#[tauri::command]
pub fn set_mobile_developer_logging(
    state: tauri::State<'_, PlatformState>,
    enabled: bool,
) -> Result<mobile_maintenance::DeveloperState, PlatformError> {
    {
        let database = state.database()?;
        if enabled && !mobile_study::get_debug_state(&database)?.enabled {
            return Err(PlatformError::new(
                "featureDisabled",
                "请先启用开发模式。",
                false,
            ));
        }
        mobile_maintenance::write_boolean(&database, "developer.logging-enabled", enabled)?;
    }
    state.logger()?.set_enabled(enabled);
    get_mobile_developer_state(state)
}

#[tauri::command]
pub fn clear_mobile_developer_logs(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_maintenance::DeveloperState, PlatformError> {
    state.logger()?.clear()?;
    get_mobile_developer_state(state)
}

#[tauri::command]
pub fn force_mobile_developer_next_study_day(
    state: tauri::State<'_, PlatformState>,
    confirmation_token: String,
) -> Result<(), PlatformError> {
    let database = state.database()?;
    mobile_study::force_next_study_day(&database, &confirmation_token)
}

#[tauri::command]
pub fn reset_mobile_developer_study_progress(
    state: tauri::State<'_, PlatformState>,
    confirmation_token: String,
) -> Result<mobile_maintenance::DeveloperState, PlatformError> {
    {
        let mut database = state.database()?;
        mobile_study::reset_all_progress(&mut database, &confirmation_token)?;
    }
    get_mobile_developer_state(state)
}

#[tauri::command]
pub fn factory_reset_mobile(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    confirmation_text: String,
) -> Result<(), PlatformError> {
    let developer_enabled = {
        let database = state.database()?;
        mobile_study::get_debug_state(&database)?.enabled
    };
    if !developer_enabled {
        return Err(PlatformError::new(
            "featureDisabled",
            "请先启用开发模式。",
            false,
        ));
    }
    if confirmation_text != "恢复出厂设置" {
        return Err(PlatformError::new(
            "invalidInput",
            "恢复出厂确认文字不正确。",
            false,
        ));
    }
    #[cfg(target_os = "android")]
    {
        use fpr_platform_plugin::FoundationExt;
        return app
            .foundation()
            .factory_reset()
            .map_err(|_| PlatformError::new("resetFailed", "恢复出厂无法启动。", false));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(PlatformError::new(
            "unsupportedPlatform",
            "当前平台未启用 Android 恢复出厂。",
            false,
        ))
    }
}
