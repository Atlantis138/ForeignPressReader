use crate::{mobile_sync_runtime, platform_error::PlatformError, platform_state::PlatformState};

#[tauri::command]
pub async fn open_mobile_sync_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    mobile_sync_runtime::open_page(&app, &state).await
}

#[tauri::command]
pub async fn close_mobile_sync_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<(), PlatformError> {
    mobile_sync_runtime::close_page(&app, &state).await
}

#[tauri::command]
pub fn get_mobile_sync_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    mobile_sync_runtime::get_state(&app, &state)
}

#[tauri::command]
pub fn refresh_mobile_sync_discovery(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    mobile_sync_runtime::refresh_discovery_now(&app, &state)
}

#[tauri::command]
pub async fn start_mobile_sync_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    device_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&device_id)?;
    mobile_sync_runtime::start_pairing(&app, &state, &device_id).await
}

#[tauri::command]
pub fn confirm_mobile_sync_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    session_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&session_id)?;
    mobile_sync_runtime::confirm_pairing(&app, &state, &session_id)
}

#[tauri::command]
pub async fn reject_mobile_sync_pairing(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    session_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&session_id)?;
    mobile_sync_runtime::reject_pairing(&app, &state, &session_id).await
}

#[tauri::command]
pub fn send_mobile_sync_to(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    device_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&device_id)?;
    mobile_sync_runtime::send_to(&app, &state, &device_id)
}

#[tauri::command]
pub fn accept_mobile_sync_incoming(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    transfer_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&transfer_id)?;
    mobile_sync_runtime::accept_incoming(&app, &state, &transfer_id)
}

#[tauri::command]
pub fn reject_mobile_sync_incoming(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    transfer_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&transfer_id)?;
    mobile_sync_runtime::reject_incoming(&app, &state, &transfer_id)
}

#[tauri::command]
pub fn cancel_mobile_sync_operation(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    mobile_sync_runtime::cancel_operation(&app, &state)
}

#[tauri::command]
pub fn discard_mobile_sync_pending_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    transfer_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&transfer_id)?;
    mobile_sync_runtime::discard_pending_transfer(&app, &state, &transfer_id)
}

#[tauri::command]
pub fn revoke_mobile_sync_trust(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    device_id: String,
) -> Result<mobile_sync_runtime::PageState, PlatformError> {
    require_sync_identifier(&device_id)?;
    mobile_sync_runtime::revoke_trust(&app, &state, &device_id)
}

fn require_sync_identifier(value: &str) -> Result<(), PlatformError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(PlatformError::new(
            "invalidInput",
            "同步设备或会话标识无效。",
            false,
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn get_mobile_sync_incoming_changes(
    state: tauri::State<'_, PlatformState>,
    transfer_id: String,
    offset: usize,
    limit: usize,
) -> Result<serde_json::Value, PlatformError> {
    require_sync_identifier(&transfer_id)?;
    mobile_sync_runtime::incoming_changes(&state, &transfer_id, offset, limit)
}
